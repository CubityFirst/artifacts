import { marked } from "marked";
import type { ArtifactKind } from "./mime.ts";

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1d1b18;--muted:#6b665e;--line:#e6e2db;--card:#fff;--accent:#c2410c;--code:#f3f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece8e1;--muted:#a19a8f;--line:#2e2b27;--card:#1e1c19;--accent:#fb923c;--code:#24221e}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
`;

function page(title: string, css: string, body: string, head = "") {
	// External stylesheets go first so the page's own rules win ties (e.g. highlight.js's `pre code.hljs` padding).
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${head}<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

const PROSE_CSS = `
main{max-width:760px;margin:0 auto;padding:48px 20px 96px}
h1,h2,h3,h4{line-height:1.25;margin:2em 0 .6em;letter-spacing:-.01em}h1{font-size:2.1em;margin-top:0}h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
p,ul,ol,blockquote,table,pre{margin:0 0 1.1em}img,video{max-width:100%;height:auto;border-radius:8px}
code{font:.9em/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--code);padding:.15em .35em;border-radius:5px}
pre{background:var(--code);padding:16px 18px;border-radius:10px;overflow:auto}pre code{background:none;padding:0;font-size:.85em}
blockquote{border-left:3px solid var(--line);padding-left:16px;color:var(--muted)}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 12px;text-align:left}
hr{border:0;border-top:1px solid var(--line);margin:2.5em 0}
`;

const BAR_CSS = `
.bar{position:sticky;top:0;z-index:1;display:flex;gap:6px;align-items:center;padding:8px 12px 8px 16px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);font:13px ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--muted)}
.bar .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar a{font:600 12.5px ui-sans-serif,system-ui,sans-serif;color:var(--fg);text-decoration:none;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card)}
.bar a:hover{border-color:var(--muted)}
`;

/** Thin file bar shared by the text viewers: filename, then Raw and Download. */
function fileBar(path: string, rawHref: string) {
	const raw = escapeHtml(rawHref);
	return `<header class="bar"><span class="name">${escapeHtml(path)}</span><a href="${raw}">Raw</a><a href="${raw}&amp;download=1">Download</a></header>`;
}

export function renderMarkdown(title: string, markdown: string, path: string, rawHref: string): string {
	const html = marked.parse(markdown, { gfm: true, async: false }) as string;
	return page(title, BAR_CSS + PROSE_CSS, `${fileBar(path, rawHref)}<main>${html}</main>`);
}

const HLJS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0";

/** Most cells the CSV table will render; bigger files use the code view. */
const MAX_CELLS = 200_000;

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. Returns null past MAX_CELLS fields, before allocating more. */
function parseCsv(text: string, sep: string): string[][] | null {
	const rows: string[][] = [];
	let cells = 0;
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === "") quoted = true;
		else if (c === sep) {
			if (++cells > MAX_CELLS) return null;
			row.push(field), (field = "");
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			if (++cells > MAX_CELLS) return null;
			row.push(field), rows.push(row), (row = []), (field = "");
		} else field += c;
	}
	if (field || row.length) row.push(field), rows.push(row);
	return rows;
}

/** CSV/TSV as a readable table (first row as header, numbers right-aligned); Raw keeps the exact file.
 * Returns null when the table would be too large to render, so the caller falls back to the code view. */
function renderTable(title: string, path: string, text: string, rawHref: string, sep: string): string | null {
	const parsed = parseCsv(text, sep);
	if (!parsed) return null;
	const [head = [], ...rows] = parsed;
	let width = head.length;
	for (const r of rows) width = Math.max(width, r.length);
	if ((rows.length + 1) * width > MAX_CELLS) return null;
	const cols = Array.from({ length: width }, (_, c) => c);
	const numeric = cols.map((c) => rows.length > 0 && rows.every((r) => !r[c] || /^-?[\d.,]+%?$/.test(r[c]!)));
	const cell = (v: string, c: number, tag: string) => `<${tag}${numeric[c] ? ' class="n"' : ""}>${escapeHtml(v)}</${tag}>`;
	const raw = escapeHtml(rawHref);
	const css = `
header{position:sticky;top:0;left:0;z-index:2;display:flex;gap:6px;align-items:center;padding:8px 12px 8px 16px;border-bottom:1px solid var(--line);background:var(--bg);font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
header .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}header .meta{font:12px ui-sans-serif,system-ui,sans-serif;margin-right:6px}
@media (max-width:600px){header .meta{display:none}}
header a{font:600 12.5px ui-sans-serif,system-ui,sans-serif;color:var(--fg);text-decoration:none;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card)}
table{border-collapse:collapse;font-size:13.5px;min-width:100%}
th,td{padding:7px 14px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{position:sticky;top:45px;background:var(--card);font-weight:600;font-size:12.5px;color:var(--muted)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}tr:hover td{background:var(--code)}`;
	return page(
		title,
		css,
		`<header><span class="name">${escapeHtml(path)}</span><span class="meta">${rows.length} rows · ${width} columns</span><a href="${raw}">Raw</a><a href="${raw}&amp;download=1">Download</a></header>
<div class="wrap"><table><thead><tr>${cols.map((c) => cell(head[c] ?? "", c, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => cell(r[c] ?? "", c, "td")).join("")}</tr>`).join("")}</tbody></table></div>`,
	);
}

export function renderCode(title: string, path: string, text: string, rawHref: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if ((ext === "csv" || ext === "tsv") && text.length < 2_000_000) {
		const table = renderTable(title, path, text, rawHref, ext === "tsv" ? "\t" : ",");
		if (table) return table;
	}
	const css = `
header{position:sticky;top:0;display:flex;gap:6px;align-items:center;padding:8px 12px 8px 16px;border-bottom:1px solid var(--line);background:var(--bg);font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
header .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
header .meta{font:12px ui-sans-serif,system-ui,sans-serif;margin-right:6px}
header a{font:600 12.5px ui-sans-serif,system-ui,sans-serif;color:var(--fg);text-decoration:none;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card)}
header a:hover{border-color:var(--muted)}
pre{margin:0;padding:16px;overflow:auto;font:13px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace;tab-size:4}
pre code.hljs{background:none;padding:0}
@media (max-width:600px){header .meta{display:none}pre{font-size:12px}}
`;
	const head = `<link rel="stylesheet" href="${HLJS}/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="${HLJS}/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<script src="${HLJS}/highlight.min.js" defer onload="hljs.highlightAll()"></script>`;
	return page(
		title,
		css,
		`<header><span class="name">${escapeHtml(path)}</span><span class="meta">${text.split("\n").length} lines</span><a href="${escapeHtml(rawHref)}">Raw</a><a href="${escapeHtml(rawHref)}&amp;download=1">Download</a></header>
<pre><code class="language-${escapeHtml(ext)}">${escapeHtml(text)}</code></pre>`,
		head,
	);
}

/** Viewer page for a media/binary entry file, referencing the raw file by relative URL. */
function humanSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderMedia(
	title: string,
	kind: ArtifactKind,
	path: string,
	contentType: string,
	rawHref: string,
	size = 0,
): string {
	const src = escapeHtml(rawHref);
	const css = `
body{min-height:100vh;display:grid;place-items:center;padding:24px}
img,video{max-width:100%;max-height:calc(100vh - 48px);border-radius:10px;box-shadow:0 1px 2px rgb(0 0 0/.08),0 8px 32px rgb(0 0 0/.12)}
img{background:repeating-conic-gradient(#8881 0 25%,transparent 0 50%) 50%/20px 20px}
.audio{width:min(560px,100%);display:grid;gap:16px;text-align:center}.audio h1{font-size:18px;font-weight:600;margin:0}audio{width:100%}
.file{text-align:center;display:grid;justify-items:center;gap:8px;width:min(420px,100%);padding:32px 28px;border:1px solid var(--line);border-radius:18px;background:var(--card)}
.file .ficon{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:var(--code);color:var(--muted);margin-bottom:4px}
.file h1{font-size:18px;margin:0;overflow-wrap:anywhere}.file p{margin:0;color:var(--muted);font-size:14px}
.file a{display:inline-flex;align-items:center;gap:8px;margin-top:10px;padding:10px 18px;border-radius:10px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600}
`;
	let body: string;
	if (kind === "image") body = `<img src="${src}" alt="${escapeHtml(title)}">`;
	else if (kind === "video") body = `<video src="${src}" controls playsinline preload="metadata"></video>`;
	else if (kind === "audio")
		body = `<div class="audio"><h1>${escapeHtml(title)}</h1><audio src="${src}" controls preload="metadata"></audio></div>`;
	else {
		const ext = path.includes(".") ? path.split(".").pop()!.toUpperCase() : "";
		const type = contentType === "application/octet-stream" ? (ext ? `${ext} file` : "File") : contentType;
		const svg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>`;
		body = `<div class="file"><div class="ficon">${svg}</div><h1>${escapeHtml(path.split("/").pop()!)}</h1><p>${escapeHtml(type)}${size ? ` · ${humanSize(size)}` : ""}</p><p>Browsers can't preview this type of file.</p><a href="${src}&amp;download=1" download>Download${size ? ` (${humanSize(size)})` : ""}</a></div>`;
	}
	return page(title, css, body);
}

const MESSAGE_ICONS: Record<number, string> = {
	410: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
	404: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M10 13l4 4M14 13l-4 4"/>`,
};

export function renderMessage(title: string, message: string, status: number): Response {
	const css = `body{min-height:100vh;display:grid;grid-template-rows:1fr auto;padding:24px;text-align:center}
main{align-self:center;display:grid;justify-items:center;gap:10px;max-width:400px;margin:0 auto}
.icon{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:var(--code);color:var(--muted);margin-bottom:6px}
h1{font-size:21px;margin:0;text-wrap:balance}p{margin:0;color:var(--muted);text-wrap:pretty}
footer{font-size:12.5px;color:var(--muted);padding-top:24px}`;
	const icon = MESSAGE_ICONS[status] ?? MESSAGE_ICONS[404];
	const body = `<main><div class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main><footer>Shared with Artifacts</footer>`;
	return new Response(page(title, css, body), {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
	});
}

const LOCK_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

export function renderPasswordGate(title: string, action: string, error?: string): Response {
	const css = `body{min-height:100vh;display:grid;place-items:center;padding:24px}
form{width:min(380px,100%);display:grid;gap:14px;padding:32px 28px 28px;border:1px solid var(--line);border-radius:18px;background:var(--card);box-shadow:0 1px 2px rgb(0 0 0/.05),0 12px 40px rgb(0 0 0/.08)}
.lock{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
h1{font-size:19px;line-height:1.3;margin:0;text-wrap:balance}p{margin:0;color:var(--muted);font-size:14px}
label{font-size:13px;font-weight:600;margin-bottom:-8px}
input{font:inherit;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input::placeholder{color:var(--muted)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
input[aria-invalid=true]{border-color:var(--err)}
button{font:inherit;font-weight:600;padding:11px 12px;border-radius:10px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
:root{--err:#b91c1c}@media (prefers-color-scheme:dark){:root{--err:#f87171}}
.err{color:var(--err);font-weight:500}`;
	const body = `<form method="post" action="${escapeHtml(action)}">
<div class="lock">${LOCK_SVG}</div>
<h1>${escapeHtml(title)}</h1><p>The owner protected this page with a password.</p>
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus${error ? ' aria-invalid="true" aria-describedby="err"' : ""}>
${error ? `<p class="err" id="err" role="alert">${escapeHtml(error)}</p>` : ""}
<button type="submit">Open</button></form>`;
	return new Response(page(title, css, body), {
		status: error ? 401 : 200,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
	});
}
