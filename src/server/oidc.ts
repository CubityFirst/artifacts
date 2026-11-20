import * as client from "openid-client";

export const OIDC_SCOPES = "openid profile email roles";

/**
 * Server-side OIDC requests (discovery, JWKS, token, userinfo) go through the
 * `cubityfirst-auth` service binding instead of the public internet. In local dev
 * (OIDC_TRANSPORT=public) the provider Worker isn't running, so use the public URL.
 * Browser redirects (authorize, end-session) always use the public issuer URL.
 */
function oidcFetch(env: Env): client.CustomFetch {
	const issuerHost = new URL(env.OIDC_ISSUER).host;
	return (url, options) => {
		if (env.OIDC_TRANSPORT === "binding" && new URL(url).host === issuerHost) {
			return env.OIDC.fetch(new Request(url, options as RequestInit));
		}
		return fetch(url, options as RequestInit);
	};
}

let cached: { key: string; at: number; config: Promise<client.Configuration> } | undefined;
const CONFIG_TTL_MS = 60 * 60 * 1000;

/** Client configuration built from the discovery document, cached per isolate. */
export function getOidcConfig(env: Env): Promise<client.Configuration> {
	const key = `${env.OIDC_ISSUER}|${env.OIDC_CLIENT_ID}|${env.OIDC_TRANSPORT}`;
	if (cached && cached.key === key && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
	const config = client
		.discovery(
			new URL(env.OIDC_ISSUER),
			env.OIDC_CLIENT_ID,
			undefined,
			// Registered as a confidential client with token_endpoint_auth_method=client_secret_basic.
			client.ClientSecretBasic(env.OIDC_CLIENT_SECRET),
			{
				[client.customFetch]: oidcFetch(env),
				// openid-client skips the id_token signature check unless this is enabled.
				execute: [client.enableNonRepudiationChecks],
			},
		)
		.catch((err) => {
			cached = undefined;
			throw err;
		});
	cached = { key, at: Date.now(), config };
	return config;
}

export function callbackUrl(env: Env) {
	return `${env.APP_ORIGIN}/auth/callback`;
}

export function postLogoutUrl(env: Env) {
	return `${env.APP_ORIGIN}/`;
}

export interface IdentityClaims {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
	roles?: string[];
	auth_time?: number;
	amr?: string[];
	sid?: string;
	iss: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nonce?: string;
}
