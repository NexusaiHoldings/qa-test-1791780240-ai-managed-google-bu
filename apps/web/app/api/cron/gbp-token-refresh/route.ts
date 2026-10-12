import { NextRequest, NextResponse } from "next/server";
import { refreshConnectionToken } from "@/lib/gbp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

/**
 * Daily jittered GBP token-refresh cron.
 *
 * Vercel fires this on a daily schedule. A per-run random jitter (0–3h) is
 * applied to the "due" cutoff so refreshes spread across the window instead of
 * stampeding Google's token endpoint at a single instant — the single-point-of-
 * failure the CEO research directions call out. Each connection is refreshed
 * independently; one failure never aborts the batch.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET` when configured.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  const jitterMinutes = Math.floor(Math.random() * 180);
  const dueAt = new Date(Date.now() + jitterMinutes * 60 * 1000);

  const db = getPool();
  const res = await db.query(
    `SELECT id
       FROM gbp_connections
      WHERE (token_expires_at IS NULL OR token_expires_at < $1)
         OR (last_refreshed_at IS NULL OR last_refreshed_at < NOW() - INTERVAL '1 day')
      ORDER BY last_refreshed_at ASC NULLS FIRST
      LIMIT 200`,
    [dueAt.toISOString()],
  );

  let refreshed = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];
  for (const row of res.rows as Array<{ id: string }>) {
    try {
      await refreshConnectionToken(row.id);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        id: row.id,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: res.rowCount ?? 0,
    refreshed,
    failed,
    jitterMinutes,
    errors,
  });
}
