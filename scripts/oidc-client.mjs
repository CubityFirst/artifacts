#!/usr/bin/env node
// Manage this app's OIDC client registration with auth.cubityfir.st.
//
//   node scripts/oidc-client.mjs register   # one-time; needs OIDC_REGISTRATION_TOKEN in the environment
//   node scripts/oidc-client.mjs show       # GET the current registration
//   node scripts/oidc-client.mjs update     # PUT oidc-client.json (e.g. after adding a callback URL)
//
// Credentials are written to / read from .dev.vars (gitignored) and are never printed.
// Push them to the deployed Worker with `npm run secrets:push`.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_VARS = `${ROOT}.dev.vars`;
const METADATA = JSON.parse(readFileSync(`${ROOT}oidc-client.json`, "utf8"));
const ISSUER = "https://auth.cubityfir.st";

function readDevVars() {
	if (!existsSync(DEV_VARS)) return {};
	const vars = {};
	for (const line of readFileSync(DEV_VARS, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m) vars[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return vars;
}

function writeDevVars(vars) {
	const body = Object.entries(vars)
		.map(([k, v]) => `${k}="${v}"`)
		.join("\n");
	writeFileSync(DEV_VARS, `${body}\n`, { mode: 0o600 });
}

/** Print only non-secret fields of a registration response. */
function summarize(reg) {
	const { client_secret, registration_access_token, ...rest } = reg;
	return {
		...rest,
		client_secret: client_secret ? "(stored in .dev.vars)" : undefined,
		registration_access_token: registration_access_token ? "(stored in .dev.vars)" : undefined,
	};
}

async function register() {
	const token = process.env.OIDC_REGISTRATION_TOKEN;
	if (!token) throw new Error("Set OIDC_REGISTRATION_TOKEN to the single-use registration token.");
	const vars = readDevVars();
	if (vars.OIDC_CLIENT_ID) throw new Error("A client is already registered in .dev.vars; use `update`.");
	const res = await fetch(`${ISSUER}/oauth/register`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(METADATA),
	});
	const body = await res.json().catch(() => ({}));
	if (res.status !== 201) {
		console.error(`Registration failed: HTTP ${res.status}`, summarize(body));
		process.exit(1);
	}
	writeDevVars({
		...vars,
		OIDC_CLIENT_ID: body.client_id,
		OIDC_CLIENT_SECRET: body.client_secret,
		OIDC_REGISTRATION_ACCESS_TOKEN: body.registration_access_token,
		OIDC_REGISTRATION_CLIENT_URI: body.registration_client_uri,
		SESSION_SECRET: vars.SESSION_SECRET ?? randomBytes(32).toString("base64url"),
	});
	console.log("Registered. Credentials written to .dev.vars.");
	console.log(JSON.stringify(summarize(body), null, 2));
}

async function manage(method) {
	const vars = readDevVars();
	if (!vars.OIDC_REGISTRATION_CLIENT_URI || !vars.OIDC_REGISTRATION_ACCESS_TOKEN) {
		throw new Error("No registration in .dev.vars; run `register` first.");
	}
	const res = await fetch(vars.OIDC_REGISTRATION_CLIENT_URI, {
		method,
		headers: {
			authorization: `Bearer ${vars.OIDC_REGISTRATION_ACCESS_TOKEN}`,
			"content-type": "application/json",
		},
		body: method === "PUT" ? JSON.stringify({ ...METADATA, client_id: vars.OIDC_CLIENT_ID }) : undefined,
	});
	const body = await res.json().catch(() => ({}));
	console.log(`HTTP ${res.status}`);
	console.log(JSON.stringify(summarize(body), null, 2));
	if (!res.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "register") await register();
else if (cmd === "show") await manage("GET");
else if (cmd === "update") await manage("PUT");
else {
	console.error("usage: node scripts/oidc-client.mjs <register|show|update>");
	process.exit(2);
}
