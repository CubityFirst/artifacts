import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Tests run inside workerd with the bindings from cloudflare.config.ts (local D1 and R2, isolated per test file).
export default defineConfig({
	plugins: [
		cloudflareTest({
			config: "./cloudflare.config.ts",
			miniflare: {
				bindings: { SESSION_SECRET: "test-session-secret", OIDC_CLIENT_ID: "test", OIDC_CLIENT_SECRET: "test" },
				// The OIDC and IDENTITY service bindings point at the auth Worker; tests get an inert stand-in.
				workers: [
					{
						name: "cubityfirst-auth",
						modules: true,
						compatibilityDate: "2026-11-17",
						script: `
							import { WorkerEntrypoint } from "cloudflare:workers";
							export class IdentityService extends WorkerEntrypoint { listDeletedUsers() { return []; } }
							export default { fetch() { return new Response("auth stub", { status: 503 }); } };
						`,
					},
				],
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
