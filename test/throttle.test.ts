import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setSharing } from "../src/server/artifacts.ts";
import { hashPassword, signToken } from "../src/server/crypto.ts";
import { ensureSchema } from "../src/server/db.ts";
import {
	ARTIFACT_CEILING,
	ARTIFACT_WINDOW_MS,
	BASE_LOCK_MS,
	beginAttempt,
	clientPrefix,
	FREE_ATTEMPTS,
	lockoutMs,
	MAX_LOCK_MS,
	prunePasswordAttempts,
	recentFailures,
	recordFailure,
	recordSuccess,
} from "../src/server/throttle.ts";

const USER = "u_throttle";
const ART = "a_throttle";
const SLUG = "throttleslug1";
const PASSWORD = "correct horse";
const IP = "203.0.113.7";

beforeAll(async () => {
	await ensureSchema(env.DB);
	await env.DB.batch([
		env.DB.prepare(`INSERT OR IGNORE INTO users (id, sub, created_at, last_login_at) VALUES (?, ?, 0, 0)`).bind(USER, "sub-throttle"),
		env.DB.prepare(
			`INSERT OR IGNORE INTO artifacts (id, user_id, slug, title, kind, entry, visibility, password_hash, current_version, created_at, updated_at)
			 VALUES (?, ?, ?, 'Secret page', 'html', 'index.html', 'password', ?, 1, 0, 0)`,
		).bind(ART, USER, SLUG, await hashPassword(PASSWORD)),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM password_throttle`),
		env.DB.prepare(`DELETE FROM password_failures`),
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A wrong guess through the throttle, as content.ts does it (minus the hash). */
async function fail(ip: string, now: number) {
	const a = await beginAttempt(env, ART, ip, now);
	if (a.allowed) await recordFailure(env, a, now);
	return a;
}

describe("lockoutMs", () => {
	it("gives FREE_ATTEMPTS free failures, then doubles up to the cap", () => {
		for (let n = 0; n < FREE_ATTEMPTS; n++) expect(lockoutMs(n)).toBe(0);
		expect(lockoutMs(FREE_ATTEMPTS)).toBe(BASE_LOCK_MS);
		expect(lockoutMs(FREE_ATTEMPTS + 1)).toBe(BASE_LOCK_MS * 2);
		expect(lockoutMs(FREE_ATTEMPTS + 2)).toBe(BASE_LOCK_MS * 4);
		expect(lockoutMs(FREE_ATTEMPTS + 50)).toBe(MAX_LOCK_MS);
	});
});

describe("clientPrefix", () => {
	it("keeps IPv4 whole and truncates IPv6 to its /64", () => {
		expect(clientPrefix("203.0.113.7")).toBe("203.0.113.7");
		expect(clientPrefix("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2");
		expect(clientPrefix("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2");
		expect(clientPrefix("2001:db8::1")).toBe("2001:db8:0:0");
		expect(clientPrefix("::ffff:198.51.100.4")).toBe("198.51.100.4");
	});
});

describe("beginAttempt", () => {
	it("allows the free attempts, then locks with escalating lockouts that expire", async () => {
		let now = 1_000_000_000_000;
		for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await fail(IP, now)).allowed).toBe(true);

		// Locked for BASE_LOCK_MS after the 5th failure.
		let blocked = await beginAttempt(env, ART, IP, now + 1);
		expect(blocked).toEqual({ allowed: false, retryAfterMs: BASE_LOCK_MS - 1 });

		// Once it expires, one more attempt is allowed and the next lockout is twice as long.
		now += BASE_LOCK_MS;
		expect((await fail(IP, now)).allowed).toBe(true);
		blocked = await beginAttempt(env, ART, IP, now);
		expect(blocked).toEqual({ allowed: false, retryAfterMs: BASE_LOCK_MS * 2 });
		now += BASE_LOCK_MS * 2;
		expect((await fail(IP, now)).allowed).toBe(true);
		expect(await beginAttempt(env, ART, IP, now)).toEqual({ allowed: false, retryAfterMs: BASE_LOCK_MS * 4 });

		// Blocked attempts don't extend the lockout.
		expect(await beginAttempt(env, ART, IP, now + 1000)).toEqual({ allowed: false, retryAfterMs: BASE_LOCK_MS * 4 - 1000 });

		// Another client is unaffected.
		expect((await beginAttempt(env, ART, "198.51.100.9", now)).allowed).toBe(true);
	});

	it("caps the lockout", async () => {
		let now = 1_000_000_000_000;
		const waits: number[] = [];
		for (let i = 0; i < 20; i++) {
			expect((await fail(IP, now)).allowed).toBe(true);
			const next = await beginAttempt(env, ART, IP, now);
			if (!next.allowed) {
				waits.push(next.retryAfterMs);
				now += next.retryAfterMs;
			}
		}
		expect(waits.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 32, 60].map((m) => m * 60_000));
		expect(new Set(waits.slice(6))).toEqual(new Set([MAX_LOCK_MS]));
	});

	it("blocks a parallel burst after the free attempts", async () => {
		const now = 1_000_000_000_000;
		const results = await Promise.all(Array.from({ length: 20 }, () => beginAttempt(env, ART, IP, now)));
		expect(results.filter((r) => r.allowed)).toHaveLength(FREE_ATTEMPTS);
	});

	it("success clears the client's counter", async () => {
		const now = 1_000_000_000_000;
		for (let i = 0; i < FREE_ATTEMPTS - 1; i++) await fail(IP, now);
		const ok = await beginAttempt(env, ART, IP, now);
		expect(ok.allowed).toBe(true);
		if (ok.allowed) await recordSuccess(env, ok);
		// A full set of free attempts again.
		for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await fail(IP, now)).allowed).toBe(true);
		expect((await beginAttempt(env, ART, IP, now)).allowed).toBe(false);
	});

	it("forgets failures after a day without attempts", async () => {
		const now = 1_000_000_000_000;
		for (let i = 0; i < FREE_ATTEMPTS; i++) await fail(IP, now);
		const later = now + 24 * 60 * 60_000;
		for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await fail(IP, later)).allowed).toBe(true);
	});

	it("applies an artifact-wide ceiling that still lets a new visitor try once, and ends with the window", async () => {
		const now = 1_000_000_000_000;
		// Spread the ceiling's worth of failures over many addresses, a few each.
		for (let i = 0; i < ARTIFACT_CEILING; i++) await fail(`192.0.2.${Math.floor(i / 3)}`, now);

		// An address that already guessed now waits for the window to end, and its own counter isn't charged.
		const seen = await beginAttempt(env, ART, "192.0.2.0", now + 60_000);
		expect(seen).toEqual({ allowed: false, retryAfterMs: ARTIFACT_WINDOW_MS - 60_000 });
		const row = await env.DB.prepare(`SELECT failures FROM password_throttle WHERE client != '*' ORDER BY failures DESC LIMIT 1`).first<{
			failures: number;
		}>();
		expect(row?.failures).toBe(3);

		// A visitor making their first attempt still gets it.
		expect((await beginAttempt(env, ART, "198.51.100.1", now + 60_000)).allowed).toBe(true);

		// After the window, the address that already guessed can try again.
		expect((await beginAttempt(env, ART, "192.0.2.0", now + ARTIFACT_WINDOW_MS)).allowed).toBe(true);
	});
});

describe("owner summary and cleanup", () => {
	it("counts failures in the last 24 hours, and a password change resets them", async () => {
		const now = Date.now();
		await fail(IP, now - 30 * 60 * 60_000); // too old
		await fail(IP, now - 60_000);
		await fail("198.51.100.2", now);
		expect(await recentFailures(env, ART, now)).toBe(2);

		await setSharing(env, USER, ART, { password: "a new one" });
		expect(await recentFailures(env, ART, now)).toBe(0);
		const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM password_throttle`).first<{ n: number }>();
		expect(left?.n).toBe(0);
		await setSharing(env, USER, ART, { password: PASSWORD });
	});

	it("leaves the counters alone when sharing changes without a new password", async () => {
		const now = Date.now();
		await fail(IP, now);
		await setSharing(env, USER, ART, { expires_at: null });
		expect(await recentFailures(env, ART, now)).toBe(1);
	});

	it("prunes idle counters and old failure buckets", async () => {
		const now = 1_000_000_000_000;
		await fail(IP, now);
		await fail("198.51.100.3", now + 2 * 24 * 60 * 60_000);
		await env.DB.batch(prunePasswordAttempts(env.DB, now + 2 * 24 * 60 * 60_000));
		const { results } = await env.DB.prepare(`SELECT updated_at FROM password_throttle`).all<{ updated_at: number }>();
		expect(results.every((r) => r.updated_at === now + 2 * 24 * 60 * 60_000)).toBe(true);
		const buckets = await env.DB.prepare(`SELECT COUNT(*) AS n FROM password_failures`).first<{ n: number }>();
		expect(buckets?.n).toBe(1);
	});
});

describe("password form on the content origin", () => {
	const url = () => `${env.CONTENT_ORIGIN}/${SLUG}/`;
	const post = (password: string, ip = IP) =>
		exports.default.fetch(
			new Request(url(), {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
				body: new URLSearchParams({ password }),
				redirect: "manual",
			}),
		);

	it("returns 429 with Retry-After and skips PBKDF2 once locked, then accepts the right password after the lockout", async () => {
		const derive = vi.spyOn(crypto.subtle, "deriveBits");
		for (let i = 0; i < FREE_ATTEMPTS; i++) {
			const res = await post("wrong");
			expect(res.status).toBe(401);
			expect(await res.text()).toContain("That password isn&#39;t right.");
		}
		expect(derive).toHaveBeenCalledTimes(FREE_ATTEMPTS);

		// Locked: even the right password is refused, and no hash runs.
		const res = await post(PASSWORD);
		expect(res.status).toBe(429);
		const retryAfter = Number(res.headers.get("retry-after"));
		expect(retryAfter).toBeGreaterThan(BASE_LOCK_MS / 1000 - 5);
		expect(retryAfter).toBeLessThanOrEqual(BASE_LOCK_MS / 1000);
		const body = await res.text();
		expect(body).toContain("Too many attempts. Try again in 1 minute.");
		expect(body).toContain('name="password"');
		expect(derive).toHaveBeenCalledTimes(FREE_ATTEMPTS);

		// After the lockout ends, the right password works and clears the counter.
		await env.DB.prepare(`UPDATE password_throttle SET locked_until = 0 WHERE client != '*'`).run();
		const ok = await post(PASSWORD);
		expect(ok.status).toBe(303);
		expect(ok.headers.get("location")).toMatch(/\/t\/[^/]+\/$/);
		const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM password_throttle WHERE client != '*'`).first<{ n: number }>();
		expect(left?.n).toBe(0);
	});

	it("words longer waits in minutes", async () => {
		// Eight failures, skipping each lockout as it comes; the ninth earns a 16-minute lockout.
		for (let i = 0; i < FREE_ATTEMPTS + 3; i++) {
			await post("wrong");
			await env.DB.prepare(`UPDATE password_throttle SET locked_until = 0 WHERE client != '*'`).run();
		}
		const res = await post("wrong");
		expect(res.status).toBe(401);
		const locked = await post("wrong");
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(15 * 60 - 5);
		expect(await locked.text()).toContain("Try again in 16 minutes.");
	});

	it("never throttles the owner's capability URL", async () => {
		for (let i = 0; i < FREE_ATTEMPTS + 1; i++) await post("wrong");
		expect((await post("wrong")).status).toBe(429);
		const art = await env.DB.prepare(`SELECT share_epoch FROM artifacts WHERE id = ?`).bind(ART).first<{ share_epoch: number }>();
		const t = await signToken(env.SESSION_SECRET, { a: ART, v: 0, s: art!.share_epoch, e: Date.now() + 60_000 });
		const res = await exports.default.fetch(new Request(`${env.CONTENT_ORIGIN}/t/${t}/`, { headers: { "cf-connecting-ip": IP } }));
		// No files were uploaded for the fixture, so the file lookup 404s; the point is that it isn't a 429 or the gate.
		expect(res.status).not.toBe(429);
		expect(await res.text()).not.toContain('name="password"');
	});
});
