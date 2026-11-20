/**
 * D1 schema, applied lazily by the Worker itself (once per isolate) so local dev,
 * previews and production all converge without a separate migration step.
 * Append new migrations to the end; never edit a shipped one.
 */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			sub TEXT NOT NULL UNIQUE,
			email TEXT,
			email_verified INTEGER NOT NULL DEFAULT 0,
			name TEXT,
			picture TEXT,
			roles TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			last_login_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			id_token TEXT,
			claims TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
		`CREATE TABLE IF NOT EXISTS auth_flows (
			id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			nonce TEXT NOT NULL,
			code_verifier TEXT NOT NULL,
			return_to TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			prefix TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id)`,
		`CREATE TABLE IF NOT EXISTS artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			slug TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			entry TEXT NOT NULL,
			visibility TEXT NOT NULL DEFAULT 'private',
			password_hash TEXT,
			share_epoch INTEGER NOT NULL DEFAULT 0,
			expires_at INTEGER,
			current_version INTEGER NOT NULL,
			size_bytes INTEGER NOT NULL DEFAULT 0,
			file_count INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS artifacts_user_updated ON artifacts(user_id, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS artifact_versions (
			artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
			version INTEGER NOT NULL,
			entry TEXT NOT NULL,
			kind TEXT NOT NULL,
			message TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (artifact_id, version)
		)`,
		`CREATE TABLE IF NOT EXISTS artifact_files (
			artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
			version INTEGER NOT NULL,
			path TEXT NOT NULL,
			content_type TEXT NOT NULL,
			size INTEGER NOT NULL,
			sha256 TEXT NOT NULL,
			PRIMARY KEY (artifact_id, version, path)
		)`,
		`CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	],
];

let ready: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
	ready ??= migrate(db).catch((err) => {
		ready = undefined;
		throw err;
	});
	return ready;
}

async function migrate(db: D1Database) {
	await db.prepare(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`).run();
	const row = await db.prepare(`SELECT MAX(version) AS v FROM schema_version`).first<{ v: number | null }>();
	const current = row?.v ?? 0;
	for (let i = current; i < MIGRATIONS.length; i++) {
		await db.batch([
			...MIGRATIONS[i].map((sql) => db.prepare(sql)),
			db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).bind(i + 1),
		]);
	}
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(key, value)
		.run();
}
