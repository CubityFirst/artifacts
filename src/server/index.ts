import { Hono } from "hono";
import { api } from "./api.ts";
import { deleteUserData } from "./artifacts.ts";
import { type AppEnv, authRoutes, sessionMiddleware } from "./auth.ts";
import { handleContent } from "./content.ts";
import { ensureSchema, getMeta, setMeta } from "./db.ts";
import { handleMcp } from "./mcp.ts";
import { upload } from "./upload.ts";

const app = new Hono<AppEnv>();

app.use("/api/*", sessionMiddleware);
app.use("/auth/*", sessionMiddleware);
app.route("/auth", authRoutes);
app.route("/api", api);
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.route("/v1", upload);
app.get("/healthz", (c) => c.text("ok"));
// Everything else is the dashboard SPA (static assets, with index.html as the fallback).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "Something went wrong" }, 500);
});

export default {
	async fetch(request, env, ctx) {
		await ensureSchema(env.DB);
		const host = new URL(request.url).host;
		if (host === new URL(env.CONTENT_ORIGIN).host && env.CONTENT_ORIGIN !== env.APP_ORIGIN) {
			return handleContent(request, env);
		}
		return app.fetch(request, env, ctx);
	},

	async scheduled(_controller, env, ctx) {
		await ensureSchema(env.DB);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
			env.DB.prepare(`DELETE FROM auth_flows WHERE created_at < ?`).bind(now - 60 * 60 * 1000),
		]);
		ctx.waitUntil(syncDeletedUsers(env));
	},
} satisfies ExportedHandler<Env>;

interface IdentityService {
	listDeletedUsers(sinceMs: number): Promise<unknown>;
}

/** Removes local data for accounts deleted at the identity provider. */
async function syncDeletedUsers(env: Env) {
	const since = Number((await getMeta(env.DB, "identity_deleted_since")) ?? 0);
	// Next poll starts from when this one began; overlap is harmless because deletion is idempotent.
	const startedAt = Date.now();
	let deleted: unknown;
	try {
		deleted = await (env.IDENTITY as unknown as IdentityService).listDeletedUsers(since);
	} catch (err) {
		console.warn("IdentityService.listDeletedUsers unavailable:", err instanceof Error ? err.message : err);
		return;
	}
	const list = Array.isArray(deleted)
		? deleted
		: Array.isArray((deleted as { users?: unknown[] })?.users)
			? (deleted as { users: unknown[] }).users
			: [];
	for (const item of list) {
		const sub = typeof item === "string" ? item : ((item as { sub?: string }).sub ?? (item as { id?: string }).id);
		if (!sub) continue;
		const user = await env.DB.prepare(`SELECT id FROM users WHERE sub = ?`).bind(sub).first<{ id: string }>();
		if (user) {
			await deleteUserData(env, user.id);
			console.log(`Deleted local data for removed identity sub=${sub}`);
		}
	}
	await setMeta(env.DB, "identity_deleted_since", String(startedAt));
}
