import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
	ArtifactError,
	deleteFromTrash,
	deleteUserData,
	getOwnedArtifact,
	listArtifacts,
	listFiles,
	listTrash,
	listVersions,
	previewUrl,
	purgeTrash,
	restoreFromTrash,
	restoreVersion,
	serializeArtifact,
	setSharing,
	TRASH_TTL_MS,
	trashArtifact,
	updateArtifact,
	type Visibility,
} from "./artifacts.ts";
import { type AppEnv, isAdmin, type User } from "./auth.ts";
import { recentFailures } from "./throttle.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";

export const api = new Hono<AppEnv & { Variables: { user: User } }>();

/** Cookie-authenticated mutations must come from the dashboard itself. */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		const origin = c.req.header("origin");
		if (origin !== c.env.APP_ORIGIN) return c.json({ error: "Cross-origin request rejected" }, 403);
	}
	await next();
};

api.use("*", sameOrigin);
api.use("*", async (c, next) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Not signed in" }, 401);
	c.set("user", session.user);
	await next();
});

api.onError((err, c) => {
	if (err instanceof ArtifactError) return c.json({ error: err.message }, err.status);
	console.error("API error:", err);
	return c.json({ error: "Something went wrong" }, 500);
});

api.get("/me", (c) => {
	const session = c.get("session")!;
	const u = session.user;
	return c.json({
		user: {
			id: u.id,
			sub: u.sub,
			email: u.email,
			email_verified: !!u.email_verified,
			name: u.name,
			picture: u.picture,
			roles: u.roles,
			is_admin: isAdmin(u),
			created_at: u.created_at,
		},
		session: {
			created_at: session.createdAt,
			expires_at: session.expiresAt,
			// Claims from the id_token verified at sign-in (signature via JWKS, iss, aud, exp, nonce).
			id_token_claims: session.claims,
		},
		config: { app_origin: c.env.APP_ORIGIN, content_origin: c.env.CONTENT_ORIGIN, mcp_url: `${c.env.APP_ORIGIN}/mcp` },
	});
});

api.get("/artifacts", async (c) => {
	const q = c.req.query();
	const res = await listArtifacts(c.env, c.get("user").id, {
		q: q.q,
		kind: q.kind || undefined,
		visibility: q.visibility || undefined,
		sort: (["updated", "created", "title", "size"] as const).find((s) => s === q.sort),
		limit: q.limit ? Number(q.limit) : undefined,
		offset: q.offset ? Number(q.offset) : undefined,
	});
	const stats = await c.env.DB.prepare(
		`SELECT kind, COUNT(*) AS n, SUM(size_bytes) AS bytes FROM artifacts WHERE user_id = ? AND deleted_at IS NULL GROUP BY kind`,
	)
		.bind(c.get("user").id)
		.all<{ kind: string; n: number; bytes: number }>();
	const items = await Promise.all(
		res.items.map(async (a) => ({ ...serializeArtifact(c.env, a), preview_url: await previewUrl(c.env, a) })),
	);
	return c.json({ ...res, items, stats: stats.results });
});

api.get("/artifacts/:id", async (c) => {
	const art = await getOwnedArtifact(c.env, c.get("user").id, c.req.param("id"));
	const requested = Number(c.req.query("version") || 0);
	const versions = await listVersions(c.env, art.id);
	const version = versions.some((v) => v.version === requested) ? requested : art.current_version;
	const files = await listFiles(c.env, art.id, version);
	const viewingVersion = versions.find((v) => v.version === version)!;
	return c.json({
		...serializeArtifact(c.env, art),
		viewing_version: version,
		viewing_entry: viewingVersion.entry,
		preview_url: await previewUrl(c.env, art, version === art.current_version ? 0 : version),
		files: files.map((f) => ({ path: f.path, content_type: f.content_type, size: f.size })),
		versions,
		failed_password_attempts_24h: art.visibility === "password" ? await recentFailures(c.env, art.id) : 0,
	});
});

api.patch("/artifacts/:id", async (c) => {
	const body = await c.req.json<{ title?: string; description?: string }>();
	const art = await updateArtifact(c.env, c.get("user").id, c.req.param("id"), {
		title: typeof body.title === "string" ? body.title : undefined,
		description: typeof body.description === "string" ? body.description : undefined,
	});
	return c.json(serializeArtifact(c.env, art));
});

api.put("/artifacts/:id/sharing", async (c) => {
	const body = await c.req.json<{
		visibility?: Visibility;
		password?: string;
		expires_at?: number | null;
		regenerate_link?: boolean;
	}>();
	if (body.visibility && !["private", "link", "password"].includes(body.visibility)) {
		throw new ArtifactError("Invalid visibility");
	}
	const art = await setSharing(c.env, c.get("user").id, c.req.param("id"), {
		visibility: body.visibility,
		password: body.password || undefined,
		expires_at: body.expires_at,
		regenerate_link: !!body.regenerate_link,
	});
	return c.json(serializeArtifact(c.env, art));
});

api.post("/artifacts/:id/restore", async (c) => {
	const { version } = await c.req.json<{ version: number }>();
	const art = await restoreVersion(c.env, c.get("user").id, c.req.param("id"), Number(version));
	return c.json(serializeArtifact(c.env, art));
});

// Deleting moves to trash; /trash restores or deletes for good.
api.delete("/artifacts/:id", async (c) => {
	const art = await trashArtifact(c.env, c.get("user").id, c.req.param("id"));
	return c.json({ deleted: art.id });
});

api.post("/artifacts/bulk-delete", async (c) => {
	const { ids } = await c.req.json<{ ids: string[] }>();
	if (!Array.isArray(ids) || ids.length > 200) throw new ArtifactError("Provide up to 200 ids");
	const deleted: string[] = [];
	for (const id of ids) {
		try {
			deleted.push((await trashArtifact(c.env, c.get("user").id, String(id))).id);
		} catch (err) {
			if (!(err instanceof ArtifactError && err.status === 404)) throw err;
		}
	}
	return c.json({ deleted });
});

api.post("/artifacts/bulk-sharing", async (c) => {
	const { ids, visibility } = await c.req.json<{ ids: string[]; visibility: Visibility }>();
	if (!Array.isArray(ids) || ids.length > 200) throw new ArtifactError("Provide up to 200 ids");
	if (visibility !== "private" && visibility !== "link") throw new ArtifactError("Bulk sharing supports private or link");
	for (const id of ids) await setSharing(c.env, c.get("user").id, String(id), { visibility });
	return c.json({ updated: ids.length });
});

// Trash ---------------------------------------------------------------------------

api.get("/trash", async (c) => {
	const q = c.req.query();
	const res = await listTrash(c.env, c.get("user").id, {
		limit: q.limit ? Number(q.limit) : undefined,
		offset: q.offset ? Number(q.offset) : undefined,
	});
	// No preview_url: trashed artifacts can't be opened on the content origin.
	const items = res.items.map((a) => ({
		...serializeArtifact(c.env, a),
		url: null,
		deleted_at: a.deleted_at!,
		purge_at: a.deleted_at! + TRASH_TTL_MS,
	}));
	return c.json({ ...res, items });
});

api.post("/trash/:id/restore", async (c) => {
	const art = await restoreFromTrash(c.env, c.get("user").id, c.req.param("id"));
	return c.json(serializeArtifact(c.env, art));
});

api.delete("/trash/:id", async (c) => {
	await deleteFromTrash(c.env, c.get("user").id, c.req.param("id"));
	return c.json({ deleted: c.req.param("id") });
});

/** Empty trash, in bounded batches: the client repeats while `remaining` > 0. */
api.post("/trash/empty", async (c) => c.json(await purgeTrash(c.env, { userId: c.get("user").id, limit: 50 })));

// Access tokens for MCP clients ------------------------------------------------

api.get("/tokens", async (c) => c.json({ items: await listTokens(c.env, c.get("user").id) }));

api.post("/tokens", async (c) => {
	const { name } = await c.req.json<{ name?: string }>();
	const { token, row } = await createToken(c.env, c.get("user").id, String(name ?? ""));
	return c.json({ token, item: row }, 201);
});

api.delete("/tokens/:id", async (c) => {
	const ok = await revokeToken(c.env, c.get("user").id, c.req.param("id"));
	return ok ? c.json({ revoked: true }) : c.json({ error: "Token not found" }, 404);
});

// Admin (gated on the `roles` claim containing "admin") --------------------------

const requireAdmin: MiddlewareHandler<AppEnv & { Variables: { user: User } }> = async (c, next) => {
	if (!isAdmin(c.get("user"))) return c.json({ error: "Admins only" }, 403);
	await next();
};

api.get("/admin/users", requireAdmin, async (c) => {
	const { results } = await c.env.DB.prepare(
		// artifact_count and bytes exclude trash; trash_count and trash_bytes are reported separately.
		`SELECT u.id, u.sub, u.email, u.name, u.picture, u.roles, u.created_at, u.last_login_at,
		   COUNT(a.id) - COUNT(a.deleted_at) AS artifact_count,
		   COALESCE(SUM(CASE WHEN a.deleted_at IS NULL THEN a.size_bytes END), 0) AS bytes,
		   COUNT(a.deleted_at) AS trash_count,
		   COALESCE(SUM(CASE WHEN a.deleted_at IS NOT NULL THEN a.size_bytes END), 0) AS trash_bytes
		 FROM users u LEFT JOIN artifacts a ON a.user_id = u.id
		 GROUP BY u.id ORDER BY u.last_login_at DESC`,
	).all<Record<string, unknown> & { roles: string }>();
	return c.json({ items: results.map((u) => ({ ...u, roles: JSON.parse(u.roles || "[]") })) });
});

api.delete("/admin/users/:id", requireAdmin, async (c) => {
	const id = c.req.param("id");
	if (id === c.get("user").id) throw new ArtifactError("You can't delete your own account here");
	const row = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
	if (!row) return c.json({ error: "User not found" }, 404);
	await deleteUserData(c.env, id);
	return c.json({ deleted: id });
});
