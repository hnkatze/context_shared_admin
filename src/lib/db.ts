import pg from "pg";
import type { PoolClient } from "pg";
import { readEnv } from "./env";

/**
 * One connection per function instance. Vercel runs many isolated instances and
 * a larger pool per instance exhausts Postgres; CONTEXT_SHARED_DATABASE_URL must
 * point at a transaction-mode pooler, never at the direct connection.
 */
const pool = new pg.Pool({
  connectionString: readEnv("CONTEXT_SHARED_DATABASE_URL"),
  max: 1,
});

/**
 * set_config's third argument scopes the value to this transaction, which is
 * also what makes it safe under transaction-mode pooling: a session-scoped
 * setting would leak one tenant's id onto the next request sharing the backend.
 */
export async function withTenant<TResult>(
  orgId: string,
  run: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let confirmedOrgId: string | null = null;

/**
 * A wrong PANEL_ORG_ID never fails on its own: RLS simply returns nothing, so the panel
 * renders healthy while pointed at an empty or foreign org. Confirm the row exists once
 * per instance instead. The lookup runs inside withTenant because org_is_current only
 * exposes the row whose id equals the current tenant.
 */
export async function panelOrgId(): Promise<string> {
  if (confirmedOrgId !== null) return confirmedOrgId;

  const orgId = readEnv("PANEL_ORG_ID");
  if (!UUID_PATTERN.test(orgId)) {
    throw new Error("PANEL_ORG_ID is not a UUID");
  }

  const exists = await withTenant(orgId, async (client) => {
    const result = await client.query("select 1 from organizations where id = $1", [orgId]);
    return result.rowCount === 1;
  });
  if (!exists) {
    throw new Error(`PANEL_ORG_ID ${orgId} does not match an organization on this database`);
  }

  confirmedOrgId = orgId;
  return orgId;
}
