import { sql } from "@vercel/postgres";

export type GbpActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  detail: string | null;
};

type ActivityRow = {
  id: string;
  occurred_at: string;
  title: string;
  detail: string | null;
};

export async function getActivityFeedForOrg(
  orgId: string,
  limit: number = 20,
): Promise<GbpActivityItem[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));

  const { rows } = await sql<ActivityRow>`
    SELECT id, occurred_at, title, detail
    FROM (
      SELECT
        p.id::text AS id,
        COALESCE(p.published_at, p.updated_at, p.created_at)::text AS occurred_at,
        CASE
          WHEN p.status = 'published' THEN 'Post published'
          WHEN p.status = 'awaiting_approval' THEN 'Post waiting for approval'
          ELSE 'Post updated'
        END AS title,
        LEFT(COALESCE(p.summary, p.body, ''), 220) AS detail
      FROM gbp_posts p
      WHERE p.org_id = ${orgId}

      UNION ALL

      SELECT
        r.id::text AS id,
        COALESCE(r.published_at, r.updated_at, r.created_at)::text AS occurred_at,
        CASE
          WHEN r.reply_status = 'published' THEN 'Review replied'
          WHEN r.reply_status = 'pending' THEN 'Review waiting for reply'
          ELSE 'Review updated'
        END AS title,
        LEFT(COALESCE(r.comment_redacted, ''), 220) AS detail
      FROM gbp_reviews r
      WHERE r.org_id = ${orgId}

      UNION ALL

      SELECT
        k.id::text AS id,
        k.created_at::text AS occurred_at,
        'Rank snapshot captured' AS title,
        CONCAT(k.keyword, ' rank: ', k.rank::text) AS detail
      FROM gbp_keyword_rank_snapshots k
      WHERE k.org_id = ${orgId}
    ) feed
    ORDER BY occurred_at DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    title: row.title,
    detail: row.detail,
  }));
}
