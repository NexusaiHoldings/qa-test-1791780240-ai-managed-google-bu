/**
 * GBP connection access helpers — resolves the current tenant (session user +
 * their org) and reports connection status for the UI. Uses the substrate's
 * lazy `require("pg")` pool so preview builds without a DB still compile.
 */
import { getSessionUser } from "@/lib/admin-auth";

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PoolLike;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

const db = {
  query: (sql: string, params?: unknown[]) => getPool().query(sql, params),
};

export type GbpContext = {
  orgId: string;
  userId: string;
};

/**
 * Resolve the acting tenant for the GBP connection flow: the logged-in user and
 * the org they belong to (one-org-per-business tenancy). Falls back to
 * DEMO_ORG_ID / DEMO_USER_ID for preview environments without a live session.
 * Returns null when no tenant can be resolved (caller renders a login prompt).
 */
export async function resolveGbpContext(): Promise<GbpContext | null> {
  const user = await getSessionUser();
  if (user) {
    const res = await db.query(
      `SELECT o.id
         FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.created_at ASC
        LIMIT 1`,
      [user.id],
    );
    const row = res.rows[0] as { id: string } | undefined;
    if (row) {
      return { orgId: String(row.id), userId: user.id };
    }
  }

  const demoOrg = process.env.DEMO_ORG_ID;
  const demoUser = process.env.DEMO_USER_ID ?? user?.id;
  if (demoOrg && demoUser) {
    return { orgId: demoOrg, userId: demoUser };
  }
  return null;
}

export type GbpConnectionStatus = {
  connected: boolean;
  paused: boolean;
  reason: string | null;
  selectedLocationTitle: string | null;
  category: string | null;
  verificationState: string | null;
};

export async function getGbpConnectionStatus(orgId: string): Promise<GbpConnectionStatus> {
  const result = await db.query(
    `SELECT connection_state, paused_reason, selected_location_title, primary_category_display_name, verification_state
     FROM gbp_connections
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );

  if (result.rowCount === 0) {
    return {
      connected: false,
      paused: false,
      reason: null,
      selectedLocationTitle: null,
      category: null,
      verificationState: null,
    };
  }

  const row = result.rows[0] as {
    connection_state: string;
    paused_reason: string | null;
    selected_location_title: string | null;
    primary_category_display_name: string | null;
    verification_state: string | null;
  };

  return {
    connected: row.connection_state === "active" || row.connection_state === "paused",
    paused: row.connection_state === "paused",
    reason: row.paused_reason,
    selectedLocationTitle: row.selected_location_title,
    category: row.primary_category_display_name,
    verificationState: row.verification_state,
  };
}
