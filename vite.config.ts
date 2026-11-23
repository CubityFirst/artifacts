import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const TEST_MINIFLARE = {
	bindings: { SESSION_SECRET: "test-secret", OIDC_CLIENT_ID: "test", OIDC_CLIENT_SECRET: "test" },
	workers: [
		{
			name: "cubityfirst-auth",
			modules: true,
			script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class IdentityService extends WorkerEntrypoint { listDeletedUsers() { return []; } }
export default { fetch() { return new Response("auth stub", { status: 503 }); } };`,
		},
	],
};

export default defineConfig(({ mode }) => ({
	// `vp test` runs the server tests inside workerd with the Worker's own bindings (cloudflare.config.ts),
	// test secrets, and a stub for the identity provider's Worker.
	plugins: mode === "test" ? [cloudflareTest({ config: true, miniflare: TEST_MINIFLARE })] : [react(), cloudflare()],
	server: {
		// The OIDC callback is registered as http://localhost:5180/auth/callback, so the
		// port must not drift. Artifacts are served from http://127.0.0.1:5180 in dev.
		host: "127.0.0.1",
		port: 5180,
		strictPort: true,
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
	fmt: { useTabs: true },
	lint: {
		options: { typeAware: true, typeCheck: true },
	},
}));
