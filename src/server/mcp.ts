import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import {
	ArtifactError,
	blobKey,
	createArtifact,
	editArtifactFile,
	getOwnedArtifact,
	LIMITS,
	listArtifacts,
	listFiles,
	listVersions,
	restoreVersion,
	serializeArtifact,
	setSharing,
	TRASH_TTL_MS,
	trashArtifact,
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
	let body: BodyInit | null = response.body;
	if (response.headers.get("content-type")?.includes("application/json")) {
		const text = await response.text();
		body = text.includes('"tools"') ? slimToolList(text) : text;
		headers.delete("content-length");
	}
	return new Response(body, { status: response.status, headers });
}

// Every tools/list goes into each client's context, so drop SDK boilerplate the model doesn't need:
// `$schema`, `execution.taskSupport`, and zod's ±2^53 bounds on integers.
function slimToolList(text: string): string {
	let msg: { result?: { tools?: Array<Record<string, unknown>> } };
	try {
		msg = JSON.parse(text);
	} catch {
		return text;
	}
	const tools = msg.result?.tools;
	if (!Array.isArray(tools)) return text;
	const clean = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		delete o.$schema;
		if (o.minimum === Number.MIN_SAFE_INTEGER) delete o.minimum;
		if (o.maximum === Number.MAX_SAFE_INTEGER) delete o.maximum;
		for (const v of Object.values(o)) clean(v);
	};
	for (const tool of tools) {
		delete tool.execution;
		clean(tool.inputSchema);
	}
	return JSON.stringify(msg);
}

const fileSchema = z.object({
	path: z.string().describe('Relative path, e.g. "index.html", "assets/app.js".'),
	content: z.string().optional().describe('Text, or base64 if encoding is "base64". Omit when using url.'),
	encoding: z.enum(["utf8", "base64"]).optional().describe('"base64" for binary. Default "utf8".'),
	url: z.string().optional().describe("http(s) URL to fetch instead of content (good for large media)."),
	content_type: z.string().optional().describe("MIME type. Default: from the extension."),
});

const VISIBILITY = ["private", "link", "password"] as const;
const VISIBILITY_TEXT = '"private" (owner only), "link" (anyone with the URL) or "password" (URL + password).';
const MODEL_TEXT = "Your model id.";
const MESSAGE_TEXT = "Change note for version history.";

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
			instructions:
				"Hosts files and sites you publish for the user to view and share. Create with publish_artifact; change with " +
				"edit_artifact_file (text find/replace) or update_artifact (files, title, entry). File changes create a new version. " +
				'Link site files with relative URLs ("style.css", not "/style.css").',
		},
	);
	const source = `mcp:${token.name}`;

	server.registerTool(
		"publish_artifact",
		{
			title: "Publish artifact",
			description:
				"Publish a new artifact: one file or a multi-file site (HTML, Markdown, images, media, PDF, data, code). " +
				`Max ${LIMITS.maxFileBytes / 1024 / 1024} MB per file, ${LIMITS.maxArtifactBytes / 1024 / 1024} MB total. ` +
				"Returns id, dashboard_url, and url if shared.",
			inputSchema: {
				title: z.string().describe("Short title."),
				description: z.string().optional().describe("One or two sentences."),
				files: z.array(fileSchema).min(1),
				entry: z.string().optional().describe("File that opens first. Default: index.html, README.md, then the first top-level file."),
				visibility: z
					.enum(VISIBILITY)
					.optional()
					.describe('Default "private" (owner only). "link": anyone with the URL. "password": URL + password.'),
				password: z.string().optional().describe('Required for "password".'),
				model: z.string().optional().describe(MODEL_TEXT),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
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
				"Add/replace files, delete files, and/or change title, description or entry. Unlisted files are kept unless replace_all. " +
				"Changing files or entry creates a version; title/description alone doesn't. Roll back with restore_version.",
			inputSchema: {
				id: z.string(),
				files: z.array(fileSchema).optional().describe("Files to add or overwrite."),
				delete_paths: z.array(z.string()).optional(),
				replace_all: z.boolean().optional().describe("New version contains only `files`."),
				restore_version: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Roll back: new version copying this version's files and entry. Only message and model may accompany it."),
				title: z.string().optional(),
				description: z.string().optional(),
				entry: z.string().optional().describe("File that opens first; must exist."),
				message: z.string().optional().describe(MESSAGE_TEXT),
				model: z.string().optional().describe(MODEL_TEXT),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		wrap(async ({ id, restore_version, ...args }) => {
			if (restore_version === undefined) {
				return serializeArtifact(env, await updateArtifact(env, user.id, id, { ...args, source }));
			}
			const { message, model, files, delete_paths, replace_all, entry, title, description } = args;
			if (files?.length || delete_paths?.length || replace_all || entry !== undefined || title !== undefined || description !== undefined) {
				throw new ArtifactError("restore_version can only be combined with message and model");
			}
			return serializeArtifact(env, await restoreVersion(env, user.id, id, restore_version, { message, model, source }));
		}),
	);

	server.registerTool(
		"edit_artifact_file",
		{
			title: "Edit artifact file",
			description:
				"Exact find-and-replace in one text file, creating a new version. Each old_str must match exactly once " +
				"(add context to make it unique). Edits apply in order, all or nothing.",
			inputSchema: {
				id: z.string(),
				path: z.string(),
				edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).min(1),
				message: z.string().optional().describe(MESSAGE_TEXT),
				model: z.string().optional().describe(MODEL_TEXT),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		wrap(async ({ id, path, edits, message, model }) =>
			serializeArtifact(env, await editArtifactFile(env, user.id, id, path, edits, { message, source, model })),
		),
	);

	server.registerTool(
		"get_artifact",
		{
			title: "Get artifact",
			description: "Get metadata, file list and version history. Use include_content to read text files.",
			inputSchema: {
				id: z.string(),
				include_content: z
					.union([z.boolean(), z.array(z.string())])
					.optional()
					.describe("true for all text files (200 KB max total), or a list of paths."),
				version: z.number().int().min(1).optional().describe("Version number (1 = first). Default: current."),
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
			description: "List or search your artifacts, most recently updated first. Returns total for paging.",
			inputSchema: {
				query: z.string().optional().describe("Substring of title, description or entry file name."),
				kind: z
					.enum(["html", "markdown", "image", "video", "audio", "pdf", "code", "text", "data", "file"])
					.optional(),
				limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
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
				"Change who can open an artifact. Omitted fields keep their current values; leaving \"password\" clears the password. " +
				"Returns the current url.",
			inputSchema: {
				id: z.string(),
				visibility: z.enum(VISIBILITY).optional().describe(VISIBILITY_TEXT),
				password: z.string().optional().describe('Required when switching to "password".'),
				expires_at: z.string().nullable().optional().describe("ISO 8601 time when sharing stops; null = never."),
				regenerate_link: z.boolean().optional().describe("New URL; the old one and unlocked links stop working."),
			},
			annotations: { destructiveHint: true, idempotentHint: false },
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
			description: "Moves to trash; links stop working. Restorable for 30 days from the dashboard.",
			inputSchema: { id: z.string() },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		wrap(async ({ id }) => {
			const art = await trashArtifact(env, user.id, id);
			return { deleted: art.id, title: art.title, purge_at: new Date(art.deleted_at! + TRASH_TTL_MS).toISOString() };
		}),
	);

	return server;
}
