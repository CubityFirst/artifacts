import { type ArtifactRow, type ContentToken, type FileRow, blobKey } from "./artifacts.ts";
import { signToken, verifyPassword, verifyToken } from "./crypto.ts";
import { isTextType, kindFor } from "./mime.ts";
import { renderCode, renderMarkdown, renderMedia, renderMessage, renderPasswordGate } from "./render.ts";
import { beginAttempt, recordFailure, recordSuccess } from "./throttle.ts";

/**
 * The content origin. It never sets cookies: access is either a public slug URL
 * (/<slug>/...) or a signed capability URL (/t/<token>/...), which is how owners
 * preview private artifacts and how visitors continue after entering a password.
 */
export async function handleContent(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	if (url.pathname === "/" || url.pathname === "") {
		return renderMessage("Artifacts", "This address hosts shared pages. Open the full link you were sent to view one.", 404);
	}
	if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });

	const segments = url.pathname.split("/");
	// ["", "t", token, ...rest] or ["", slug, ...rest]
	if (segments[1] === "t" && segments[2]) {
		const base = `/t/${segments[2]}/`;
		if (segments.length === 3) return Response.redirect(`${url.origin}${base}${url.search}`, 301);
		const token = await verifyToken<ContentToken>(env.SESSION_SECRET, segments[2]);
		// Capability links are short-lived by design (2h previews, 12h after a password). Say so, and point back to the
		// durable share link instead of blaming the owner.
		if (!token || token.e < Date.now()) {
			return renderMessage(
				"This link has timed out",
				"Pages opened this way only stay open for a while. Open the share link again, or reopen the preview from your dashboard.",
				410,
			);
		}
		const art = await env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`).bind(token.a).first<ArtifactRow>();
		if (!art || art.share_epoch !== token.s) return renderMessage("Link expired", "Ask the owner for a new link.", 410);
		return serveFile(request, env, art, token.v || art.current_version, rest(segments, 3), { privateCache: true });
	}

	const slug = segments[1];
	if (!/^[0-9A-Za-z]{6,32}$/.test(slug)) {
		return renderMessage("Nothing here", "This link may be mistyped, or the owner stopped sharing it.", 404);
	}
	if (segments.length === 2) return Response.redirect(`${url.origin}/${slug}/${url.search}`, 301);
	const art = await env.DB.prepare(`SELECT * FROM artifacts WHERE slug = ?`).bind(slug).first<ArtifactRow>();
	if (!art || art.visibility === "private") {
		return renderMessage("Nothing here", "This link may be mistyped, or the owner stopped sharing it.", 404);
	}
	if (art.expires_at !== null && art.expires_at <= Date.now()) {
		return renderMessage("This link has expired", "The owner set it to stop working. Ask them for a new link if you still need it.", 410);
	}
	if (art.visibility === "password") {
		const action = `/${slug}/`;
		if (request.method === "POST") {
			const form = await request.formData().catch(() => null);
			const password = form?.get("password");
			if (typeof password !== "string" || !art.password_hash) {
				return renderPasswordGate(art.title, action, "That password isn't right.");
			}
			// Throttle before hashing: a blocked guess costs one D1 query, not a PBKDF2 run.
			const attempt = await beginAttempt(env, art.id, request.headers.get("cf-connecting-ip") ?? "unknown");
			if (!attempt.allowed) {
				const seconds = Math.ceil(attempt.retryAfterMs / 1000);
				const minutes = Math.ceil(seconds / 60);
				return renderPasswordGate(
					art.title,
					action,
					`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
					{ status: 429, headers: { "retry-after": String(seconds) } },
				);
			}
			if (!(await verifyPassword(password, art.password_hash))) {
				await recordFailure(env, attempt);
				return renderPasswordGate(art.title, action, "That password isn't right.");
			}
			await recordSuccess(env, attempt);
			const token = await signToken(env.SESSION_SECRET, {
				a: art.id,
				v: 0,
				s: art.share_epoch,
				e: Math.min(Date.now() + 12 * 60 * 60 * 1000, art.expires_at ?? Number.POSITIVE_INFINITY),
			} satisfies ContentToken);
			return Response.redirect(`${url.origin}/t/${token}/`, 303);
		}
		return renderPasswordGate(art.title, action);
	}
	if (request.method === "POST") return new Response("Method not allowed", { status: 405 });
	return serveFile(request, env, art, art.current_version, rest(segments, 2), { privateCache: false });
}

function rest(segments: string[], from: number): string {
	return segments
		.slice(from)
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		})
		.join("/");
}

const COMMON_HEADERS = {
	"x-content-type-options": "nosniff",
	"x-robots-tag": "noindex, nofollow",
	// Capability URLs must not leak to third parties through the Referer header.
	"referrer-policy": "no-referrer",
};

async function serveFile(
	request: Request,
	env: Env,
	art: ArtifactRow,
	version: number,
	path: string,
	opts: { privateCache: boolean },
): Promise<Response> {
	const url = new URL(request.url);
	const isEntry = path === "";
	let entry = art.entry;
	if (isEntry && version !== art.current_version) {
		// Each version keeps its own entry; an old version may open a file the current one no longer has.
		const row = await env.DB.prepare(`SELECT entry FROM artifact_versions WHERE artifact_id = ? AND version = ?`)
			.bind(art.id, version)
			.first<{ entry: string }>();
		if (!row) return renderMessage("Not found", "This version of the artifact doesn't exist.", 404);
		entry = row.entry;
	}
	const wanted = isEntry ? entry : path;
	let file = await findFile(env, art.id, version, wanted);
	if (!file && (path === "" || path.endsWith("/") || !path.split("/").pop()!.includes("."))) {
		file = await findFile(env, art.id, version, `${path.replace(/\/$/, "")}/index.html`.replace(/^\//, ""));
	}
	if (!file) return renderMessage("Not found", `No file "${wanted}" in this artifact.`, 404);
	// An HTML entry inside a folder must load from its own URL so its relative links resolve.
	if (isEntry && file.path.includes("/") && kindFor(file.path, file.content_type) === "html") {
		return Response.redirect(new URL(file.path.split("/").map(encodeURIComponent).join("/") + url.search, url).href, 302);
	}
	// Relative URL of the raw bytes, from wherever this response is being served.
	const rawHref = `${(isEntry ? file.path : file.path.split("/").pop()!).split("/").map(encodeURIComponent).join("/")}?raw=1`;

	const raw = url.searchParams.has("raw");
	const download = url.searchParams.has("download");
	const dest = request.headers.get("sec-fetch-dest");
	const navigating = dest === "document" || dest === "iframe" || (dest === null && isEntry);
	const kind = kindFor(file.path, file.content_type);
	const cacheControl = opts.privateCache ? "private, no-cache" : "public, no-cache";

	// Viewer pages for anything a browser wouldn't present nicely on its own.
	if (!raw && !download && navigating) {
		const viewer =
			kind === "markdown" || kind === "code" || kind === "text" || kind === "data"
				? "text"
				: isEntry && (kind === "image" || kind === "video" || kind === "audio" || kind === "file")
					? "media"
					: null;
		if (viewer) {
			let html: string;
			if (viewer === "media") {
				html = renderMedia(art.title, kind, file.path, file.content_type, rawHref, file.size);
			} else {
				const obj = await env.FILES.get(blobKey(art.id, file.sha256));
				if (!obj) return renderMessage("Missing", "This file's contents are missing.", 404);
				const text = await obj.text();
				html =
					kind === "markdown"
						? renderMarkdown(art.title, text, file.path, rawHref)
						: renderCode(art.title, file.path, text, rawHref);
			}
			return new Response(request.method === "HEAD" ? null : html, {
				headers: { ...COMMON_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
			});
		}
	}

	const etag = `"${file.sha256}"`;
	const headers = new Headers({
		...COMMON_HEADERS,
		"content-type": file.content_type,
		"cache-control": cacheControl,
		etag,
		"accept-ranges": "bytes",
	});
	if (download) {
		const name = file.path.split("/").pop()!;
		headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
	}
	if (isTextType(file.content_type) || file.content_type.startsWith("font/")) {
		headers.set("access-control-allow-origin", "*");
	}
	if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

	const range = request.headers.get("range");
	const obj = await env.FILES.get(blobKey(art.id, file.sha256), range ? { range: request.headers } : undefined);
	if (!obj) return renderMessage("Missing", "This file's contents are missing.", 404);
	if (range && obj.range && "offset" in obj.range) {
		const offset = obj.range.offset ?? 0;
		const length = obj.range.length ?? file.size - offset;
		headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${file.size}`);
		headers.set("content-length", String(length));
		return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
	}
	headers.set("content-length", String(file.size));
	return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}

async function findFile(env: Env, artifactId: string, version: number, path: string): Promise<FileRow | null> {
	return env.DB.prepare(`SELECT * FROM artifact_files WHERE artifact_id = ? AND version = ? AND path = ?`)
		.bind(artifactId, version, path)
		.first<FileRow>();
}
