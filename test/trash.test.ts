import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type ArtifactRow,
	createArtifact,
	deleteArtifact,
	editArtifactFile,
	getOwnedArtifact,
	listArtifacts,
	previewUrl,
	purgeTrash,
	restoreFromTrash,
	restoreVersion,
	setSharing,
	TRASH_TTL_MS,
	trashArtifact,
	updateArtifact,
} from "../src/server/artifacts.ts";
import { randomId, sha256Hex } from "../src/server/crypto.ts";
import { ensureSchema } from "../src/server/db.ts";
import worker from "../src/server/index.ts";
import { createToken } from "../src/server/tokens.ts";

const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => ensureSchema(env.DB));

async function newUser(roles: string[] = []) {
	const id = randomId(12);
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, sub, email, name, roles, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, `sub-${id}`, `${id}@example.test`, `User ${id}`, JSON.stringify(roles), now, now)
		.run();
	const cookie = randomId(32);
	await env.DB.prepare(
		`INSERT INTO sessions (id_hash, user_id, claims, created_at, expires_at) VALUES (?, ?, '{}', ?, ?)`,
	)
		.bind(await sha256Hex(cookie), id, now, now + DAY)
		.run();
	return { id, cookie };
}

function publish(userId: string, extra: Partial<Parameters<typeof createArtifact>[2]> = {}) {
	return createArtifact(env, userId, {
		title: "Report",
		files: [{ path: "index.html", content: "<h1>hello</h1>" }],
		visibility: "link",
		...extra,
	});
}

async function call(request: Request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** Dashboard API call with a session cookie. */
function dashboard(cookie: string, method: string, path: string, body?: unknown) {
	return call(
		new Request(`${env.APP_ORIGIN}/api${path}`, {
			method,
			headers: {
				cookie: `art_session=${cookie}`,
				origin: env.APP_ORIGIN,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
	);
}

function content(path: string, init?: RequestInit) {
	return call(new Request(`${env.CONTENT_ORIGIN}${path}`, init));
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
	const res = await call(
		new Request(`${env.APP_ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		}),
	);
	const msg = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
	return { isError: !!msg.result.isError, text: msg.result.content[0].text };
}

async function row(id: string) {
	return env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`).bind(id).first<ArtifactRow>();
}

async function blobCount(id: string) {
	return (await env.FILES.list({ prefix: `a/${id}/` })).objects.length;
}

async function backdate(id: string, deletedAt: number) {
	await env.DB.prepare(`UPDATE artifacts SET deleted_at = ? WHERE id = ?`).bind(deletedAt, id).run();
}

describe("soft delete visibility", () => {
	it("hides a trashed artifact from lists, counts, search and every edit path", async () => {
		const user = await newUser();
		const keep = await publish(user.id, { title: "Keep me" });
		const art = await publish(user.id, { title: "Trash me" });
		await trashArtifact(env, user.id, art.id);

		const list = await listArtifacts(env, user.id, {});
		expect(list.items.map((a) => a.id)).toEqual([keep.id]);
		expect(list.total).toBe(1);
		expect((await listArtifacts(env, user.id, { q: "Trash me" })).total).toBe(0);

		const res = await dashboard(user.cookie, "GET", "/artifacts");
		const body = (await res.json()) as { total: number; stats: { n: number }[] };
		expect(body.total).toBe(1);
		expect(body.stats.reduce((n, s) => n + s.n, 0)).toBe(1);
		expect((await dashboard(user.cookie, "GET", `/artifacts/${art.id}`)).status).toBe(404);

		const refused = [
			getOwnedArtifact(env, user.id, art.id),
			updateArtifact(env, user.id, art.id, { title: "x" }),
			updateArtifact(env, user.id, art.id, { files: [{ path: "a.txt", content: "a" }] }),
			editArtifactFile(env, user.id, art.id, "index.html", [{ old_str: "hello", new_str: "bye" }], {}),
			setSharing(env, user.id, art.id, { visibility: "link" }),
			restoreVersion(env, user.id, art.id, 1),
			trashArtifact(env, user.id, art.id),
		];
		for (const p of refused) await expect(p).rejects.toMatchObject({ status: 404 });
		expect((await dashboard(user.cookie, "PUT", `/artifacts/${art.id}/sharing`, { visibility: "link" })).status).toBe(404);
		expect((await dashboard(user.cookie, "POST", "/artifacts/bulk-sharing", { ids: [art.id], visibility: "link" })).status).toBe(404);

		const stored = (await row(art.id))!;
		expect(stored.current_version).toBe(1);
		expect(stored.title).toBe("Trash me");
	});

	it("serves the not-found page for share links, password links and preview URLs", async () => {
		const user = await newUser();
		const link = await publish(user.id);
		const pw = await publish(user.id, { visibility: "password", password: "hunter2" });
		const preview = await previewUrl(env, link);
		const pwUnlock = await content(`/${pw.slug}/`, { method: "POST", body: new URLSearchParams({ password: "hunter2" }) });
		const unlocked = pwUnlock.headers.get("location")!;
		expect((await content(`/${link.slug}/`)).status).toBe(200);
		expect((await content(new URL(preview).pathname)).status).toBe(200);
		expect((await content(new URL(unlocked).pathname)).status).toBe(200);

		await trashArtifact(env, user.id, link.id);
		await trashArtifact(env, user.id, pw.id);

		for (const path of [`/${link.slug}/`, `/${link.slug}/index.html`, `/${pw.slug}/`, new URL(preview).pathname, new URL(unlocked).pathname]) {
			const res = await content(path);
			expect(res.status, path).toBe(404);
			expect(await res.text()).toContain("Nothing here");
		}
		const post = await content(`/${pw.slug}/`, { method: "POST", body: new URLSearchParams({ password: "hunter2" }) });
		expect(post.status).toBe(404);
	});

	it("keeps the slug reserved while in trash", async () => {
		const user = await newUser();
		const art = await publish(user.id);
		await trashArtifact(env, user.id, art.id);
		const clash = env.DB.prepare(
			`INSERT INTO artifacts (id, user_id, slug, title, kind, entry, current_version, created_at, updated_at)
			 VALUES (?, ?, ?, 't', 'html', 'index.html', 1, 0, 0)`,
		)
			.bind(randomId(12), user.id, art.slug)
			.run();
		await expect(clash).rejects.toThrow(/UNIQUE/);
	});

	it("restores everything as it was, but private and with old links revoked", async () => {
		const user = await newUser();
		const art = await updateArtifact(env, user.id, (await publish(user.id, { visibility: "password", password: "pw" })).id, {
			files: [{ path: "extra.css", content: "a{}" }],
			message: "v2",
		});
		const preview = await previewUrl(env, art);
		await trashArtifact(env, user.id, art.id);
		const back = await restoreFromTrash(env, user.id, art.id);

		expect(back).toMatchObject({
			title: art.title,
			slug: art.slug,
			current_version: 2,
			created_at: art.created_at,
			updated_at: art.updated_at,
			visibility: "private",
			password_hash: null,
			deleted_at: null,
		});
		expect(back.share_epoch).toBe(art.share_epoch + 1);
		expect((await listArtifacts(env, user.id, {})).total).toBe(1);
		// Old capability links stay dead after the restore; the slug only works once it's shared again.
		expect((await content(new URL(preview).pathname)).status).toBe(410);
		expect((await content(`/${art.slug}/`)).status).toBe(404);
		await setSharing(env, user.id, art.id, { visibility: "link" });
		expect((await content(`/${art.slug}/extra.css`)).status).toBe(200);

		await expect(restoreFromTrash(env, user.id, art.id)).rejects.toMatchObject({ status: 404 });
	});

	it("only lets the owner see, restore or delete their trash", async () => {
		const owner = await newUser();
		const other = await newUser();
		const art = await publish(owner.id);
		await trashArtifact(env, owner.id, art.id);
		expect(((await (await dashboard(other.cookie, "GET", "/trash")).json()) as { total: number }).total).toBe(0);
		expect((await dashboard(other.cookie, "POST", `/trash/${art.id}/restore`)).status).toBe(404);
		expect((await dashboard(other.cookie, "DELETE", `/trash/${art.id}`)).status).toBe(404);
		await dashboard(other.cookie, "POST", "/trash/empty");
		expect(await row(art.id)).not.toBeNull();
	});
});

describe("dashboard and MCP deletes move to trash", () => {
	it("single and bulk delete keep the data and list it in trash", async () => {
		const user = await newUser();
		const a = await publish(user.id);
		const b = await publish(user.id);
		const c = await publish(user.id);
		expect((await dashboard(user.cookie, "DELETE", `/artifacts/${a.id}`)).status).toBe(200);
		const bulk = await dashboard(user.cookie, "POST", "/artifacts/bulk-delete", { ids: [b.id, c.id, a.id, "nope"] });
		expect(((await bulk.json()) as { deleted: string[] }).deleted.sort()).toEqual([b.id, c.id].sort());

		for (const id of [a.id, b.id, c.id]) {
			expect((await row(id))!.deleted_at).toBeTypeOf("number");
			expect(await blobCount(id)).toBeGreaterThan(0);
		}
		const trash = (await (await dashboard(user.cookie, "GET", "/trash")).json()) as {
			total: number;
			items: { id: string; deleted_at: number; purge_at: number; url: null; preview_url?: string }[];
		};
		expect(trash.total).toBe(3);
		for (const item of trash.items) {
			expect(item.purge_at - item.deleted_at).toBe(TRASH_TTL_MS);
			expect(item.url).toBeNull();
			expect(item.preview_url).toBeUndefined();
		}
		expect((await dashboard(user.cookie, "POST", `/trash/${a.id}/restore`)).status).toBe(200);
		expect((await row(a.id))!.deleted_at).toBeNull();
	});

	it("MCP delete_artifact trashes, then get/list/update treat it as gone", async () => {
		const user = await newUser();
		const { token } = await createToken(env, user.id, "test");
		const art = await publish(user.id);
		const del = await mcp(token, "delete_artifact", { id: art.id });
		expect(del.isError).toBe(false);
		expect(JSON.parse(del.text)).toMatchObject({ trashed: art.id });
		expect((await row(art.id))!.deleted_at).toBeTypeOf("number");

		expect((await mcp(token, "get_artifact", { id: art.id })).isError).toBe(true);
		expect(JSON.parse((await mcp(token, "list_artifacts", {})).text).total).toBe(0);
		expect((await mcp(token, "update_artifact", { id: art.id, title: "x" })).isError).toBe(true);
		expect((await mcp(token, "set_artifact_sharing", { id: art.id, visibility: "link" })).isError).toBe(true);
		expect((await mcp(token, "delete_artifact", { id: art.id })).isError).toBe(true);
	});
});

describe("purge", () => {
	it("hard-deletes only artifacts trashed more than 30 days ago, R2 included", async () => {
		const user = await newUser();
		const old = await publish(user.id);
		const recent = await publish(user.id);
		const live = await publish(user.id);
		const now = Date.now();
		await trashArtifact(env, user.id, old.id);
		await trashArtifact(env, user.id, recent.id);
		await backdate(old.id, now - TRASH_TTL_MS - 1000);
		await backdate(recent.id, now - TRASH_TTL_MS + DAY);

		const res = await purgeTrash(env, { now });
		expect(res.deleted).toBeGreaterThanOrEqual(1);
		expect(await row(old.id)).toBeNull();
		expect(await blobCount(old.id)).toBe(0);
		expect(await env.DB.prepare(`SELECT 1 FROM artifact_versions WHERE artifact_id = ?`).bind(old.id).first()).toBeNull();
		expect(await row(recent.id)).not.toBeNull();
		expect(await blobCount(recent.id)).toBeGreaterThan(0);
		expect(await row(live.id)).not.toBeNull();
	});

	it("works in bounded batches and reports what is left", async () => {
		const user = await newUser();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const a = await publish(user.id);
			await trashArtifact(env, user.id, a.id);
			ids.push(a.id);
		}
		const first = await purgeTrash(env, { userId: user.id, limit: 2 });
		expect(first).toEqual({ deleted: 2, remaining: 1 });
		const second = await purgeTrash(env, { userId: user.id, limit: 2 });
		expect(second).toEqual({ deleted: 1, remaining: 0 });
		for (const id of ids) expect(await row(id)).toBeNull();
	});

	it("does not delete an artifact restored after it was picked for purging", async () => {
		const user = await newUser();
		const art = await publish(user.id);
		await trashArtifact(env, user.id, art.id);
		await restoreFromTrash(env, user.id, art.id);
		expect(await deleteArtifact(env, art.id, Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(await row(art.id)).not.toBeNull();
		expect(await blobCount(art.id)).toBeGreaterThan(0);
	});

	it("runs from the hourly cron", async () => {
		const user = await newUser();
		const art = await publish(user.id);
		await trashArtifact(env, user.id, art.id);
		await backdate(art.id, Date.now() - TRASH_TTL_MS - DAY);
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await row(art.id)).toBeNull();
		expect(await blobCount(art.id)).toBe(0);
	});

	it("Delete forever and Empty trash only touch trashed artifacts", async () => {
		const user = await newUser();
		const live = await publish(user.id);
		const a = await publish(user.id);
		const b = await publish(user.id);
		await trashArtifact(env, user.id, a.id);
		await trashArtifact(env, user.id, b.id);
		expect((await dashboard(user.cookie, "DELETE", `/trash/${live.id}`)).status).toBe(404);
		expect((await dashboard(user.cookie, "DELETE", `/trash/${a.id}`)).status).toBe(200);
		expect(await row(a.id)).toBeNull();
		expect(await blobCount(a.id)).toBe(0);
		const empty = (await (await dashboard(user.cookie, "POST", "/trash/empty")).json()) as { remaining: number };
		expect(empty.remaining).toBe(0);
		expect(await row(b.id)).toBeNull();
		expect(await row(live.id)).not.toBeNull();
	});
});

describe("admin", () => {
	it("reports trash separately and still hard-deletes it with the user", async () => {
		const admin = await newUser(["admin"]);
		const user = await newUser();
		await publish(user.id);
		const trashed = await publish(user.id);
		await trashArtifact(env, user.id, trashed.id);
		const users = (await (await dashboard(admin.cookie, "GET", "/admin/users")).json()) as {
			items: { id: string; artifact_count: number; bytes: number; trash_count: number; trash_bytes: number }[];
		};
		const u = users.items.find((x) => x.id === user.id)!;
		expect(u).toMatchObject({ artifact_count: 1, trash_count: 1, trash_bytes: trashed.size_bytes, bytes: trashed.size_bytes });

		expect((await dashboard(admin.cookie, "DELETE", `/admin/users/${user.id}`)).status).toBe(200);
		expect(await row(trashed.id)).toBeNull();
		expect(await blobCount(trashed.id)).toBe(0);
	});
});
