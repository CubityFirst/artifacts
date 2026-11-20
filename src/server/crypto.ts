const enc = new TextEncoder();

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Unbiased random base62 string. */
export function randomId(length = 16): string {
	const out: string[] = [];
	while (out.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const b of bytes) {
			if (b < 248 && out.length < length) out.push(ALPHABET[b % 62]);
		}
	}
	return out.join("");
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
	const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
	const input = typeof data === "string" ? enc.encode(data) : data;
	return toHex(await crypto.subtle.digest("SHA-256", input));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.length !== bb.length) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
	let key = hmacKeys.get(secret);
	if (!key) {
		key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
			"verify",
		]);
		hmacKeys.set(secret, key);
	}
	return key;
}

export async function hmac(secret: string, message: string): Promise<string> {
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
	return b64url(new Uint8Array(sig));
}

/** Signs a small JSON payload into a URL-safe token: base64url(json).sig */
export async function signToken(secret: string, payload: object): Promise<string> {
	const body = b64url(enc.encode(JSON.stringify(payload)));
	return `${body}.${await hmac(secret, body)}`;
}

export async function verifyToken<T>(secret: string, token: string): Promise<T | null> {
	const [body, sig] = token.split(".");
	if (!body || !sig) return null;
	if (!safeEqual(await hmac(secret, body), sig)) return null;
	try {
		return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
	} catch {
		return null;
	}
}

// Artifact passwords: PBKDF2-SHA256 (100k iterations is the Workers runtime maximum).
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, iter, salt, hash] = stored.split("$");
	if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
	const actual = await pbkdf2(password, fromB64url(salt), Number(iter));
	return safeEqual(b64url(actual), hash);
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
	return new Uint8Array(bits);
}
