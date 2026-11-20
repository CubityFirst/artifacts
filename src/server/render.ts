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
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}${css}</style>${head}</head><body>${body}</body></html>`;
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

export function renderMarkdown(title: string, markdown: string): string {
	const html = marked.parse(markdown, { gfm: true, async: false }) as string;
	return page(title, PROSE_CSS, `<main>${html}</main>`);
}

const HLJS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0";

export function renderCode(title: string, path: string, text: string, rawHref: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const css = `
header{position:sticky;top:0;display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--bg);font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
header a{margin-left:auto}
pre{margin:0;padding:16px;overflow:auto;font:13px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace;tab-size:4}
pre code.hljs{background:none;padding:0}
`;
	const head = `<link rel="stylesheet" href="${HLJS}/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="${HLJS}/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<script src="${HLJS}/highlight.min.js" defer onload="hljs.highlightAll()"></script>`;
	return page(
		title,
		css,
		`<header><span>${escapeHtml(path)}</span><a href="${escapeHtml(rawHref)}">Raw</a></header>
<pre><code class="language-${escapeHtml(ext)}">${escapeHtml(text)}</code></pre>`,
		head,
	);
}

/** Viewer page for a media/binary entry file, referencing the raw file by relative URL. */
export function renderMedia(title: string, kind: ArtifactKind, path: string, contentType: string, rawHref: string): string {
	const src = escapeHtml(rawHref);
	const css = `
body{min-height:100vh;display:grid;place-items:center;padding:24px}
img,video{max-width:100%;max-height:calc(100vh - 48px);border-radius:10px;box-shadow:0 1px 2px rgb(0 0 0/.08),0 8px 32px rgb(0 0 0/.12)}
img{background:repeating-conic-gradient(#8881 0 25%,transparent 0 50%) 50%/20px 20px}
.audio{width:min(560px,100%);display:grid;gap:16px;text-align:center}.audio h1{font-size:18px;font-weight:600;margin:0}audio{width:100%}
.file{text-align:center;display:grid;gap:10px}.file h1{font-size:18px;margin:0}.file p{margin:0;color:var(--muted)}
.file a{display:inline-block;margin-top:8px;padding:10px 18px;border-radius:999px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600}
`;
	let body: string;
	if (kind === "image") body = `<img src="${src}" alt="${escapeHtml(title)}">`;
	else if (kind === "video") body = `<video src="${src}" controls playsinline preload="metadata"></video>`;
	else if (kind === "audio")
		body = `<div class="audio"><h1>${escapeHtml(title)}</h1><audio src="${src}" controls preload="metadata"></audio></div>`;
	else
		body = `<div class="file"><h1>${escapeHtml(path)}</h1><p>${escapeHtml(contentType)}</p><a href="${src}&amp;download=1">Download</a></div>`;
	return page(title, css, body);
}

export function renderMessage(title: string, message: string, status: number): Response {
	const css = `body{min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center}
h1{font-size:20px;margin:0 0 6px}p{margin:0;color:var(--muted)}`;
	return new Response(page(title, css, `<div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`), {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
	});
}

export function renderPasswordGate(title: string, action: string, error?: string): Response {
	const css = `body{min-height:100vh;display:grid;place-items:center;padding:24px}
form{width:min(360px,100%);display:grid;gap:12px;padding:28px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
h1{font-size:18px;margin:0}p{margin:0;color:var(--muted);font-size:14px}
input{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:600;padding:10px 12px;border-radius:10px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
.err{color:#dc2626}`;
	const body = `<form method="post" action="${escapeHtml(action)}">
<h1>${escapeHtml(title)}</h1><p>This artifact is password protected.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus aria-label="Password">
<button type="submit">View artifact</button></form>`;
	return new Response(page(title, css, body), {
		status: error ? 401 : 200,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
	});
}
