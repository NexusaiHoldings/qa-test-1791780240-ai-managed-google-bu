import { NextResponse } from "next/server";
import { Pool } from "pg";
import { refreshConnectionToken } from "@/lib/gbp/oauth";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(): Promise<NextResponse> {
  const jitterMinutes = Math.floor(Math.random() * 180);
  const dueAt = new Date(Date.now() + jitterMinutes * 60 * 1000);

  const res = await db.query(
    `SELECT id
     FROM gbp_connections
     WHERE (token_expires_at IS NULL OR token_expires_at < $1)
        OR (last_refreshed_at IS NULL OR last_refreshed_at < NOW() - INTERVAL '1 day')
     LIMIT 100`,
    [dueAt.toISOString()],
  );

  let refreshed = 0;
  let failed = 0;
  for (const row of res.rows as Array<{ id: string }>) {
    try {
      await refreshConnectionToken(row.id);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }

  return NextResponse.json({ ok: true, refreshed, failed, jitterMinutes });
}
