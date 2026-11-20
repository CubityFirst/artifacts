import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/server/index.ts" with { type: "cf-worker" };

/**
 * Two hostnames, one Worker:
 *  - APP_ORIGIN serves the dashboard, its JSON API, sign-in and the MCP endpoint.
 *  - CONTENT_ORIGIN serves the artifacts themselves. It is a separate origin so that
 *    user-supplied HTML/JS can never read dashboard cookies or call the dashboard API.
 *
 * In local dev the two origins are http://localhost:5180 and http://127.0.0.1:5180.
 */
const PRODUCTION = {
	app: "https://artifacts.cubityfir.st",
	content: "https://artifacts-content.cubityfir.st",
};
const DEVELOPMENT = {
	app: "http://localhost:5180",
	content: "http://127.0.0.1:5180",
};

export default defineConfig({
	worker: ({ mode }) => {
		const dev = mode === "development";
		const origins = dev ? DEVELOPMENT : PRODUCTION;
		return {
			name: "artifacts",
			compatibilityDate: "2026-11-17",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: {
				notFoundHandling: "single-page-application",
				// The Worker routes by hostname, so it sees every request first and
				// forwards dashboard page/asset requests to env.ASSETS itself.
				runWorkerFirst: true,
			},
			domains: [new URL(PRODUCTION.app).host, new URL(PRODUCTION.content).host],
			triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
			observability: { enabled: false },
			env: {
				DB: bindings.d1({ name: "artifacts" }),
				FILES: bindings.r2({ name: "artifacts-files" }),
				ASSETS: bindings.assets(),

				APP_ORIGIN: bindings.text(origins.app),
				CONTENT_ORIGIN: bindings.text(origins.content),

				// OpenID Connect: "Sign in with cubityfir.st".
				OIDC_ISSUER: bindings.text("https://auth.cubityfir.st"),
				// Server-side OIDC traffic goes over the service binding in production. In local
				// dev the provider Worker isn't running, so fall back to the public issuer URL.
				OIDC_TRANSPORT: bindings.text(dev ? "public" : "binding"),
				OIDC: bindings.worker({ worker: "cubityfirst-auth" }),
				IDENTITY: bindings.worker({ worker: "cubityfirst-auth", exportName: "IdentityService" }),
				OIDC_CLIENT_ID: bindings.secret(),
				OIDC_CLIENT_SECRET: bindings.secret(),
				// HMAC key for share/preview links on the content origin.
				SESSION_SECRET: bindings.secret(),
			},
		};
	},
});
