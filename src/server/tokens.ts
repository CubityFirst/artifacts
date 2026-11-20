import type { User } from "./auth.ts";
import { randomId, sha256Hex } from "./crypto.ts";

export interface TokenRow {
	id: string;
	user_id: string;
	name: string;
	prefix: string;
	created_at: number;
	last_used_at: number | null;
}

const TOKEN_PREFIX = "art_";

export async function createToken(env: Env, userId: string, name: string) {
	const secret = `${TOKEN_PREFIX}${randomId(40)}`;
	const row: TokenRow = {
		id: randomId(12),
		user_id: userId,
		name: name.trim().slice(0, 80) || "Untitled token",
		prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
		created_at: Date.now(),
		last_used_at: null,
	};
	await env.DB.prepare(
		`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(row.id, row.user_id, row.name, await sha256Hex(secret), row.prefix, row.created_at)
		.run();
	return { token: secret, row };
}

export async function listTokens(env: Env, userId: string): Promise<TokenRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, user_id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
	)
		.bind(userId)
		.all<TokenRow>();
	return results;
}

export async function revokeToken(env: Env, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`).bind(id, userId).run();
	return res.meta.changes > 0;
}

/** Resolves `Authorization: Bearer art_…` to its user and token. */
export async function authenticateBearer(
	env: Env,
	request: Request,
	ctx: ExecutionContext,
): Promise<{ user: User; token: TokenRow } | null> {
	const header = request.headers.get("authorization") ?? "";
	const match = header.match(/^Bearer\s+(art_[0-9A-Za-z]{20,})\s*$/);
	if (!match) return null;
	const row = await env.DB.prepare(
		`SELECT t.id AS t_id, t.name AS t_name, t.prefix AS t_prefix, t.created_at AS t_created, t.last_used_at AS t_used, u.*
		 FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
	)
		.bind(await sha256Hex(match[1]))
		.first<User & { t_id: string; t_name: string; t_prefix: string; t_created: number; t_used: number | null; roles: string }>();
	if (!row) return null;
	const { t_id, t_name, t_prefix, t_created, t_used, ...user } = row;
	const now = Date.now();
	if (!t_used || now - t_used > 60_000) {
		ctx.waitUntil(env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).bind(now, t_id).run());
	}
	return {
		user: { ...user, roles: JSON.parse(user.roles || "[]") },
		token: { id: t_id, user_id: user.id, name: t_name, prefix: t_prefix, created_at: t_created, last_used_at: t_used },
	};
}
