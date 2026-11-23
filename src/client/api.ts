export type Kind = "html" | "markdown" | "image" | "video" | "audio" | "pdf" | "code" | "text" | "data" | "file";
export type Visibility = "private" | "link" | "password";

export interface Artifact {
	id: string;
	title: string;
	description: string;
	kind: Kind;
	entry: string;
	visibility: Visibility;
	has_password: boolean;
	expires_at: number | null;
	expired: boolean;
	version: number;
	size_bytes: number;
	file_count: number;
	source: string;
	model: string;
	created_at: number;
	updated_at: number;
	url: string | null;
	dashboard_url: string;
	preview_url?: string;
}

export interface TrashedArtifact extends Artifact {
	deleted_at: number;
	/** When the hourly purge deletes it for good. */
	purge_at: number;
}

export interface Version {
	version: number;
	entry: string;
	kind: Kind;
	message: string;
	source: string;
	model: string;
	size_bytes: number;
	file_count: number;
	created_at: number;
}

export interface ArtifactDetail extends Artifact {
	viewing_version: number;
	viewing_entry: string;
	preview_url: string;
	files: { path: string; content_type: string; size: number }[];
	versions: Version[];
	/** Wrong passwords entered on the share link in the last 24 hours (0 unless password-protected). */
	failed_password_attempts_24h: number;
}

export interface Me {
	user: {
		id: string;
		sub: string;
		email: string | null;
		email_verified: boolean;
		name: string | null;
		picture: string | null;
		roles: string[];
		is_admin: boolean;
		created_at: number;
	};
	session: { created_at: number; expires_at: number; id_token_claims: Record<string, unknown> };
	config: { app_origin: string; content_origin: string; mcp_url: string };
}

export interface Token {
	id: string;
	name: string;
	prefix: string;
	created_at: number;
	last_used_at: number | null;
}

export interface AdminUser {
	id: string;
	sub: string;
	email: string | null;
	name: string | null;
	picture: string | null;
	roles: string[];
	created_at: number;
	last_login_at: number;
	/** Live artifacts only; trash is counted separately. */
	artifact_count: number;
	bytes: number;
	trash_count: number;
	trash_bytes: number;
}

export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
	return data as T;
}

export const api = {
	me: () => request<Me>("GET", "/me"),
	list: (params: Record<string, string | number | undefined>) => {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
		return request<{
			items: Artifact[];
			total: number;
			limit: number;
			offset: number;
			stats: { kind: Kind; n: number; bytes: number }[];
		}>("GET", `/artifacts?${qs}`);
	},
	get: (id: string, version?: number) =>
		request<ArtifactDetail>("GET", `/artifacts/${id}${version ? `?version=${version}` : ""}`),
	update: (id: string, body: { title?: string; description?: string }) => request<Artifact>("PATCH", `/artifacts/${id}`, body),
	share: (
		id: string,
		body: { visibility?: Visibility; password?: string; expires_at?: number | null; regenerate_link?: boolean },
	) => request<Artifact>("PUT", `/artifacts/${id}/sharing`, body),
	restore: (id: string, version: number) => request<Artifact>("POST", `/artifacts/${id}/restore`, { version }),
	remove: (id: string) => request<{ deleted: string }>("DELETE", `/artifacts/${id}`),
	bulkDelete: (ids: string[]) => request<{ deleted: string[] }>("POST", "/artifacts/bulk-delete", { ids }),
	trash: (offset = 0) =>
		request<{ items: TrashedArtifact[]; total: number; bytes: number; limit: number; offset: number }>(
			"GET",
			`/trash?offset=${offset}`,
		),
	restoreFromTrash: (id: string) => request<Artifact>("POST", `/trash/${id}/restore`),
	deleteForever: (id: string) => request<{ deleted: string }>("DELETE", `/trash/${id}`),
	emptyTrash: () => request<{ deleted: number; remaining: number }>("POST", "/trash/empty"),
	bulkShare: (ids: string[], visibility: "private" | "link") =>
		request<{ updated: number }>("POST", "/artifacts/bulk-sharing", { ids, visibility }),
	tokens: () => request<{ items: Token[] }>("GET", "/tokens"),
	createToken: (name: string) => request<{ token: string; item: Token }>("POST", "/tokens", { name }),
	revokeToken: (id: string) => request<{ revoked: boolean }>("DELETE", `/tokens/${id}`),
	adminUsers: () => request<{ items: AdminUser[] }>("GET", "/admin/users"),
	adminDeleteUser: (id: string) => request<{ deleted: string }>("DELETE", `/admin/users/${id}`),
	logout: async () => {
		const res = await fetch("/auth/logout", { method: "POST" });
		const data = (await res.json().catch(() => ({ redirect: "/" }))) as { redirect: string };
		return data.redirect;
	},
};

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function timeAgo(ms: number): string {
	const diff = (ms - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return "just now";
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const KIND_LABEL: Record<Kind, string> = {
	html: "Web page",
	markdown: "Document",
	image: "Image",
	video: "Video",
	audio: "Audio",
	pdf: "PDF",
	code: "Code",
	text: "Text",
	data: "Data",
	file: "File",
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
	private: "Private",
	link: "Anyone with link",
	password: "Password",
};

/** "mcp:Claude Code laptop" / "cli:Claude Code laptop" → "Claude Code laptop" */
export function sourceLabel(source: string): string {
	return source.replace(/^(mcp|cli):/, "");
}
