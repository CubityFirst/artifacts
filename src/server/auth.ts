import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as client from "openid-client";
import { randomId, sha256Hex } from "./crypto.ts";
import { type IdentityClaims, callbackUrl, getOidcConfig, OIDC_SCOPES, postLogoutUrl } from "./oidc.ts";

export interface User {
	id: string;
	sub: string;
	email: string | null;
	email_verified: number;
	name: string | null;
	picture: string | null;
	roles: string[];
	created_at: number;
	last_login_at: number;
}

export interface Session {
	user: User;
	idHash: string;
	claims: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
}

export type AppEnv = { Bindings: Env; Variables: { session: Session | null } };

const SESSION_COOKIE = "art_session";
const FLOW_COOKIE = "art_auth_flow";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;

const isSecure = (env: Env) => env.APP_ORIGIN.startsWith("https://");

export const isAdmin = (user: User) => user.roles.includes("admin");

function safeReturnTo(value: string | undefined | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
	return value;
}

/** Loads the session (if any) for every dashboard request. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
	c.set("session", await loadSession(c));
	await next();
};

async function loadSession(c: Context<AppEnv>): Promise<Session | null> {
	const raw = getCookie(c, SESSION_COOKIE);
	if (!raw) return null;
	const idHash = await sha256Hex(raw);
	const row = await c.env.DB.prepare(
		`SELECT s.id_hash, s.claims, s.created_at AS s_created, s.expires_at, u.*
		 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
	)
		.bind(idHash)
		.first<User & { id_hash: string; claims: string; s_created: number; expires_at: number; roles: string }>();
	if (!row || row.expires_at < Date.now()) return null;
	const { id_hash, claims, s_created, expires_at, ...user } = row;
	return {
		user: { ...user, roles: parseRoles(user.roles) },
		idHash: id_hash,
		claims: JSON.parse(claims),
		createdAt: s_created,
		expiresAt: expires_at,
	};
}

function parseRoles(value: unknown): string[] {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
	} catch {
		return [];
	}
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/login", async (c) => {
	const config = await getOidcConfig(c.env);
	const flowId = randomId(32);
	const codeVerifier = client.randomPKCECodeVerifier();
	const state = client.randomState();
	const nonce = client.randomNonce();
	await c.env.DB.prepare(
		`INSERT INTO auth_flows (id, state, nonce, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(flowId, state, nonce, codeVerifier, safeReturnTo(c.req.query("return_to")), Date.now())
		.run();
	setCookie(c, FLOW_COOKIE, flowId, {
		httpOnly: true,
		secure: isSecure(c.env),
		sameSite: "Lax",
		path: "/auth",
		maxAge: FLOW_TTL_MS / 1000,
	});
	const url = client.buildAuthorizationUrl(config, {
		redirect_uri: callbackUrl(c.env),
		scope: OIDC_SCOPES,
		code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
		code_challenge_method: "S256",
		state,
		nonce,
	});
	return c.redirect(url.href);
});

authRoutes.get("/callback", async (c) => {
	const flowId = getCookie(c, FLOW_COOKIE);
	deleteCookie(c, FLOW_COOKIE, { path: "/auth", secure: isSecure(c.env) });
	const providerError = c.req.query("error");
	if (providerError) {
		return c.redirect(`/?auth_error=${encodeURIComponent(c.req.query("error_description") || providerError)}`);
	}
	if (!flowId) return c.redirect(`/?auth_error=${encodeURIComponent("Sign-in session expired; try again.")}`);

	// Single use: fetch and delete the flow before doing anything with it.
	const flow = await c.env.DB.prepare(`DELETE FROM auth_flows WHERE id = ? RETURNING *`)
		.bind(flowId)
		.first<{ state: string; nonce: string; code_verifier: string; return_to: string; created_at: number }>();
	if (!flow || Date.now() - flow.created_at > FLOW_TTL_MS) {
		return c.redirect(`/?auth_error=${encodeURIComponent("Sign-in session expired; try again.")}`);
	}

	const config = await getOidcConfig(c.env);
	// Rebuild the URL on the registered origin so redirect_uri matches byte for byte.
	const currentUrl = new URL(`${callbackUrl(c.env)}${new URL(c.req.url).search}`);
	let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
	try {
		// Verifies state, iss (incl. the authorization response iss parameter), PKCE, and the
		// id_token's RS256 signature (JWKS), iss, aud == client_id, exp, iat and nonce.
		tokens = await client.authorizationCodeGrant(config, currentUrl, {
			pkceCodeVerifier: flow.code_verifier,
			expectedState: flow.state,
			expectedNonce: flow.nonce,
			idTokenExpected: true,
		});
	} catch (err) {
		console.error("OIDC callback failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
		return c.redirect(`/?auth_error=${encodeURIComponent("Sign-in could not be verified.")}`);
	}
	const claims = tokens.claims() as IdentityClaims | undefined;
	if (!claims?.sub) return c.redirect(`/?auth_error=${encodeURIComponent("The identity provider returned no subject.")}`);

	const user = await upsertUser(c.env, claims);
	const sessionToken = randomId(43);
	const now = Date.now();
	await c.env.DB.prepare(
		`INSERT INTO sessions (id_hash, user_id, id_token, claims, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(await sha256Hex(sessionToken), user.id, tokens.id_token ?? null, JSON.stringify(claims), now, now + SESSION_TTL_MS)
		.run();
	console.log(`OIDC sign-in verified for sub=${claims.sub} (roles: ${(claims.roles ?? []).join(",") || "none"})`);
	setCookie(c, SESSION_COOKIE, sessionToken, {
		httpOnly: true,
		secure: isSecure(c.env),
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_TTL_MS / 1000,
	});
	return c.redirect(safeReturnTo(flow.return_to));
});

/** Users are keyed on the provider's stable `sub`, never on email. */
async function upsertUser(env: Env, claims: IdentityClaims): Promise<User> {
	const now = Date.now();
	const roles = JSON.stringify(Array.isArray(claims.roles) ? claims.roles.filter((r) => typeof r === "string") : []);
	const row = await env.DB.prepare(
		`INSERT INTO users (id, sub, email, email_verified, name, picture, roles, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(sub) DO UPDATE SET
		   email = excluded.email, email_verified = excluded.email_verified, name = excluded.name,
		   picture = excluded.picture, roles = excluded.roles, last_login_at = excluded.last_login_at
		 RETURNING *`,
	)
		.bind(
			randomId(16),
			claims.sub,
			claims.email ?? null,
			claims.email_verified ? 1 : 0,
			claims.name ?? null,
			typeof claims.picture === "string" && /^https:\/\//.test(claims.picture) ? claims.picture : null,
			roles,
			now,
			now,
		)
		.first<User & { roles: string }>();
	return { ...row!, roles: parseRoles(row!.roles) };
}

/**
 * Sign-out: delete our session, then send the browser to the provider's
 * end_session_endpoint (RP-initiated logout) with id_token_hint.
 */
authRoutes.post("/logout", async (c) => {
	const session = c.get("session");
	let redirect = "/";
	if (session) {
		const row = await c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ? RETURNING id_token`)
			.bind(session.idHash)
			.first<{ id_token: string | null }>();
		if (row?.id_token) {
			const config = await getOidcConfig(c.env);
			redirect = client.buildEndSessionUrl(config, {
				id_token_hint: row.id_token,
				post_logout_redirect_uri: postLogoutUrl(c.env),
			}).href;
		}
	}
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c.env) });
	return c.json({ redirect });
});
