import { hashPassword, randomId, sha256Hex, signToken } from "./crypto.ts";
import {
	type ArtifactKind,
	contentTypeFor,
	defaultEntry,
	isTextType,
	kindFor,
	normalizePath as normalizePathUnsafe,
} from "./mime.ts";
import { resetPasswordAttempts } from "./throttle.ts";

export const LIMITS = {
	maxFileBytes: 50 * 1024 * 1024,
	maxArtifactBytes: 200 * 1024 * 1024,
	maxFiles: 2000,
	maxTitle: 200,
	maxDescription: 2000,
};

export type Visibility = "private" | "link" | "password";

export interface ArtifactRow {
	id: string;
	user_id: string;
	slug: string;
	title: string;
	description: string;
	kind: ArtifactKind;
	entry: string;
	visibility: Visibility;
	password_hash: string | null;
	share_epoch: number;
	expires_at: number | null;
	current_version: number;
	size_bytes: number;
	file_count: number;
	source: string;
	model: string;
	created_at: number;
	updated_at: number;
}

export interface FileRow {
	artifact_id: string;
	version: number;
	path: string;
	content_type: string;
	size: number;
	sha256: string;
}

export interface VersionRow {
	artifact_id: string;
	version: number;
	entry: string;
	kind: ArtifactKind;
	message: string;
	source: string;
	model: string;
	size_bytes: number;
	file_count: number;
	created_at: number;
}

export interface FileInput {
	path: string;
	/** UTF-8 text, or base64 when encoding is "base64". */
	content?: string;
	encoding?: "utf8" | "base64";
	/** Fetch the bytes from this http(s) URL instead of sending them inline. */
	url?: string;
	/** Raw bytes, e.g. from a multipart upload. */
	bytes?: Uint8Array<ArrayBuffer>;
	content_type?: string;
}

export class ArtifactError extends Error {
	constructor(
		message: string,
		public status: 400 | 403 | 404 | 409 | 413 = 400,
	) {
		super(message);
	}
}

/** Path validation errors are the caller's fault, so surface them as 400s. */
function normalizePath(input: string): string {
	try {
		return normalizePathUnsafe(input);
	} catch (err) {
		throw new ArtifactError(err instanceof Error ? err.message : String(err));
	}
}

export function blobKey(artifactId: string, sha256: string) {
	return `a/${artifactId}/${sha256}`;
}

// ---------------------------------------------------------------------------
// Reading

export async function getOwnedArtifact(env: Env, userId: string, id: string): Promise<ArtifactRow> {
	const row = await env.DB.prepare(`SELECT * FROM artifacts WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.first<ArtifactRow>();
	if (!row) throw new ArtifactError(`Artifact ${id} not found`, 404);
	return row;
}

export async function listFiles(env: Env, artifactId: string, version: number): Promise<FileRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM artifact_files WHERE artifact_id = ? AND version = ? ORDER BY path`,
	)
		.bind(artifactId, version)
		.all<FileRow>();
	return results;
}

export async function listVersions(env: Env, artifactId: string): Promise<VersionRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`,
	)
		.bind(artifactId)
		.all<VersionRow>();
	return results;
}

export interface ListQuery {
	q?: string;
	kind?: string;
	visibility?: string;
	sort?: "updated" | "created" | "title" | "size";
	limit?: number;
	offset?: number;
}

export async function listArtifacts(env: Env, userId: string, query: ListQuery) {
	const where = ["user_id = ?"];
	const params: unknown[] = [userId];
	if (query.q?.trim()) {
		where.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR entry LIKE ? ESCAPE '\\')`);
		const like = `%${query.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
		params.push(like, like, like);
	}
	if (query.kind) {
		where.push("kind = ?");
		params.push(query.kind);
	}
	if (query.visibility) {
		where.push("visibility = ?");
		params.push(query.visibility);
	}
	const order = {
		updated: "updated_at DESC",
		created: "created_at DESC",
		title: "title COLLATE NOCASE ASC",
		size: "size_bytes DESC",
	}[query.sort ?? "updated"];
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
	const offset = Math.max(query.offset ?? 0, 0);
	const sqlWhere = where.join(" AND ");
	const [rows, total] = await Promise.all([
		env.DB.prepare(`SELECT * FROM artifacts WHERE ${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`)
			.bind(...params, limit, offset)
			.all<ArtifactRow>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE ${sqlWhere}`)
			.bind(...params)
			.first<{ n: number }>(),
	]);
	return { items: rows.results, total: total?.n ?? 0, limit, offset };
}

// ---------------------------------------------------------------------------
// Writing

interface StoredFile {
	path: string;
	content_type: string;
	size: number;
	sha256: string;
}

async function loadBytes(input: FileInput): Promise<Uint8Array<ArrayBuffer>> {
	if (input.bytes !== undefined) return input.bytes;
	if (input.url !== undefined) {
		let url: URL;
		try {
			url = new URL(input.url);
		} catch {
			throw new ArtifactError(`${input.path}: invalid url`);
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new ArtifactError(`${input.path}: only http(s) URLs can be fetched`);
		}
		const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
		if (!res.ok || !res.body) throw new ArtifactError(`${input.path}: fetching ${url.host} returned HTTP ${res.status}`);
		const declared = Number(res.headers.get("content-length") ?? 0);
		if (declared > LIMITS.maxFileBytes) throw new ArtifactError(`${input.path}: file exceeds ${mb(LIMITS.maxFileBytes)}`, 413);
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of res.body) {
			total += chunk.byteLength;
			if (total > LIMITS.maxFileBytes) throw new ArtifactError(`${input.path}: file exceeds ${mb(LIMITS.maxFileBytes)}`, 413);
			chunks.push(chunk);
		}
		const out = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.byteLength;
		}
		if (!input.content_type) {
			const ct = res.headers.get("content-type");
			if (ct && contentTypeFor(input.path) === "application/octet-stream") input.content_type = ct;
		}
		return out;
	}
	if (input.content === undefined) throw new ArtifactError(`${input.path}: provide content or url`);
	if (input.encoding === "base64") {
		try {
			const bin = atob(input.content.replace(/\s+/g, ""));
			return Uint8Array.from(bin, (c) => c.charCodeAt(0));
		} catch {
			throw new ArtifactError(`${input.path}: content is not valid base64`);
		}
	}
	return new TextEncoder().encode(input.content) as Uint8Array<ArrayBuffer>;
}

async function storeFiles(env: Env, artifactId: string, inputs: FileInput[]): Promise<StoredFile[]> {
	const seen = new Set<string>();
	const out: StoredFile[] = [];
	for (const input of inputs) {
		const path = normalizePath(input.path);
		if (seen.has(path)) throw new ArtifactError(`Duplicate path "${path}"`);
		seen.add(path);
		const bytes = await loadBytes({ ...input, path });
		if (bytes.byteLength > LIMITS.maxFileBytes) throw new ArtifactError(`${path}: file exceeds ${mb(LIMITS.maxFileBytes)}`, 413);
		const sha256 = await sha256Hex(bytes);
		const content_type = input.content_type?.trim() || contentTypeFor(path);
		await env.FILES.put(blobKey(artifactId, sha256), bytes, { httpMetadata: { contentType: content_type } });
		out.push({ path, content_type, size: bytes.byteLength, sha256 });
	}
	return out;
}

function checkTotals(files: StoredFile[]) {
	if (files.length === 0) throw new ArtifactError("An artifact needs at least one file");
	if (files.length > LIMITS.maxFiles) throw new ArtifactError(`Too many files (max ${LIMITS.maxFiles})`, 413);
	const size = files.reduce((n, f) => n + f.size, 0);
	if (size > LIMITS.maxArtifactBytes) throw new ArtifactError(`Artifact exceeds ${mb(LIMITS.maxArtifactBytes)}`, 413);
	return size;
}

function resolveEntry(files: StoredFile[], requested?: string, previous?: string): StoredFile {
	const byPath = new Map(files.map((f) => [f.path, f]));
	if (requested) {
		const p = normalizePath(requested);
		const hit = byPath.get(p);
		if (!hit) throw new ArtifactError(`Entry "${p}" is not one of the artifact's files`);
		return hit;
	}
	if (previous && byPath.has(previous)) return byPath.get(previous)!;
	return byPath.get(defaultEntry([...byPath.keys()]))!;
}

function cleanTitle(title: string | undefined, fallback: string) {
	const t = (title ?? "").trim().slice(0, LIMITS.maxTitle);
	return t || fallback;
}

async function writeVersion(
	env: Env,
	artifactId: string,
	version: number,
	files: StoredFile[],
	meta: { entry: string; kind: ArtifactKind; message: string; source: string; model: string; size: number; now: number },
	around: { before?: D1PreparedStatement[]; after?: D1PreparedStatement[] },
) {
	// D1 runs a batch as one transaction, so the version is all-or-nothing.
	const statements = [
		...(around.before ?? []),
		env.DB.prepare(
			`INSERT INTO artifact_versions (artifact_id, version, entry, kind, message, source, model, size_bytes, file_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(artifactId, version, meta.entry, meta.kind, meta.message, meta.source, meta.model, meta.size, files.length, meta.now),
		...files.map((f) =>
			env.DB.prepare(
				`INSERT INTO artifact_files (artifact_id, version, path, content_type, size, sha256) VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(artifactId, version, f.path, f.content_type, f.size, f.sha256),
		),
		...(around.after ?? []),
	];
	try {
		await env.DB.batch(statements);
	} catch (err) {
		if (String(err).includes("UNIQUE") || String(err).includes("PRIMARY KEY")) {
			throw new ArtifactError("The artifact was changed concurrently; fetch it again and retry", 409);
		}
		throw err;
	}
}

export interface CreateInput {
	title?: string;
	description?: string;
	files: FileInput[];
	entry?: string;
	visibility?: Visibility;
	password?: string;
	message?: string;
	source?: string;
	model?: string;
}

export async function createArtifact(env: Env, userId: string, input: CreateInput): Promise<ArtifactRow> {
	const id = randomId(12);
	const files = await storeFiles(env, id, input.files);
	const size = checkTotals(files);
	const entry = resolveEntry(files, input.entry);
	const kind = kindFor(entry.path, entry.content_type);
	const visibility = input.visibility ?? "private";
	if (visibility === "password" && !input.password) throw new ArtifactError("A password is required for password visibility");
	const passwordHash = visibility === "password" ? await hashPassword(input.password!) : null;
	const now = Date.now();
	const source = (input.source ?? "").slice(0, 100);
	const model = (input.model ?? "").slice(0, 100);
	const title = cleanTitle(input.title, entry.path);
	const description = (input.description ?? "").slice(0, LIMITS.maxDescription);

	const insert = env.DB.prepare(
		`INSERT INTO artifacts (id, user_id, slug, title, description, kind, entry, visibility, password_hash, current_version,
		   size_bytes, file_count, source, model, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, randomId(12), title, description, kind, entry.path, visibility, passwordHash, size, files.length, source, model, now, now);
	try {
		// The artifact row goes first in the same transaction so the versions' foreign keys resolve.
		await writeVersion(
			env,
			id,
			1,
			files,
			{ entry: entry.path, kind, message: input.message ?? "Created", source, model, size, now },
			{ before: [insert] },
		);
	} catch (err) {
		await deletePrefix(env, `a/${id}/`);
		throw err;
	}
	return (await env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`).bind(id).first<ArtifactRow>())!;
}

export interface UpdateInput {
	files?: FileInput[];
	delete_paths?: string[];
	replace_all?: boolean;
	title?: string;
	description?: string;
	entry?: string;
	message?: string;
	source?: string;
	model?: string;
}

/** Creates a new version from the current one plus the given changes. */
export async function updateArtifact(env: Env, userId: string, id: string, input: UpdateInput): Promise<ArtifactRow> {
	const art = await getOwnedArtifact(env, userId, id);
	const changesFiles = (input.files?.length ?? 0) > 0 || (input.delete_paths?.length ?? 0) > 0 || input.replace_all;
	const changesEntry = input.entry !== undefined && normalizePath(input.entry) !== art.entry;

	if (!changesFiles && !changesEntry) {
		// Metadata-only update: no new version.
		await env.DB.prepare(`UPDATE artifacts SET title = ?, description = ?, updated_at = ? WHERE id = ?`)
			.bind(
				input.title !== undefined ? cleanTitle(input.title, art.title) : art.title,
				input.description !== undefined ? input.description.slice(0, LIMITS.maxDescription) : art.description,
				Date.now(),
				id,
			)
			.run();
		return getOwnedArtifact(env, userId, id);
	}

	const stored = await storeFiles(env, id, input.files ?? []);
	const merged = new Map<string, StoredFile>();
	if (!input.replace_all) {
		for (const f of await listFiles(env, id, art.current_version)) merged.set(f.path, f);
	}
	for (const p of input.delete_paths ?? []) {
		const path = normalizePath(p);
		if (!merged.delete(path) && !input.replace_all) throw new ArtifactError(`Cannot delete "${path}": no such file`);
	}
	for (const f of stored) merged.set(f.path, f);
	const files = [...merged.values()];
	return commitVersion(env, art, files, input);
}

async function commitVersion(
	env: Env,
	art: ArtifactRow,
	files: StoredFile[],
	input: { entry?: string; title?: string; description?: string; message?: string; source?: string; model?: string },
): Promise<ArtifactRow> {
	const size = checkTotals(files);
	const entry = resolveEntry(files, input.entry, art.entry);
	const kind = kindFor(entry.path, entry.content_type);
	const now = Date.now();
	const version = art.current_version + 1;
	const source = (input.source ?? art.source).slice(0, 100);
	const model = (input.model ?? "").slice(0, 100) || art.model;
	const title = input.title !== undefined ? cleanTitle(input.title, art.title) : art.title;
	const description = input.description !== undefined ? input.description.slice(0, LIMITS.maxDescription) : art.description;
	await writeVersion(
		env,
		art.id,
		version,
		files,
		{ entry: entry.path, kind, message: (input.message ?? "").slice(0, 500), source, model, size, now },
		{
			after: [
				env.DB.prepare(
			`UPDATE artifacts SET current_version = ?, entry = ?, kind = ?, size_bytes = ?, file_count = ?, title = ?,
			   description = ?, source = ?, model = ?, updated_at = ?
			 WHERE id = ? AND current_version = ?`,
		).bind(version, entry.path, kind, size, files.length, title, description, source, model, now, art.id, art.current_version),
			],
		},
	);
	return (await env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`).bind(art.id).first<ArtifactRow>())!;
}

export interface TextEdit {
	old_str: string;
	new_str: string;
}

/** Exact find-and-replace edits on one text file, producing a new version. */
export async function editArtifactFile(
	env: Env,
	userId: string,
	id: string,
	path: string,
	edits: TextEdit[],
	meta: { message?: string; source?: string; model?: string },
): Promise<ArtifactRow> {
	const art = await getOwnedArtifact(env, userId, id);
	const target = normalizePath(path);
	const files = await listFiles(env, id, art.current_version);
	const file = files.find((f) => f.path === target);
	if (!file) throw new ArtifactError(`No file "${target}" in artifact ${id}`, 404);
	if (!isTextType(file.content_type)) throw new ArtifactError(`"${target}" is not a text file`);
	const obj = await env.FILES.get(blobKey(id, file.sha256));
	if (!obj) throw new ArtifactError(`File body for "${target}" is missing`, 404);
	let text = await obj.text();
	edits.forEach((edit, i) => {
		if (!edit.old_str) throw new ArtifactError(`Edit ${i + 1}: old_str must not be empty`);
		const first = text.indexOf(edit.old_str);
		if (first === -1) throw new ArtifactError(`Edit ${i + 1}: old_str not found in ${target}`);
		if (text.indexOf(edit.old_str, first + 1) !== -1) {
			throw new ArtifactError(`Edit ${i + 1}: old_str occurs more than once in ${target}; include more context`);
		}
		text = text.slice(0, first) + edit.new_str + text.slice(first + edit.old_str.length);
	});
	const [stored] = await storeFiles(env, id, [{ path: target, content: text, content_type: file.content_type }]);
	const next = files.map((f) => (f.path === target ? stored : f));
	return commitVersion(env, art, next, { message: meta.message ?? `Edited ${target}`, source: meta.source, model: meta.model });
}

/** Copies an old version's files and entry into a new current version. Nothing is deleted. */
export async function restoreVersion(
	env: Env,
	userId: string,
	id: string,
	version: number,
	meta: { message?: string; source?: string; model?: string } = {},
): Promise<ArtifactRow> {
	const art = await getOwnedArtifact(env, userId, id);
	const v = await env.DB.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`)
		.bind(id, version)
		.first<VersionRow>();
	if (!v) throw new ArtifactError(`Version ${version} not found`, 404);
	const files = await listFiles(env, id, version);
	return commitVersion(env, art, files, {
		model: meta.model,
		entry: v.entry,
		message: meta.message || `Restored version ${version}`,
		source: meta.source ?? "dashboard",
	});
}

export interface SharingInput {
	visibility?: Visibility;
	password?: string;
	expires_at?: number | null;
	regenerate_link?: boolean;
}

export async function setSharing(env: Env, userId: string, id: string, input: SharingInput): Promise<ArtifactRow> {
	const art = await getOwnedArtifact(env, userId, id);
	const visibility = input.visibility ?? art.visibility;
	let passwordHash = art.password_hash;
	let bumpEpoch = false;
	if (visibility === "password") {
		if (input.password) {
			if (input.password.length > 200) throw new ArtifactError("Password is too long");
			passwordHash = await hashPassword(input.password);
			bumpEpoch = true;
		} else if (!passwordHash) {
			throw new ArtifactError("Set a password to use password visibility");
		}
	} else {
		passwordHash = null;
	}
	if (visibility !== art.visibility) bumpEpoch = true;
	if (input.regenerate_link) bumpEpoch = true;
	let expiresAt = art.expires_at;
	if (input.expires_at !== undefined) {
		if (input.expires_at !== null && (!Number.isFinite(input.expires_at) || input.expires_at <= Date.now())) {
			throw new ArtifactError("expires_at must be a future timestamp (ms) or null");
		}
		expiresAt = input.expires_at;
	}
	await env.DB.batch([
		env.DB.prepare(
			`UPDATE artifacts SET visibility = ?, password_hash = ?, expires_at = ?, slug = ?, share_epoch = share_epoch + ?, updated_at = ?
			 WHERE id = ?`,
		).bind(visibility, passwordHash, expiresAt, input.regenerate_link ? randomId(12) : art.slug, bumpEpoch ? 1 : 0, Date.now(), id),
		// A new (or removed) password starts the attempt counters and the owner's failure count from zero.
		...(passwordHash !== art.password_hash ? resetPasswordAttempts(env.DB, id) : []),
	]);
	return getOwnedArtifact(env, userId, id);
}

export async function deleteArtifact(env: Env, artifactId: string): Promise<void> {
	await env.DB.prepare(`DELETE FROM artifacts WHERE id = ?`).bind(artifactId).run();
	await deletePrefix(env, `a/${artifactId}/`);
}

export async function deletePrefix(env: Env, prefix: string) {
	let cursor: string | undefined;
	do {
		const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
		if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Deletes a user and everything they own (D1 cascades; R2 needs explicit deletes). */
export async function deleteUserData(env: Env, userId: string) {
	const { results } = await env.DB.prepare(`SELECT id FROM artifacts WHERE user_id = ?`).bind(userId).all<{ id: string }>();
	for (const { id } of results) await deletePrefix(env, `a/${id}/`);
	await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
}

// ---------------------------------------------------------------------------
// URLs

export interface ContentToken {
	/** artifact id */
	a: string;
	/** version (0 = always the current one) */
	v: number;
	/** share epoch at issue time; bumping it revokes outstanding tokens */
	s: number;
	/** expiry, ms since epoch */
	e: number;
}

export function publicUrl(env: Env, art: Pick<ArtifactRow, "slug" | "visibility">): string | null {
	return art.visibility === "private" ? null : `${env.CONTENT_ORIGIN}/${art.slug}/`;
}

export function dashboardUrl(env: Env, art: Pick<ArtifactRow, "id">): string {
	return `${env.APP_ORIGIN}/a/${art.id}`;
}

/** A short-lived capability URL for the owner's own preview (works for private artifacts). */
export async function previewUrl(env: Env, art: ArtifactRow, version = 0, ttlMs = 2 * 60 * 60 * 1000): Promise<string> {
	const token = await signToken(env.SESSION_SECRET, {
		a: art.id,
		v: version,
		s: art.share_epoch,
		e: Date.now() + ttlMs,
	} satisfies ContentToken);
	return `${env.CONTENT_ORIGIN}/t/${token}/`;
}

/** Shape returned to API and MCP clients. */
export function serializeArtifact(env: Env, art: ArtifactRow) {
	return {
		id: art.id,
		title: art.title,
		description: art.description,
		kind: art.kind,
		entry: art.entry,
		visibility: art.visibility,
		has_password: !!art.password_hash,
		expires_at: art.expires_at,
		expired: art.expires_at !== null && art.expires_at <= Date.now(),
		version: art.current_version,
		size_bytes: art.size_bytes,
		file_count: art.file_count,
		source: art.source,
		model: art.model,
		created_at: art.created_at,
		updated_at: art.updated_at,
		url: publicUrl(env, art),
		dashboard_url: dashboardUrl(env, art),
	};
}

function mb(bytes: number) {
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}
