import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ArtifactError,
	createArtifact,
	listFiles,
	listVersions,
	previewUrl,
	restoreVersion,
	updateArtifact,
} from "../src/server/artifacts.ts";
import { handleContent } from "../src/server/content.ts";
import { ensureSchema } from "../src/server/db.ts";
import { handleMcp } from "../src/server/mcp.ts";
import { createToken } from "../src/server/tokens.ts";

const USER = "u_restore";

beforeAll(async () => {
	await ensureSchema(env.DB);
	await env.DB.prepare(`INSERT OR IGNORE INTO users (id, sub, created_at, last_login_at) VALUES (?, ?, 0, 0)`)
		.bind(USER, "sub-restore")
		.run();
});

/** v1 opens a.html; v2 adds b.html and makes it the entry. */
async function twoEntries() {
	const v1 = await createArtifact(env, USER, {
		title: "Entries",
		files: [{ path: "a.html", content: "<p>first entry</p>" }],
		entry: "a.html",
	});
	const v2 = await updateArtifact(env, USER, v1.id, { files: [{ path: "b.html", content: "<p>second entry</p>" }], entry: "b.html" });
	expect(v2.current_version).toBe(2);
	expect(v2.entry).toBe("b.html");
	return v2;
}

async function fetchContent(url: string) {
	const res = await handleContent(new Request(url, { headers: { "sec-fetch-dest": "iframe" } }), env);
	return { status: res.status, text: await res.text() };
}

describe("old-version previews", () => {
	it("open that version's own entry, not the current one", async () => {
		const art = await twoEntries();
		const old = await fetchContent(await previewUrl(env, art, 1));
		expect(old.status).toBe(200);
		expect(old.text).toContain("first entry");

		const current = await fetchContent(await previewUrl(env, art));
		expect(current.text).toContain("second entry");
		const pinnedCurrent = await fetchContent(await previewUrl(env, art, 2));
		expect(pinnedCurrent.text).toContain("second entry");
	});

	it("still serve other paths of that version", async () => {
		const art = await twoEntries();
		const res = await fetchContent(`${await previewUrl(env, art, 1)}a.html`);
		expect(res.text).toContain("first entry");
		// b.html didn't exist in v1.
		expect((await fetchContent(`${await previewUrl(env, art, 1)}b.html`)).status).toBe(404);
	});

	it("404 for a version that doesn't exist", async () => {
		const art = await twoEntries();
		expect((await fetchContent(await previewUrl(env, art, 9))).status).toBe(404);
	});
});

describe("restoreVersion", () => {
	it("adds a new version with the old files and entry, keeping history", async () => {
		const art = await twoEntries();
		const restored = await restoreVersion(env, USER, art.id, 1);
		expect(restored.current_version).toBe(3);
		expect(restored.entry).toBe("a.html");
		expect((await listFiles(env, art.id, 3)).map((f) => f.path)).toEqual(["a.html"]);
		const versions = await listVersions(env, art.id);
		expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
		expect(versions[0]).toMatchObject({ entry: "a.html", message: "Restored version 1", source: "dashboard" });
	});

	it("rejects the current version and unknown versions", async () => {
		const art = await twoEntries();
		await expect(restoreVersion(env, USER, art.id, 2)).rejects.toMatchObject({ status: 409 });
		await expect(restoreVersion(env, USER, art.id, 7)).rejects.toMatchObject({ status: 404 });
		await expect(restoreVersion(env, "someone-else", art.id, 1)).rejects.toBeInstanceOf(ArtifactError);
		expect((await listVersions(env, art.id)).length).toBe(2);
	});
});

describe("MCP update_artifact restore_version", () => {
	let token: string;
	beforeAll(async () => {
		token = (await createToken(env, USER, "test client")).token;
	});

	async function call(args: Record<string, unknown>) {
		const ctx = createExecutionContext();
		const res = await handleMcp(
			new Request(`${env.APP_ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_artifact", arguments: args } }),
			}),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const body = await res.json<{ result: { content: { text: string }[]; isError?: boolean } }>();
		return { isError: !!body.result.isError, text: body.result.content[0]!.text };
	}

	it("rolls back and returns the serialised artifact", async () => {
		const art = await twoEntries();
		const res = await call({ id: art.id, restore_version: 1, message: "Back to a", model: "test-model" });
		expect(res.isError).toBe(false);
		const out = JSON.parse(res.text);
		expect(out).toMatchObject({ id: art.id, version: 3, entry: "a.html", model: "test-model", source: "mcp:test client" });
		expect(out.dashboard_url).toBe(`${env.APP_ORIGIN}/a/${art.id}`);
		expect((await listVersions(env, art.id))[0]).toMatchObject({ version: 3, message: "Back to a" });
	});

	it("refuses to mix a restore with file changes", async () => {
		const art = await twoEntries();
		const res = await call({ id: art.id, restore_version: 1, files: [{ path: "c.html", content: "x" }] });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("can't be combined");
		expect((await listVersions(env, art.id)).length).toBe(2);
	});
});
