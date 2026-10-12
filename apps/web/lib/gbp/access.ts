import { Pool } from "pg";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

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
