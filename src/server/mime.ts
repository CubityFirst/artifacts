export type ArtifactKind =
	| "html"
	| "markdown"
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "code"
	| "text"
	| "data"
	| "file";

const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	cjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	webmanifest: "application/manifest+json; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	tsv: "text/tab-separated-values; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	bmp: "image/bmp",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/mp4",
	ogv: "video/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	aac: "audio/aac",
	opus: "audio/opus",
	pdf: "application/pdf",
	wasm: "application/wasm",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	glb: "model/gltf-binary",
	gltf: "model/gltf+json",
	zip: "application/zip",
};

const CODE_EXTENSIONS = new Set([
	"ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs",
	"php", "sh", "bash", "zsh", "ps1", "sql", "yaml", "yml", "toml", "ini", "lua", "r", "scala", "dart",
	"vue", "svelte", "graphql", "proto", "dockerfile", "makefile", "diff", "patch",
]);

export function extname(path: string): string {
	const base = path.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

export function contentTypeFor(path: string): string {
	const ext = extname(path);
	if (TYPES[ext]) return TYPES[ext];
	if (CODE_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

export function isTextType(contentType: string): boolean {
	const ct = contentType.split(";")[0].trim();
	return (
		ct.startsWith("text/") ||
		ct === "application/json" ||
		ct === "application/xml" ||
		ct === "image/svg+xml" ||
		ct === "application/manifest+json" ||
		ct === "model/gltf+json" ||
		ct.endsWith("+json") ||
		ct.endsWith("+xml") ||
		ct === "text/javascript"
	);
}

export function kindFor(path: string, contentType: string): ArtifactKind {
	const ct = contentType.split(";")[0].trim();
	const ext = extname(path);
	if (ct === "text/html") return "html";
	if (ct === "text/markdown") return "markdown";
	if (ct.startsWith("image/")) return "image";
	if (ct.startsWith("video/")) return "video";
	if (ct.startsWith("audio/")) return "audio";
	if (ct === "application/pdf") return "pdf";
	if (ct === "application/json" || ct === "text/csv" || ct === "text/tab-separated-values" || ct === "application/xml")
		return "data";
	if (CODE_EXTENSIONS.has(ext) || ct === "text/javascript" || ct === "text/css") return "code";
	if (ct.startsWith("text/")) return "text";
	return "file";
}

/** Picks the file a bare artifact URL should show. */
export function defaultEntry(paths: string[]): string {
	const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
	for (const candidate of ["index.html", "index.htm", "readme.md", "index.md"]) {
		const hit = lower.get(candidate);
		if (hit) return hit;
	}
	const rootHtml = paths.find((p) => !p.includes("/") && /\.html?$/i.test(p));
	if (rootHtml) return rootHtml;
	return [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
}

/** Normalises a user-supplied relative path, rejecting traversal and oddities. */
export function normalizePath(input: string): string {
	const parts: string[] = [];
	for (const seg of input.replace(/\\/g, "/").split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new Error(`Invalid path "${input}": ".." is not allowed`);
		if (/[\u0000-\u001f]/.test(seg)) throw new Error(`Invalid path "${input}"`);
		parts.push(seg);
	}
	if (parts.length === 0) throw new Error(`Invalid path "${input}"`);
	const path = parts.join("/");
	if (path.length > 512) throw new Error(`Path too long: "${input.slice(0, 40)}…"`);
	return path;
}
