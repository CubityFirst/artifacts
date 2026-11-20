import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import {
	ArtifactError,
	blobKey,
	createArtifact,
	deleteArtifact,
	editArtifactFile,
	getOwnedArtifact,
	LIMITS,
	listArtifacts,
	listFiles,
	listVersions,
	serializeArtifact,
	setSharing,
	updateArtifact,
} from "./artifacts.ts";
import type { User } from "./auth.ts";
import { isTextType } from "./mime.ts";
import { authenticateBearer, type TokenRow } from "./tokens.ts";

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
	"access-control-expose-headers": "mcp-session-id, www-authenticate",
	"access-control-max-age": "86400",
};

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	const auth = await authenticateBearer(env, request, ctx);
	if (!auth) {
		return Response.json(
			{
				jsonrpc: "2.0",
				error: {
					code: -32001,
					message: `Unauthorized. Create an access token at ${env.APP_ORIGIN}/settings and send it as "Authorization: Bearer <token>".`,
				},
				id: null,
			},
			{ status: 401, headers: { ...CORS, "www-authenticate": `Bearer realm="artifacts"` } },
		);
	}
	const server = buildServer(env, auth.user, auth.token);
	// Stateless: a fresh server + transport per request, JSON responses (no SSE needed for tools).
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await server.connect(transport);
	const response = await transport.handleRequest(request);
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
	return new Response(response.body, { status: response.status, headers });
}

const fileSchema = z.object({
	path: z.string().describe('Relative path inside the artifact, e.g. "index.html", "assets/app.js", "chart.png".'),
	content: z
		.string()
		.optional()
		.describe('File contents: UTF-8 text, or base64 when encoding is "base64". Omit when using url.'),
	encoding: z.enum(["utf8", "base64"]).optional().describe('Defaults to "utf8". Use "base64" for binary files.'),
	url: z
		.string()
		.optional()
		.describe("Instead of content: an http(s) URL the server downloads the file from (good for large media)."),
	content_type: z.string().optional().describe("MIME type. Inferred from the file extension when omitted."),
});

const visibilitySchema = z
	.enum(["private", "link", "password"])
	.describe('"private": only you, from the dashboard. "link": anyone with the URL. "password": anyone with the URL and password.');

function ok(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
	const message = err instanceof ArtifactError || err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
	return async (args: A) => {
		try {
			return ok(await fn(args));
		} catch (err) {
			if (!(err instanceof ArtifactError)) console.error("MCP tool error:", err);
			return fail(err);
		}
	};
}

function buildServer(env: Env, user: User, token: TokenRow) {
	const server = new McpServer(
		{ name: "artifacts", title: "Artifacts", version: "1.0.0" },
		{
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
			instructions: [
				"Artifacts hosts web pages, documents, images, video, audio, data and code that you publish, and lets the user browse, share and manage them from a dashboard.",
				"Publish with publish_artifact; change an existing one with edit_artifact_file (small text edits) or update_artifact (add/replace/delete files). Every change creates a new version.",
				"Multi-file sites: use relative URLs between files (\"style.css\", not \"/style.css\").",
				"New artifacts are private unless you set visibility; the user can change sharing in the dashboard.",
				`Dashboard: ${env.APP_ORIGIN}`,
			].join("\n"),
		},
	);
	const source = `mcp:${token.name}`;

	server.registerTool(
		"publish_artifact",
		{
			title: "Publish artifact",
			description:
				"Publish a new artifact (a single file or a multi-file site). Supports HTML, Markdown, images, SVG, video, audio, PDF, JSON/CSV and source code. " +
				"Markdown and code get a rendered viewer; media gets a player. Returns its id, dashboard_url, and a public url when shared. " +
				`Limits: ${LIMITS.maxFileBytes / 1024 / 1024} MB per file, ${LIMITS.maxArtifactBytes / 1024 / 1024} MB per artifact.`,
			inputSchema: {
				title: z.string().describe("Short human-readable title."),
				description: z.string().optional().describe("One or two sentences about what this is."),
				files: z.array(fileSchema).min(1).describe("The files that make up the artifact."),
				entry: z
					.string()
					.optional()
					.describe("Which file opens first. Defaults to index.html, then README.md, then the first top-level file."),
				visibility: visibilitySchema.optional(),
				password: z.string().optional().describe('Required when visibility is "password".'),
				model: z.string().optional().describe('The model that produced this, e.g. "claude-opus-5-5", "gpt-5", "gemini-3-pro".'),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		wrap(async (args) => {
			const art = await createArtifact(env, user.id, { ...args, source, message: "Created" });
			return serializeArtifact(env, art);
		}),
	);

	server.registerTool(
		"update_artifact",
		{
			title: "Update artifact",
			description:
				"Create a new version of an artifact: add or replace files, delete files, and/or change title, description or entry. " +
				"Files you don't mention are kept unless replace_all is true. Title/description-only changes don't create a version.",
			inputSchema: {
				id: z.string().describe("Artifact id."),
				files: z.array(fileSchema).optional().describe("Files to add or overwrite."),
				delete_paths: z.array(z.string()).optional().describe("Paths to remove."),
				replace_all: z.boolean().optional().describe("If true, the new version contains only `files`."),
				title: z.string().optional(),
				description: z.string().optional(),
				entry: z.string().optional(),
				message: z.string().optional().describe("Short note about what changed (shown in version history)."),
				model: z.string().optional(),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		wrap(async ({ id, ...args }) => serializeArtifact(env, await updateArtifact(env, user.id, id, { ...args, source }))),
	);

	server.registerTool(
		"edit_artifact_file",
		{
			title: "Edit artifact file",
			description:
				"Apply exact find-and-replace edits to one text file of an artifact, creating a new version. " +
				"Each old_str must match exactly once (include surrounding context to make it unique). Edits apply in order, all or nothing.",
			inputSchema: {
				id: z.string().describe("Artifact id."),
				path: z.string().describe("File to edit, e.g. index.html."),
				edits: z
					.array(z.object({ old_str: z.string(), new_str: z.string() }))
					.min(1)
					.describe("Replacements to apply in order."),
				message: z.string().optional(),
				model: z.string().optional(),
			},
		},
		wrap(async ({ id, path, edits, message, model }) =>
			serializeArtifact(env, await editArtifactFile(env, user.id, id, path, edits, { message, source, model })),
		),
	);

	server.registerTool(
		"get_artifact",
		{
			title: "Get artifact",
			description:
				"Get an artifact's metadata, files and version history. Set include_content to read text files (e.g. before editing).",
			inputSchema: {
				id: z.string(),
				include_content: z
					.union([z.boolean(), z.array(z.string())])
					.optional()
					.describe("true for all text files (up to 200 KB total), or a list of paths."),
				version: z.number().int().optional().describe("Read an older version. Defaults to the current one."),
			},
			annotations: { readOnlyHint: true },
		},
		wrap(async ({ id, include_content, version }) => {
			const art = await getOwnedArtifact(env, user.id, id);
			const v = version ?? art.current_version;
			const [files, versions] = await Promise.all([listFiles(env, id, v), listVersions(env, id)]);
			if (!versions.some((x) => x.version === v)) throw new ArtifactError(`Version ${v} not found`, 404);
			const wanted = Array.isArray(include_content) ? new Set(include_content) : null;
			let budget = 200 * 1024;
			const out = [];
			for (const f of files) {
				const entry: Record<string, unknown> = { path: f.path, content_type: f.content_type, size: f.size };
				const want = include_content === true ? isTextType(f.content_type) : !!wanted?.has(f.path);
				if (want) {
					if (!isTextType(f.content_type)) entry.content_omitted = "binary file";
					else if (f.size > budget) entry.content_omitted = "over the 200 KB read budget; request this path on its own";
					else {
						const obj = await env.FILES.get(blobKey(id, f.sha256));
						entry.content = (await obj?.text()) ?? "";
						budget -= f.size;
					}
				}
				out.push(entry);
			}
			return {
				...serializeArtifact(env, art),
				viewing_version: v,
				files: out,
				versions: versions.map((x) => ({
					version: x.version,
					message: x.message,
					source: x.source,
					model: x.model,
					created_at: x.created_at,
				})),
			};
		}),
	);

	server.registerTool(
		"list_artifacts",
		{
			title: "List artifacts",
			description: "List or search your artifacts, newest first.",
			inputSchema: {
				query: z.string().optional().describe("Matches title, description or entry file name."),
				kind: z
					.enum(["html", "markdown", "image", "video", "audio", "pdf", "code", "text", "data", "file"])
					.optional(),
				limit: z.number().int().min(1).max(100).optional(),
				offset: z.number().int().min(0).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		wrap(async ({ query, kind, limit, offset }) => {
			const res = await listArtifacts(env, user.id, { q: query, kind, limit: limit ?? 25, offset });
			return { total: res.total, offset: res.offset, items: res.items.map((a) => serializeArtifact(env, a)) };
		}),
	);

	server.registerTool(
		"set_artifact_sharing",
		{
			title: "Set artifact sharing",
			description:
				"Change who can open an artifact: private, anyone with the link, or link + password. Optionally set an expiry or regenerate the link (which breaks the old one).",
			inputSchema: {
				id: z.string(),
				visibility: visibilitySchema.optional(),
				password: z.string().optional().describe('New password (for "password" visibility).'),
				expires_at: z
					.string()
					.nullable()
					.optional()
					.describe("ISO 8601 time after which the share link stops working, or null to never expire."),
				regenerate_link: z.boolean().optional(),
			},
		},
		wrap(async ({ id, expires_at, ...rest }) => {
			let expires: number | null | undefined;
			if (expires_at === null) expires = null;
			else if (expires_at !== undefined) {
				expires = Date.parse(expires_at);
				if (Number.isNaN(expires)) throw new ArtifactError("expires_at must be an ISO 8601 date-time");
			}
			return serializeArtifact(env, await setSharing(env, user.id, id, { ...rest, expires_at: expires }));
		}),
	);

	server.registerTool(
		"delete_artifact",
		{
			title: "Delete artifact",
			description: "Permanently delete an artifact, all its versions and files. Its links stop working. Cannot be undone.",
			inputSchema: { id: z.string() },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		wrap(async ({ id }) => {
			const art = await getOwnedArtifact(env, user.id, id);
			await deleteArtifact(env, art.id);
			return { deleted: art.id, title: art.title };
		}),
	);

	return server;
}
