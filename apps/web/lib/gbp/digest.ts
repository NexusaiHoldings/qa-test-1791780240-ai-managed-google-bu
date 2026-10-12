import { sql } from "@vercel/postgres";
import { getActivityFeedForOrg, type GbpActivityItem } from "@/lib/gbp/activity-feed";

export type WeeklyDigestSummary = {
  orgId: string;
  ownerTimezone: string;
  thisWeekPost: {
    id: string;
    body: string;
    status: string;
    scheduledFor: string | null;
    approveUrl: string;
  } | null;
  reviews: {
    answered: number;
    waiting: number;
  };
  keywords: {
    up: number;
    down: number;
    flat: number;
    score: number;
  };
  connection: {
    label: string;
    connectionState: string;
    pausedReason: string | null;
    lastRefreshedAt: string | null;
  };
  activity: GbpActivityItem[];
};

type OrgRow = { org_id: string };
type ConnRow = {
  timezone: string | null;
  connection_state: string;
  paused_reason: string | null;
  last_refreshed_at: string | null;
};
type PostRow = {
  id: string;
  body: string;
  status: string;
  scheduled_for: string | null;
};
type ReviewCountsRow = { answered: number; waiting: number };
type KeywordRow = { up: number; down: number; flat: number };

export async function getWeeklyDigestSummaryForSessionUser(
  userId: string,
): Promise<WeeklyDigestSummary> {
  const orgRes = await sql<OrgRow>`
    SELECT org_id::text AS org_id
    FROM org_memberships
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const orgId = orgRes.rows[0]?.org_id;
  if (!orgId) {
    return {
      orgId: "",
      ownerTimezone: "America/New_York",
      thisWeekPost: null,
      reviews: { answered: 0, waiting: 0 },
      keywords: { up: 0, down: 0, flat: 0, score: 0 },
      connection: {
        label: "Not connected",
        connectionState: "disconnected",
        pausedReason: null,
        lastRefreshedAt: null,
      },
      activity: [],
    };
  }

  return getWeeklyDigestSummaryForOrg(orgId);
}

export async function getWeeklyDigestSummaryForOrg(
  orgId: string,
): Promise<WeeklyDigestSummary> {
  const [connRes, postRes, reviewRes, keywordRes, activity] = await Promise.all([
    sql<ConnRow>`
      SELECT
        ps.timezone,
        COALESCE(c.connection_state, 'disconnected') AS connection_state,
        c.paused_reason,
        c.last_refreshed_at::text AS last_refreshed_at
      FROM gbp_connections c
      LEFT JOIN gbp_publish_slots ps ON ps.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
      LIMIT 1
    `,
    sql<PostRow>`
      SELECT id::text AS id, body, status, scheduled_for::text AS scheduled_for
      FROM gbp_posts
      WHERE org_id = ${orgId}::uuid
        AND week_start = date_trunc('week', now())::date
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql<ReviewCountsRow>`
      SELECT
        COUNT(*) FILTER (WHERE reply_status = 'published')::int AS answered,
        COUNT(*) FILTER (WHERE reply_status IN ('pending', 'queued', 'needs_approval'))::int AS waiting
      FROM gbp_reviews
      WHERE org_id = ${orgId}::uuid
    `,
    sql<KeywordRow>`
      WITH latest AS (
        SELECT movement
        FROM gbp_keyword_rank_snapshots
        WHERE org_id = ${orgId}::uuid
          AND snapshot_date = (SELECT MAX(snapshot_date) FROM gbp_keyword_rank_snapshots WHERE org_id = ${orgId}::uuid)
      )
      SELECT
        COUNT(*) FILTER (WHERE movement > 0)::int AS up,
        COUNT(*) FILTER (WHERE movement < 0)::int AS down,
        COUNT(*) FILTER (WHERE movement = 0)::int AS flat
      FROM latest
    `,
    getActivityFeedForOrg(orgId, 25),
  ]);

  const conn = connRes.rows[0];
  const timezone = conn?.timezone || "America/New_York";
  const state = conn?.connection_state || "disconnected";

  const post = postRes.rows[0];
  const reviewCounts = reviewRes.rows[0] ?? { answered: 0, waiting: 0 };
  const keyword = keywordRes.rows[0] ?? { up: 0, down: 0, flat: 0 };
  const total = keyword.up + keyword.down + keyword.flat;
  const score = total > 0 ? ((keyword.up + keyword.flat * 0.5) / total) * 100 : 0;

  return {
    orgId,
    ownerTimezone: timezone,
    thisWeekPost: post
      ? {
          id: post.id,
          body: post.body,
          status: post.status,
          scheduledFor: post.scheduled_for,
          approveUrl: `/gbp/posts/${post.id}/approve`,
        }
      : null,
    reviews: {
      answered: reviewCounts.answered,
      waiting: reviewCounts.waiting,
    },
    keywords: {
      up: keyword.up,
      down: keyword.down,
      flat: keyword.flat,
      score,
    },
    connection: {
      label:
        state === "connected"
          ? "Connected"
          : state === "paused"
          ? "Paused"
          : state === "suspended"
          ? "Suspended"
          : "Needs reconnection",
      connectionState: state,
      pausedReason: conn?.paused_reason ?? null,
      lastRefreshedAt: conn?.last_refreshed_at ?? null,
    },
    activity,
  };
}
