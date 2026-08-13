import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { readEnv } from "./env";

export const SESSION_COOKIE = "panel_session";

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const WINDOW_MS = 15 * 60 * 1000;
const ATTEMPTS_PER_CLIENT = 10;
const ATTEMPTS_GLOBAL = 50;
const MAX_TRACKED_CLIENTS = 10_000;

// Must match what scripts/hash-password.mjs emits.
const KEY_BYTES = 32;
const MIN_SALT_BYTES = 16;

type ScryptHash = {
  readonly salt: Buffer;
  readonly key: Buffer;
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
};

/**
 * Encoded as `scrypt:N:r:p:saltBase64:keyBase64`, which scripts/hash-password.mjs emits.
 * The separator is a colon and not the conventional `$` because Vite expands `$1`/`$8`
 * in a .env file, which silently truncates the hash before it ever reaches this parser.
 */
function positiveInteger(raw: string | undefined, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PANEL_PASSWORD_HASH carries a non-positive ${field} parameter`);
  }
  return value;
}

function parseHash(encoded: string): ScryptHash {
  const parts = encoded.split(":");
  const [scheme, cost, blockSize, parallelization, encodedSalt, encodedKey] = parts;
  if (parts.length !== 6 || scheme !== "scrypt") {
    throw new Error("PANEL_PASSWORD_HASH is not in the scrypt:N:r:p:salt:key format");
  }

  const salt = Buffer.from(encodedSalt ?? "", "base64");
  const key = Buffer.from(encodedKey ?? "", "base64");
  // Buffer.from drops invalid base64 silently, so a mangled hash decodes to a short or
  // empty key. Deriving that many bytes still compares equal, which would accept every
  // password: the boundary parse has to fail closed on length.
  if (key.length !== KEY_BYTES || salt.length < MIN_SALT_BYTES) {
    throw new Error("PANEL_PASSWORD_HASH has a truncated or malformed salt or key");
  }

  return {
    salt,
    key,
    cost: positiveInteger(cost, "N"),
    blockSize: positiveInteger(blockSize, "r"),
    parallelization: positiveInteger(parallelization, "p"),
  };
}

/** Throws when PANEL_PASSWORD_HASH is missing or malformed; a wrong password only returns false. */
export function verifyPassword(password: string): boolean {
  const expected = parseHash(readEnv("PANEL_PASSWORD_HASH"));
  const candidate = scryptSync(password.normalize("NFKC"), expected.salt, expected.key.length, {
    N: expected.cost,
    r: expected.blockSize,
    p: expected.parallelization,
    maxmem: 256 * expected.cost * expected.blockSize,
  });
  return timingSafeEqual(candidate, expected.key);
}

/**
 * The password hash is part of the MAC key, so rotating the password invalidates every
 * outstanding session without keeping a session store to revoke against.
 */
function sign(payload: string): string {
  const key = `${readEnv("PANEL_SESSION_SECRET")}:${readEnv("PANEL_PASSWORD_HASH")}`;
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export type Session = {
  readonly value: string;
  readonly maxAge: number;
};

/** There are no accounts, so the payload carries an expiry and nothing else. */
export function issueSession(): Session {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt }), "utf8").toString("base64url");
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_TTL_SECONDS };
}

function readExpiry(payload: string): number | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || !("exp" in decoded)) return null;
  const expiry = decoded.exp;
  return typeof expiry === "number" && Number.isFinite(expiry) ? expiry : null;
}

/** Signature is checked before the expiry so a forged token never reaches JSON.parse's output. */
export function isSessionValid(token: string | undefined): boolean {
  if (token === undefined) return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");

  // sign() reads the environment, so missing login config throws here. The guard runs on
  // every request: it must fail closed and let /login explain, not 500 the whole panel.
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(payload), "base64url");
  } catch (error) {
    console.error("session check failed", error);
    return false;
  }

  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
  const expiry = readExpiry(payload);
  return expiry !== null && expiry > Math.floor(Date.now() / 1000);
}

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function consume(key: string, limit: number, now: number): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

/**
 * Best effort only: serverless instances are isolated, so this caps attempts per instance
 * rather than per deployment. It is still the entire brute-force defence, because one
 * shared password means there is no account to lock out.
 */
export function allowLoginAttempt(client: string): boolean {
  const now = Date.now();
  if (buckets.size > MAX_TRACKED_CLIENTS) pruneExpired(now);
  // A client that is already throttled must stop charging the shared budget, or 50 requests
  // from one attacker would lock the admin out of the only way in.
  if (!consume(`client:${client}`, ATTEMPTS_PER_CLIENT, now)) return false;
  return consume("global", ATTEMPTS_GLOBAL, now);
}
