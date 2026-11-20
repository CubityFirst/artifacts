#!/usr/bin/env node
// End-to-end smoke test of the MCP endpoint and the content origin against a running dev server.
//   ARTIFACTS_TOKEN=art_… node scripts/mcp-smoke.mjs [http://localhost:5180]
import { strict as assert } from "node:assert";

const APP = process.argv[2] ?? "http://localhost:5180";
const TOKEN = process.env.ARTIFACTS_TOKEN;
if (!TOKEN) throw new Error("Set ARTIFACTS_TOKEN");

let rpcId = 0;
async function rpc(method, params) {
	const res = await fetch(`${APP}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	const body = await res.json();
	if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
	return body.result;
}

async function tool(name, args) {
	const result = await rpc("tools/call", { name, arguments: args });
	const text = result.content?.[0]?.text ?? "";
	if (result.isError) return { error: text };
	return JSON.parse(text);
}

const step = (msg) => console.log(`✓ ${msg}`);

const init = await rpc("initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "smoke", version: "1" },
});
assert.equal(init.serverInfo.name, "artifacts");
step(`initialize → ${init.serverInfo.name} (protocol ${init.protocolVersion})`);

const { tools } = await rpc("tools/list", {});
step(`tools/list → ${tools.map((t) => t.name).join(", ")}`);

// Multi-file HTML site
const site = await tool("publish_artifact", {
	title: "Smoke test site",
	description: "Two files",
	files: [
		{ path: "index.html", content: '<!doctype html><link rel="stylesheet" href="style.css"><h1 id="t">Hello v1</h1>' },
		{ path: "style.css", content: "h1{color:tomato}" },
	],
	model: "claude-opus-5-5",
});
assert.equal(site.kind, "html");
assert.equal(site.visibility, "private");
assert.equal(site.url, null);
step(`publish html site → ${site.id} (private, v${site.version})`);

const edited = await tool("edit_artifact_file", {
	id: site.id,
	path: "index.html",
	edits: [{ old_str: "Hello v1", new_str: "Hello v2" }],
});
assert.equal(edited.version, 2);
const badEdit = await tool("edit_artifact_file", { id: site.id, path: "index.html", edits: [{ old_str: "nope", new_str: "x" }] });
assert.match(badEdit.error, /not found/);
step("edit_artifact_file → v2; non-matching edit is rejected");

const shared = await tool("set_artifact_sharing", { id: site.id, visibility: "link" });
assert.ok(shared.url);
let res = await fetch(shared.url);
let html = await res.text();
assert.equal(res.status, 200);
assert.match(html, /Hello v2/);
assert.equal(res.headers.get("referrer-policy"), "no-referrer");
res = await fetch(new URL("style.css", shared.url));
assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
step(`share by link → ${shared.url} serves v2 + style.css`);

// Password protection
const pw = await tool("set_artifact_sharing", { id: site.id, visibility: "password", password: "hunter2" });
res = await fetch(pw.url);
assert.match(await res.text(), /password protected/);
res = await fetch(pw.url, { method: "POST", body: new URLSearchParams({ password: "wrong" }), redirect: "manual" });
assert.equal(res.status, 401);
res = await fetch(pw.url, { method: "POST", body: new URLSearchParams({ password: "hunter2" }), redirect: "manual" });
assert.equal(res.status, 303);
const unlocked = new URL(res.headers.get("location"), pw.url).href;
res = await fetch(unlocked);
assert.match(await res.text(), /Hello v2/);
step("password gate: wrong → 401, right → capability link that serves content");

// Regenerating the link revokes the old slug and outstanding unlock links
const regen = await tool("set_artifact_sharing", { id: site.id, regenerate_link: true });
assert.notEqual(regen.url, pw.url);
assert.equal((await fetch(pw.url)).status, 404);
assert.equal((await fetch(unlocked)).status, 410);
step("regenerate link → old URL 404, old unlock link 410");

// Expiry
const past = await tool("set_artifact_sharing", { id: site.id, visibility: "link", expires_at: new Date(Date.now() - 1000).toISOString() });
assert.match(past.error ?? "", /future/);
step("expiry in the past is rejected");

// Markdown with a rendered viewer
const md = await tool("publish_artifact", {
	title: "Notes",
	files: [{ path: "README.md", content: "# Heading\n\n- one\n- two\n\n```js\nconsole.log(1)\n```" }],
	visibility: "link",
});
res = await fetch(md.url, { headers: { "sec-fetch-dest": "document" } });
html = await res.text();
assert.match(html, /<h1[^>]*>Heading<\/h1>/);
res = await fetch(`${md.url}README.md?raw=1`);
assert.match(await res.text(), /^# Heading/);
step("markdown → rendered HTML viewer; ?raw=1 returns source");

// Binary image via base64 (1×1 PNG), with media viewer and raw bytes
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const img = await tool("publish_artifact", {
	title: "Pixel",
	files: [{ path: "pixel.png", content: png, encoding: "base64" }],
	visibility: "link",
});
assert.equal(img.kind, "image");
res = await fetch(img.url, { headers: { "sec-fetch-dest": "document" } });
assert.match(await res.text(), /<img src="pixel.png\?raw=1"/);
res = await fetch(`${img.url}pixel.png`, { headers: { "sec-fetch-dest": "image" } });
assert.equal(res.headers.get("content-type"), "image/png");
assert.equal((await res.arrayBuffer()).byteLength, 70);
res = await fetch(`${img.url}pixel.png`, { headers: { range: "bytes=0-7" } });
assert.equal(res.status, 206);
assert.equal(res.headers.get("content-range"), "bytes 0-7/70");
step("image (base64) → viewer page, raw bytes, and 206 range responses");

// Update: add file, delete file, read back
const upd = await tool("update_artifact", {
	id: site.id,
	files: [{ path: "about.html", content: "<p>About</p>" }],
	delete_paths: ["style.css"],
	message: "Add about, drop css",
});
const got = await tool("get_artifact", { id: site.id, include_content: ["index.html"] });
assert.deepEqual(
	got.files.map((f) => f.path),
	["about.html", "index.html"],
);
assert.match(got.files.find((f) => f.path === "index.html").content, /Hello v2/);
assert.equal(got.versions.length, upd.version);
const old = await tool("get_artifact", { id: site.id, version: 1, include_content: true });
assert.match(old.files.find((f) => f.path === "index.html").content, /Hello v1/);
step(`update_artifact → v${upd.version}; get_artifact reads current and v1 content`);

const list = await tool("list_artifacts", { query: "smoke" });
assert.equal(list.total, 1);
step(`list_artifacts query → ${list.total} match`);

const traversal = await tool("publish_artifact", { title: "x", files: [{ path: "../evil.html", content: "x" }] });
assert.match(traversal.error, /not allowed/);
step("path traversal is rejected");

for (const a of [site, md, img]) await tool("delete_artifact", { id: a.id });
assert.equal((await fetch(md.url)).status, 404);
const after = await tool("list_artifacts", {});
assert.equal(after.total, 0);
step("delete_artifact → links 404, library empty");

const unauth = await fetch(`${APP}/mcp`, { method: "POST", headers: { authorization: "Bearer art_invalidinvalidinvalid00" } });
assert.equal(unauth.status, 401);
step("bad token → 401");
console.log("\nAll MCP + content checks passed.");
