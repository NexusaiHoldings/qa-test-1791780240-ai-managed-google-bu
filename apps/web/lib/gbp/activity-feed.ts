/**
 * GBP activity feed — one reverse-chronological log that merges the three things
 * an owner actually cares about (posts published/queued, reviews answered or
 * waiting, and weekly keyword-rank snapshots) for a single org. Powers the
 * dashboard's vertical activity feed and the Monday digest email.
 *
 * DB access uses the substrate's lazy `require("pg")` pool (the same pattern as
 * lib/gbp/access.ts) so preview builds without a DATABASE_URL still compile —
 * `pg` is externalized in next.config.js and resolved from the function's
 * node_modules at runtime.
 */

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

export type GbpActivityKind = "post" | "review" | "rank";

export type GbpActivityItem = {
  id: string;
  kind: GbpActivityKind;
  occurredAt: string;
  title: string;
  detail: string | null;
};

type ActivityRow = {
  id: string;
  kind: GbpActivityKind;
  occurred_at: string;
  title: string;
  detail: string | null;
};

/**
 * Load the most recent `limit` activity events for an org, newest first. The
 * three source tables are unioned and sorted by their effective timestamp so the
 * feed reads as a single timeline. `limit` is clamped to [1, 100].
 */
export async function getActivityFeedForOrg(
  orgId: string,
  limit = 20,
): Promise<GbpActivityItem[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 20, 100));

  const result = await getPool().query(
    `SELECT id, kind, occurred_at, title, detail
       FROM (
         SELECT
           p.id::text AS id,
           'post' AS kind,
           COALESCE(p.published_at, p.scheduled_for, p.updated_at, p.created_at)::text AS occurred_at,
           CASE
             WHEN p.status = 'published' THEN 'Post published'
             WHEN p.status IN ('awaiting_approval', 'needs_approval') THEN 'Post waiting for approval'
             WHEN p.status = 'scheduled' THEN 'Post scheduled'
             ELSE 'Post updated'
           END AS title,
           LEFT(COALESCE(NULLIF(p.summary, ''), p.body, ''), 220) AS detail
         FROM gbp_posts p
         WHERE p.org_id = $1

         UNION ALL

         SELECT
           r.id::text AS id,
           'review' AS kind,
           COALESCE(r.published_at, r.review_update_time, r.updated_at, r.created_at)::text AS occurred_at,
           CASE
             WHEN r.reply_status = 'published' THEN 'Review answered'
             WHEN r.reply_status IN ('pending', 'queued', 'needs_approval') THEN 'Review waiting for reply'
             ELSE 'Review updated'
           END AS title,
           LEFT(COALESCE(NULLIF(r.comment_redacted, ''), r.star_rating::text || '-star rating'), 220) AS detail
         FROM gbp_reviews r
         WHERE r.org_id = $1

         UNION ALL

         SELECT
           k.id::text AS id,
           'rank' AS kind,
           COALESCE(k.created_at, k.snapshot_date::timestamptz)::text AS occurred_at,
           'Keyword rank snapshot' AS title,
           k.keyword || ' — position ' || k.rank::text ||
             CASE
               WHEN k.movement > 0 THEN ' (up ' || k.movement::text || ')'
               WHEN k.movement < 0 THEN ' (down ' || ABS(k.movement)::text || ')'
               ELSE ' (no change)'
             END AS detail
         FROM gbp_keyword_rank_snapshots k
         WHERE k.org_id = $1
       ) feed
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [orgId, safeLimit],
  );

  return (result.rows as ActivityRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    title: row.title,
    detail: row.detail && row.detail.trim().length > 0 ? row.detail : null,
  }));
}
