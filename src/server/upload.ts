import { Hono } from "hono";
import {
	ArtifactError,
	createArtifact,
	type FileInput,
	serializeArtifact,
	updateArtifact,
	type Visibility,
} from "./artifacts.ts";
import type { User } from "./auth.ts";
import { contentTypeFor } from "./mime.ts";
import { authenticateBearer, type TokenRow } from "./tokens.ts";

/**
 * Direct uploads for scripts and CLIs, so local files don't have to pass through a model's context.
 * Same access tokens as MCP (`Authorization: Bearer art_…`), multipart/form-data bodies:
 *
 *   POST /v1/artifacts       create: file (repeatable), title, description, entry, visibility, password, model, message
 *   POST /v1/artifacts/:id   new version: file, delete (repeatable), replace_all, title, description, entry, model, message
 *   GET  /v1/me              check a token
 *
 * Each `file` part's filename is its path inside the artifact (e.g. "js/app.js"); with curl, set it with
 * `-F "file=@js/app.js;filename=js/app.js"`, since curl otherwise sends only the base name.
 */
export const upload = new Hono<{ Bindings: Env; Variables: { user: User; token: TokenRow } }>();

upload.use("*", async (c, next) => {
	const auth = await authenticateBearer(c.env, c.req.raw, c.executionCtx as ExecutionContext);
	if (!auth) {
		return c.json({ error: `Unauthorized. Send "Authorization: Bearer <token>" (create one at ${c.env.APP_ORIGIN}/settings).` }, 401, {
			"www-authenticate": `Bearer realm="artifacts"`,
		});
	}
	c.set("user", auth.user);
	c.set("token", auth.token);
	await next();
});

upload.onError((err, c) => {
	if (err instanceof ArtifactError) return c.json({ error: err.message }, err.status);
	console.error("Upload error:", err);
	return c.json({ error: "Something went wrong" }, 500);
});

upload.get("/me", (c) => {
	const { user, token } = c.var;
	return c.json({ user: { id: user.id, email: user.email, name: user.name }, token: { name: token.name, prefix: token.prefix } });
});

upload.post("/artifacts", async (c) => {
	const form = await readForm(c.req.raw);
	const visibility = optional(form, "visibility");
	if (visibility !== undefined && !["private", "link", "password"].includes(visibility)) {
		throw new ArtifactError('visibility must be "private", "link" or "password"');
	}
	const files = await fileParts(form);
	if (!files.length) throw new ArtifactError("Attach at least one file");
	const art = await createArtifact(c.env, c.var.user.id, {
		title: optional(form, "title"),
		description: optional(form, "description"),
		entry: optional(form, "entry"),
		visibility: visibility as Visibility | undefined,
		password: optional(form, "password"),
		model: optional(form, "model"),
		message: optional(form, "message") ?? "Created",
		source: `cli:${c.var.token.name}`,
		files,
	});
	return c.json(serializeArtifact(c.env, art), 201);
});

upload.post("/artifacts/:id", async (c) => {
	const form = await readForm(c.req.raw);
	const art = await updateArtifact(c.env, c.var.user.id, c.req.param("id"), {
		files: await fileParts(form),
		delete_paths: form.getAll("delete").filter((v): v is string => typeof v === "string" && v !== ""),
		replace_all: ["1", "true", "yes"].includes(optional(form, "replace_all") ?? ""),
		title: optional(form, "title"),
		description: optional(form, "description"),
		entry: optional(form, "entry"),
		model: optional(form, "model"),
		message: optional(form, "message"),
		source: `cli:${c.var.token.name}`,
	});
	return c.json(serializeArtifact(c.env, art));
});

async function readForm(request: Request): Promise<FormData> {
	if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
		throw new ArtifactError("Send the request as multipart/form-data");
	}
	try {
		return await request.formData();
	} catch {
		throw new ArtifactError("Could not parse the multipart body");
	}
}

function optional(form: FormData, name: string): string | undefined {
	const v = form.get(name);
	return typeof v === "string" ? v : undefined;
}

async function fileParts(form: FormData): Promise<FileInput[]> {
	const out: FileInput[] = [];
	for (const part of form.getAll("file")) {
		if (typeof part === "string") throw new ArtifactError('"file" fields must be file uploads');
		const path = part.name;
		if (!path) throw new ArtifactError("Every file part needs a filename (its path in the artifact)");
		// The extension decides the type, as for MCP uploads; the client's type only fills in for unknown extensions.
		const type = part.type.split(";")[0].trim();
		out.push({
			path,
			bytes: new Uint8Array(await part.arrayBuffer()),
			content_type: contentTypeFor(path) === "application/octet-stream" && type ? part.type : undefined,
		});
	}
	return out;
}
