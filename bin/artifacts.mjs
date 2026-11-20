#!/usr/bin/env node
// Upload local files to Artifacts without passing them through a model's context.
// No dependencies; needs Node 22+. Run `node bin/artifacts.mjs help` for usage.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, openAsBlob, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_SERVER = "https://artifacts.cubityfir.st";
const MAX_FILE = 50 * 1024 * 1024;
// Cloudflare caps a Worker request body at 100 MB on Free/Pro plans.
const MAX_REQUEST = 95 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules"]);

const HELP = `artifacts: publish local files to Artifacts

Usage:
  artifacts upload <path>... [options]   Publish files/folders as a new artifact (prints its link)
  artifacts upload <path>... --to <id>   Add or replace files in an existing artifact (new version)
  artifacts whoami                       Check the stored token
  artifacts login                        Store a token (reads it from stdin)
  artifacts logout                       Forget the stored token

Paths:
  folder         its contents, keeping their paths inside it (dotfiles and node_modules are skipped)
  file           stored under its file name
  file=dest      stored as dest, e.g. "out/app.js=js/app.js"

Options:
  -t, --title <text>        Title (default: folder or file name)
  -d, --description <text>  One or two sentences
  -e, --entry <path>        File that opens first (default: index.html, README.md, then the first top-level file)
      --link                Anyone with the URL can open it (default: private)
      --password <pw>       URL + password
      --model <id>          Model that made it
  -m, --message <text>      Change note for version history
      --to <id>             Update this artifact instead of creating one
      --delete <path>       With --to: remove this file (repeatable)
      --replace-all         With --to: the new version holds only the uploaded files
      --json                Print the full JSON result
      --server <url>        Default: $ARTIFACTS_URL or ${DEFAULT_SERVER}

Token: $ARTIFACTS_TOKEN, else the one saved by "artifacts login" (Windows Credential Manager,
or ~/.config/artifacts/credentials.json elsewhere). Create tokens at <server>/settings.
Exit status: 0 success, 1 failure, 2 bad arguments.`;

class UsageError extends Error {}

const FLAGS = {
	"-t": "title", "--title": "title",
	"-d": "description", "--description": "description",
	"-e": "entry", "--entry": "entry",
	"--password": "password",
	"--model": "model",
	"-m": "message", "--message": "message",
	"--to": "to",
	"--delete": "delete",
	"--server": "server",
};
const SWITCHES = { "--link": "link", "--replace-all": "replace_all", "--json": "json", "-h": "help", "--help": "help" };

function parseArgs(argv) {
	const opts = { paths: [], delete: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			opts.paths.push(...argv.slice(i + 1));
			break;
		}
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		const flag = eq > 0 ? a.slice(0, eq) : a;
		if (FLAGS[flag]) {
			const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined) throw new UsageError(`${flag} needs a value`);
			if (FLAGS[flag] === "delete") opts.delete.push(value);
			else opts[FLAGS[flag]] = value;
		} else if (SWITCHES[a]) opts[SWITCHES[a]] = true;
		else if (a.startsWith("-") && a.length > 1) throw new UsageError(`Unknown option ${a}`);
		else opts.paths.push(a);
	}
	return opts;
}

function serverUrl(opts) {
	const raw = opts.server ?? process.env.ARTIFACTS_URL ?? DEFAULT_SERVER;
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new UsageError(`Invalid server URL: ${raw}`);
	}
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
		throw new UsageError("The server must use https (http is only allowed for localhost)");
	}
	return url.origin;
}

// ---------------------------------------------------------------------------
// Token storage

const credTarget = (origin) => `artifacts:${new URL(origin).host}`;
const credFile = () => join(homedir(), ".config", "artifacts", "credentials.json");

const PS_CRED = `
Add-Type -Namespace Art -Name Cred -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredDeleteW(string target, int type, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
'@
$M = [System.Runtime.InteropServices.Marshal]
`;

function powershell(script, input) {
	const res = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS_CRED + script, "utf16le").toString("base64")],
		{ input: input ?? "", encoding: "utf8", windowsHide: true },
	);
	if (res.error) throw res.error;
	return res;
}

function readToken(origin) {
	if (process.env.ARTIFACTS_TOKEN) return process.env.ARTIFACTS_TOKEN.trim();
	const target = credTarget(origin);
	if (process.platform === "win32") {
		const res = powershell(`
$p = [IntPtr]::Zero
if (-not [Art.Cred]::CredReadW('${target}', 1, 0, [ref]$p)) { exit 3 }
$c = $M::PtrToStructure($p, [type][Art.Cred+CREDENTIAL])
[Console]::Out.Write($M::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2))
[Art.Cred]::CredFree($p)`);
		return res.status === 0 && res.stdout ? res.stdout.trim() : null;
	}
	try {
		return JSON.parse(readFileSync(credFile(), "utf8"))[target] ?? null;
	} catch {
		return null;
	}
}

function saveToken(origin, token) {
	const target = credTarget(origin);
	if (process.platform === "win32") {
		const res = powershell(
			`
$tok = [Console]::In.ReadToEnd().Trim()
$bytes = [Text.Encoding]::Unicode.GetBytes($tok)
$c = New-Object Art.Cred+CREDENTIAL
$c.Type = 1; $c.TargetName = '${target}'; $c.UserName = 'token'; $c.Persist = 2
$c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = $M::AllocHGlobal($bytes.Length)
$M::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
$ok = [Art.Cred]::CredWriteW([ref]$c, 0)
$M::FreeHGlobal($c.CredentialBlob)
if (-not $ok) { exit 4 }`,
			token,
		);
		if (res.status !== 0) throw new Error(`Could not save to Windows Credential Manager (exit ${res.status})`);
		return `Windows Credential Manager (${target})`;
	}
	const file = credFile();
	let all = {};
	try {
		all = JSON.parse(readFileSync(file, "utf8"));
	} catch {}
	all[target] = token;
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
	chmodSync(file, 0o600);
	return file;
}

function deleteToken(origin) {
	const target = credTarget(origin);
	if (process.platform === "win32") {
		return powershell(`if (-not [Art.Cred]::CredDeleteW('${target}', 1, 0)) { exit 3 }`).status === 0;
	}
	try {
		const all = JSON.parse(readFileSync(credFile(), "utf8"));
		if (!(target in all)) return false;
		delete all[target];
		writeFileSync(credFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

function requireToken(origin) {
	const token = readToken(origin);
	if (!token) {
		throw new Error(`No token for ${origin}. Create one at ${origin}/settings, then pipe it into "artifacts login".`);
	}
	return token;
}

// ---------------------------------------------------------------------------
// HTTP

async function call(origin, token, method, path, body) {
	let res;
	try {
		res = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body });
	} catch (err) {
		throw new Error(`Could not reach ${origin}: ${err.cause?.message ?? err.message}`);
	}
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${origin} returned HTTP ${res.status}${res.status === 413 ? " (request too large)" : ""}`);
	}
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

// ---------------------------------------------------------------------------
// Commands

function collectFiles(args) {
	const files = [];
	const walk = (dir, root) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
			const full = join(dir, ent.name);
			if (ent.isDirectory()) walk(full, root);
			else if (ent.isFile()) files.push({ local: full, path: relative(root, full).split(sep).join("/") });
		}
	};
	for (const arg of args) {
		// "local=dest" renames; a bare path containing "=" still works when the file exists.
		let local = arg;
		let dest;
		const eq = arg.lastIndexOf("=");
		if (eq > 0) {
			try {
				statSync(arg);
			} catch {
				local = arg.slice(0, eq);
				dest = arg.slice(eq + 1);
			}
		}
		let st;
		try {
			st = statSync(local);
		} catch {
			throw new UsageError(`No such file or folder: ${local}`);
		}
		if (st.isDirectory()) {
			if (dest !== undefined) throw new UsageError(`Can't rename a folder (${arg})`);
			walk(resolve(local), resolve(local));
		} else {
			files.push({ local: resolve(local), path: (dest ?? basename(local)).replace(/\\/g, "/") });
		}
	}
	const seen = new Map();
	let total = 0;
	for (const f of files) {
		if (isAbsolute(f.path) || f.path.split("/").includes("..")) throw new UsageError(`Bad destination path: ${f.path}`);
		if (seen.has(f.path)) throw new UsageError(`Two files map to "${f.path}": ${seen.get(f.path)} and ${f.local}`);
		seen.set(f.path, f.local);
		f.size = statSync(f.local).size;
		if (f.size > MAX_FILE) throw new UsageError(`${f.local} is over the 50 MB per-file limit`);
		total += f.size;
	}
	if (total > MAX_REQUEST) throw new UsageError(`Total upload is ${mb(total)}; one upload can be at most ${mb(MAX_REQUEST)}`);
	return files;
}

function defaultTitle(args) {
	if (args.length !== 1) return undefined;
	const local = args[0].includes("=") ? args[0].slice(args[0].lastIndexOf("=") + 1) : args[0];
	const name = basename(resolve(local));
	return name.slice(0, name.length - extname(name).length) || name;
}

async function upload(opts) {
	if (!opts.paths.length) throw new UsageError("Give at least one file or folder to upload");
	if (opts.link && opts.password) throw new UsageError("Use --link or --password, not both");
	if (opts.to && (opts.link || opts.password)) {
		throw new UsageError("--link/--password only apply when creating; change sharing on the dashboard or over MCP");
	}
	if (!opts.to && (opts.delete.length || opts.replace_all)) throw new UsageError("--delete and --replace-all need --to <id>");
	const origin = serverUrl(opts);
	const files = collectFiles(opts.paths);
	if (!files.length) throw new UsageError("No files found (dotfiles and node_modules are skipped)");
	const token = requireToken(origin);

	const form = new FormData();
	const field = (name, value) => value !== undefined && form.append(name, String(value));
	field("title", opts.title ?? (opts.to ? undefined : defaultTitle(opts.paths)));
	field("description", opts.description);
	field("entry", opts.entry);
	field("model", opts.model);
	field("message", opts.message);
	if (opts.to) {
		for (const p of opts.delete) field("delete", p);
		if (opts.replace_all) field("replace_all", "true");
	} else {
		field("visibility", opts.password ? "password" : opts.link ? "link" : "private");
		field("password", opts.password);
	}
	for (const f of files) form.append("file", await openAsBlob(f.local), f.path);

	const art = opts.to
		? await call(origin, token, "POST", `/v1/artifacts/${encodeURIComponent(opts.to)}`, form)
		: await call(origin, token, "POST", "/v1/artifacts", form);
	if (opts.json) {
		console.log(JSON.stringify(art, null, 2));
	} else {
		const total = files.reduce((n, f) => n + f.size, 0);
		console.error(
			`${opts.to ? "Updated" : "Published"} "${art.title}" (${art.id}, v${art.version}, ${art.visibility}): ` +
				`${files.length} file${files.length === 1 ? "" : "s"}, ${mb(total)}`,
		);
		console.log(art.url ?? art.dashboard_url);
	}
}

async function readStdin() {
	if (process.stdin.isTTY) {
		process.stderr.write("Paste the token, then press Enter: ");
		process.stdin.setRawMode?.(false);
		return await new Promise((done) => process.stdin.once("data", (d) => done(String(d))));
	}
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}

async function login(opts) {
	const origin = serverUrl(opts);
	const token = (await readStdin()).trim();
	if (!/^art_[0-9A-Za-z]{20,}$/.test(token)) throw new Error("That doesn't look like an Artifacts token (art_…)");
	const me = await call(origin, token, "GET", "/v1/me");
	const where = saveToken(origin, token);
	console.error(`Signed in to ${origin} as ${me.user.email || me.user.name} (token "${me.token.name}"); saved in ${where}`);
}

async function whoami(opts) {
	const origin = serverUrl(opts);
	const me = await call(origin, requireToken(origin), "GET", "/v1/me");
	console.log(`${me.user.email || me.user.name} on ${origin} (token "${me.token.name}", ${me.token.prefix}…)`);
}

function logout(opts) {
	const origin = serverUrl(opts);
	console.error(deleteToken(origin) ? `Removed the token for ${origin}` : `No stored token for ${origin}`);
}

function mb(bytes) {
	return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const [command = "help", ...rest] = process.argv.slice(2);
try {
	const opts = parseArgs(rest);
	if (opts.help || command === "help" || command === "-h" || command === "--help") console.log(HELP);
	else if (command === "upload") await upload(opts);
	else if (command === "login") await login(opts);
	else if (command === "logout") logout(opts);
	else if (command === "whoami") await whoami(opts);
	else throw new UsageError(`Unknown command "${command}" (try "artifacts help")`);
} catch (err) {
	console.error(`artifacts: ${err.message}`);
	process.exitCode = err instanceof UsageError ? 2 : 1;
}
