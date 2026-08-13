import { createHash, randomBytes } from "node:crypto";
import { withTenant } from "./db";

export const MAX_KEY_NAME_LENGTH = 100;

const TOKEN_PREFIX = "ctx_";
const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 12;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns as Postgres returns them; timestamptz arrives as a Date, nullable ones as null. */
export type ApiKeyRow = {
  readonly id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
};

export type KeyNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: string };

export type IssuedKey = {
  /** The only time this value exists anywhere. Nothing but the hash reaches the database. */
  readonly token: string;
  readonly name: string;
  readonly keyPrefix: string;
};

export type RevocationTarget =
  | { readonly status: "found"; readonly key: ApiKeyRow; readonly isLastActive: boolean }
  | { readonly status: "not-found" };

export type RevokeOutcome =
  | { readonly status: "revoked"; readonly name: string }
  | { readonly status: "needs-lockout-confirmation"; readonly name: string }
  | { readonly status: "not-found" };

/**
 * Must stay byte-identical to app.resolve_api_key's
 * `encode(sha256(convert_to(raw_token, 'utf8')), 'hex')` — any drift mints keys that
 * authenticate nowhere, and the failure is silent because only the hash is stored.
 */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** FormData yields `string | File`; a File reaching here is a forged request, not our form. */
export function checkKeyName(raw: string | null): KeyNameCheck {
  if (raw === null) return { ok: false, error: "The name must be submitted as text." };
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, error: "Name the key after the agent that will hold it." };
  }
  if (name.length > MAX_KEY_NAME_LENGTH) {
    return { ok: false, error: `Keep the name to ${MAX_KEY_NAME_LENGTH} characters or fewer.` };
  }
  return { ok: true, name };
}

/** Active keys first, newest first, so the row an operator is looking for is at the top. */
export async function listApiKeys(orgId: string): Promise<readonly ApiKeyRow[]> {
  return withTenant(orgId, async (client) => {
    const result = await client.query<ApiKeyRow>(
      `select id, name, key_prefix, last_used_at, revoked_at, created_at
         from api_keys
        order by (revoked_at is not null), created_at desc`,
    );
    return result.rows;
  });
}

export async function issueApiKey(orgId: string, name: string): Promise<IssuedKey> {
  const token = generateToken();
  const keyPrefix = token.slice(0, PREFIX_LENGTH);
  await withTenant(orgId, async (client) => {
    await client.query(
      "insert into api_keys (org_id, name, key_prefix, key_hash) values ($1, $2, $3, $4)",
      [orgId, name, keyPrefix, hashToken(token)],
    );
  });
  return { token, name, keyPrefix };
}

/** Feeds the confirmation step: revoking the last active key locks every agent out. */
export async function findRevocationTarget(
  orgId: string,
  keyId: string,
): Promise<RevocationTarget> {
  if (!UUID_PATTERN.test(keyId)) return { status: "not-found" };

  return withTenant(orgId, async (client) => {
    const keyResult = await client.query<ApiKeyRow>(
      `select id, name, key_prefix, last_used_at, revoked_at, created_at
         from api_keys
        where id = $1 and revoked_at is null`,
      [keyId],
    );
    const key = keyResult.rows.at(0);
    if (key === undefined) return { status: "not-found" };

    const countResult = await client.query<{ active: number }>(
      "select count(*)::int as active from api_keys where revoked_at is null",
    );
    return { status: "found", key, isLastActive: (countResult.rows.at(0)?.active ?? 0) <= 1 };
  });
}

/**
 * The count and the update share one transaction, and the caller's acknowledgement is only
 * honoured against a count taken here — a hidden field cannot talk the panel out of the warning.
 */
export async function revokeApiKey(
  orgId: string,
  keyId: string,
  lockoutAcknowledged: boolean,
): Promise<RevokeOutcome> {
  if (!UUID_PATTERN.test(keyId)) return { status: "not-found" };

  return withTenant(orgId, async (client) => {
    const keyResult = await client.query<{ name: string }>(
      "select name from api_keys where id = $1 and revoked_at is null for update",
      [keyId],
    );
    const key = keyResult.rows.at(0);
    if (key === undefined) return { status: "not-found" };

    const countResult = await client.query<{ active: number }>(
      "select count(*)::int as active from api_keys where revoked_at is null",
    );
    const isLastActive = (countResult.rows.at(0)?.active ?? 0) <= 1;
    if (isLastActive && !lockoutAcknowledged) {
      return { status: "needs-lockout-confirmation", name: key.name };
    }

    await client.query(
      "update api_keys set revoked_at = now() where id = $1 and revoked_at is null",
      [keyId],
    );
    return { status: "revoked", name: key.name };
  });
}
