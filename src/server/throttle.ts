import { hmac, randomId } from "./crypto.ts";

/**
 * Attempt limiting for the password form on shared links (see content.ts).
 *
 * Every check happens in D1 *before* PBKDF2 runs, so a blocked guess costs one small query, not a hash.
 * An attempt is reserved up front with a single atomic UPSERT and refunded on success. Because D1 runs
 * statements one at a time, a burst of parallel requests from one client can't all slip past the check
 * before the first failure is recorded.
 *
 * Two layers:
 *  - Per (artifact, client): FREE_ATTEMPTS free attempts, then a lockout that doubles with each further
 *    failure, from BASE_LOCK_MS up to MAX_LOCK_MS. The count decays after FORGET_AFTER_MS without attempts.
 *  - Per artifact: at most ARTIFACT_CEILING attempts per fixed ARTIFACT_WINDOW_MS window across all clients.
 *    Past it, clients that already guessed in the last day wait for the window to end; a client making
 *    its first attempt still gets that one try. A flood from many addresses therefore can't lock a
 *    visitor with the right password out, and nobody waits longer than one window.
 *
 * Clients are identified by an HMAC of their IP (IPv6 truncated to its /64), keyed per artifact, so no raw
 * addresses are stored and the same visitor can't be linked across artifacts.
 */
export const FREE_ATTEMPTS = 5;
export const BASE_LOCK_MS = 60_000;
export const MAX_LOCK_MS = 60 * 60_000;
export const FORGET_AFTER_MS = 24 * 60 * 60_000;
export const ARTIFACT_CEILING = 60;
export const ARTIFACT_WINDOW_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
/** The artifact-wide counter's client key. Real keys are base64url HMACs, which never contain "*". */
const ARTIFACT_KEY = "*";

export type Attempt =
	| { allowed: false; retryAfterMs: number }
	| { allowed: true; artifactId: string; client: string; nonce: string };

/** Lockout applied after the given number of failures in a row (0 while within the free attempts). */
export function lockoutMs(failures: number): number {
	if (failures < FREE_ATTEMPTS) return 0;
	return Math.min(BASE_LOCK_MS * 2 ** Math.min(failures - FREE_ATTEMPTS, 20), MAX_LOCK_MS);
}

/** The part of an IP address that identifies a client: the whole IPv4 address, or an IPv6 /64. */
export function clientPrefix(ip: string): string {
	if (!ip.includes(":")) return ip;
	const [head, tail = ""] = ip.toLowerCase().split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	// IPv4-mapped / embedded IPv4 (::ffff:1.2.3.4): treat it as the IPv4 address.
	const last = right.at(-1) ?? left.at(-1) ?? "";
	if (last.includes(".")) return last;
	const groups = ip.includes("::") ? [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right] : left;
	return groups
		.slice(0, 4)
		.map((g) => g.replace(/^0+(?=.)/, ""))
		.join(":");
}

export async function clientKey(secret: string, artifactId: string, ip: string): Promise<string> {
	return (await hmac(secret, `pw-throttle:${artifactId}:${clientPrefix(ip)}`)).slice(0, 22);
}

/**
 * Reserves one password attempt for this client, or says how long it must wait. Call before verifying
 * the password, then report the outcome with recordFailure / recordSuccess.
 */
export async function beginAttempt(env: Env, artifactId: string, ip: string, now = Date.now()): Promise<Attempt> {
	const client = await clientKey(env.SESSION_SECRET, artifactId, ip);
	const nonce = randomId(12);

	// Per-client: count this attempt and set the lockout for the next one, unless a lockout is running,
	// in which case nothing changes. `nonce` comes back only if this statement took the attempt.
	// (SQLite evaluates every SET expression against the old row.) The lockout is set here, for the
	// *next* attempt, so concurrent requests are blocked while this one's hash is still running.
	const row = await env.DB.prepare(
		`INSERT INTO password_throttle (artifact_id, client, failures, locked_until, updated_at, nonce)
		 VALUES (?1, ?2, 1, ?3, ?4, ?5)
		 ON CONFLICT (artifact_id, client) DO UPDATE SET
		   failures = CASE WHEN locked_until > ?4 THEN failures WHEN updated_at <= ?4 - ?6 THEN 1 ELSE failures + 1 END,
		   locked_until = CASE
		     WHEN locked_until > ?4 THEN locked_until
		     WHEN updated_at <= ?4 - ?6 THEN ?3
		     WHEN failures + 1 < ?7 THEN 0
		     ELSE ?4 + MIN(?8 * (1 << MIN(failures + 1 - ?7, 20)), ?9) END,
		   nonce = CASE WHEN locked_until > ?4 THEN nonce ELSE ?5 END,
		   updated_at = CASE WHEN locked_until > ?4 THEN updated_at ELSE ?4 END
		 RETURNING failures, locked_until, nonce`,
	)
		.bind(artifactId, client, lockoutMs(1) && now + lockoutMs(1), now, nonce, FORGET_AFTER_MS, FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS)
		.first<{ failures: number; locked_until: number; nonce: string }>();
	if (!row || row.nonce !== nonce) return { allowed: false, retryAfterMs: Math.max((row?.locked_until ?? now) - now, 1000) };

	// Artifact-wide: count the attempt in the current fixed window.
	const art = await env.DB.prepare(
		`INSERT INTO password_throttle (artifact_id, client, failures, locked_until, updated_at, nonce)
		 VALUES (?1, ?2, 1, 0, ?3, '')
		 ON CONFLICT (artifact_id, client) DO UPDATE SET
		   failures = CASE WHEN updated_at <= ?3 - ?4 THEN 1 ELSE failures + 1 END,
		   updated_at = CASE WHEN updated_at <= ?3 - ?4 THEN ?3 ELSE updated_at END
		 RETURNING failures, updated_at`,
	)
		.bind(artifactId, ARTIFACT_KEY, now, ARTIFACT_WINDOW_MS)
		.first<{ failures: number; updated_at: number }>();
	const firstTry = row.failures === 1;
	if (art && art.failures > ARTIFACT_CEILING && !firstTry) {
		// Blocked by the artifact-wide ceiling, not by this client's own record: hand the attempt back.
		await env.DB.prepare(
			`UPDATE password_throttle SET failures = failures - 1, locked_until = 0
			 WHERE artifact_id = ? AND client = ? AND nonce = ?`,
		)
			.bind(artifactId, client, nonce)
			.run();
		return { allowed: false, retryAfterMs: Math.max(art.updated_at + ARTIFACT_WINDOW_MS - now, 1000) };
	}
	return { allowed: true, artifactId, client, nonce };
}

/** The password was wrong: the reserved attempt stands. Also counts it for the owner's 24-hour summary. */
export async function recordFailure(env: Env, attempt: Extract<Attempt, { allowed: true }>, now = Date.now()) {
	await env.DB.prepare(
		`INSERT INTO password_failures (artifact_id, hour, n) VALUES (?, ?, 1)
		 ON CONFLICT (artifact_id, hour) DO UPDATE SET n = n + 1`,
	)
		.bind(attempt.artifactId, Math.floor(now / HOUR_MS) * HOUR_MS)
		.run();
}

/** The password was right: clear this client's record and hand back its slot in the artifact-wide window. */
export async function recordSuccess(env: Env, attempt: Extract<Attempt, { allowed: true }>) {
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM password_throttle WHERE artifact_id = ? AND client = ?`).bind(attempt.artifactId, attempt.client),
		env.DB.prepare(
			`UPDATE password_throttle SET failures = MAX(failures - 1, 0) WHERE artifact_id = ? AND client = ?`,
		).bind(attempt.artifactId, ARTIFACT_KEY),
	]);
}

/** Wrong passwords entered for this artifact in the last 24 hours (by hour bucket, so up to 25 hours). */
export async function recentFailures(env: Env, artifactId: string, now = Date.now()): Promise<number> {
	const row = await env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM password_failures WHERE artifact_id = ? AND hour > ?`)
		.bind(artifactId, now - FORGET_AFTER_MS - HOUR_MS)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Forget all attempts for an artifact, e.g. after its password changes. */
export function resetPasswordAttempts(db: D1Database, artifactId: string): D1PreparedStatement[] {
	return [
		db.prepare(`DELETE FROM password_throttle WHERE artifact_id = ?`).bind(artifactId),
		db.prepare(`DELETE FROM password_failures WHERE artifact_id = ?`).bind(artifactId),
	];
}

/** Hourly cleanup: drop counters nobody has touched for a day. Lockouts never outlast that. */
export function prunePasswordAttempts(db: D1Database, now = Date.now()): D1PreparedStatement[] {
	return [
		db.prepare(`DELETE FROM password_throttle WHERE updated_at <= ? AND locked_until <= ?`).bind(now - FORGET_AFTER_MS, now),
		db.prepare(`DELETE FROM password_failures WHERE hour <= ?`).bind(now - FORGET_AFTER_MS - HOUR_MS),
	];
}
