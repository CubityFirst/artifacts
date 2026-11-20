import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: {
		// The OIDC callback is registered as http://localhost:5180/auth/callback, so the
		// port must not drift. Artifacts are served from http://127.0.0.1:5180 in dev.
		host: "127.0.0.1",
		port: 5180,
		strictPort: true,
	},
	fmt: { useTabs: true },
	lint: {
		options: { typeAware: true, typeCheck: true },
	},
});
