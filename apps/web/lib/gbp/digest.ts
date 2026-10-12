/**
 * Weekly digest summary — the single source of truth behind BOTH the dashboard
 * screen and the Monday digest email. For one org it composes: this week's post
 * (the focal "This week" card / email hero), review answered-vs-waiting counts,
 * keyword movement with a derived visibility score, connection health (the
 * paused/suspended/reconnect banner), the owner's timezone, and the recent
 * activity feed. Everything is read-only and parameterized.
 *
 * DB access uses the substrate's lazy `require("pg")` pool (same pattern as
 * lib/gbp/access.ts) so preview builds without a DATABASE_URL still compile.
 */
import { getActivityFeedForOrg, type GbpActivityItem } from "@/lib/gbp/activity-feed";

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

async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

const DEFAULT_TIMEZONE = "America/New_York";

export type DigestOwner = {
  userId: string | null;
  email: string | null;
};

export type WeeklyDigestSummary = {
  orgId: string;
  owner: DigestOwner;
  ownerTimezone: string;
  /** ISO date (YYYY-MM-DD) of the Monday that starts the digest week. */
  weekStart: string;
  thisWeekPost: {
    id: string;
    body: string;
    summary: string | null;
    status: string;
    isWarmup: boolean;
    scheduledFor: string | null;
    publishedAt: string | null;
    photoUrl: string | null;
    /** Link the owner taps to review/approve the post (post detail page). */
    approveUrl: string;
    needsApproval: boolean;
  } | null;
  reviews: {
    answered: number;
    waiting: number;
  };
  keywords: {
    up: number;
    down: number;
    flat: number;
    tracked: number;
    /** 0–100 visibility score: up counts full, flat half, down zero. */
    score: number;
  };
  connection: {
    label: string;
    connectionState: string;
    pausedReason: string | null;
    lastRefreshedAt: string | null;
    paused: boolean;
    suspended: boolean;
    needsReconnect: boolean;
  };
  activity: GbpActivityItem[];
};

type OrgRow = { org_id: string };
type ConnRow = {
  user_id: string | null;
  email: string | null;
  timezone: string | null;
  connection_state: string;
  paused_reason: string | null;
  last_refreshed_at: string | null;
};
type PostRow = {
  id: string;
  body: string;
  summary: string | null;
  status: string;
  is_warmup: boolean;
  scheduled_for: string | null;
  published_at: string | null;
  photo_url: string | null;
};
type ReviewCountsRow = { answered: number; waiting: number };
type KeywordRow = { up: number; down: number; flat: number };

function emptySummary(orgId: string, weekStart: string): WeeklyDigestSummary {
  return {
    orgId,
    owner: { userId: null, email: null },
    ownerTimezone: DEFAULT_TIMEZONE,
    weekStart,
    thisWeekPost: null,
    reviews: { answered: 0, waiting: 0 },
    keywords: { up: 0, down: 0, flat: 0, tracked: 0, score: 0 },
    connection: {
      label: "Not connected",
      connectionState: "disconnected",
      pausedReason: null,
      lastRefreshedAt: null,
      paused: false,
      suspended: false,
      needsReconnect: true,
    },
    activity: [],
  };
}

/** ISO date string of the Monday that starts the current week (UTC). */
export function currentWeekStart(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const diff = dow === 0 ? 6 : dow - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the org for a logged-in user (one-org-per-business tenancy) and return
 * its weekly digest summary. Returns an empty-but-valid summary when the user
 * has no org yet so the dashboard can render its first-week empty state.
 */
export async function getWeeklyDigestSummaryForSessionUser(
  userId: string,
): Promise<WeeklyDigestSummary> {
  const weekStart = currentWeekStart();
  const rows = await query<OrgRow>(
    `SELECT o.id::text AS org_id
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY m.joined_at ASC
      LIMIT 1`,
    [userId],
  );

  const orgId = rows[0]?.org_id;
  if (!orgId) {
    return emptySummary("", weekStart);
  }

  return getWeeklyDigestSummaryForOrg(orgId);
}

/**
 * Build the weekly digest summary for a specific org. All five reads run
 * concurrently; each falls back to a neutral default so a partially-populated
 * tenant (e.g. connected but no posts yet) still renders cleanly.
 */
export async function getWeeklyDigestSummaryForOrg(
  orgId: string,
): Promise<WeeklyDigestSummary> {
  const weekStart = currentWeekStart();

  const [connRows, postRows, reviewRows, keywordRows, activity] = await Promise.all([
    query<ConnRow>(
      `SELECT
         c.user_id::text AS user_id,
         u.email AS email,
         ps.timezone AS timezone,
         COALESCE(c.connection_state, 'disconnected') AS connection_state,
         c.paused_reason,
         c.last_refreshed_at::text AS last_refreshed_at
       FROM gbp_connections c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN gbp_publish_slots ps ON ps.org_id = c.org_id AND ps.is_active = TRUE
      WHERE c.org_id = $1
      ORDER BY c.created_at ASC
      LIMIT 1`,
      [orgId],
    ),
    query<PostRow>(
      `SELECT
         id::text AS id,
         body,
         summary,
         status,
         is_warmup,
         scheduled_for::text AS scheduled_for,
         published_at::text AS published_at,
         photo_url
       FROM gbp_posts
      WHERE org_id = $1
        AND (week_start = $2::date OR week_start IS NULL)
      ORDER BY
        (week_start = $2::date) DESC,
        COALESCE(scheduled_for, created_at) DESC
      LIMIT 1`,
      [orgId, weekStart],
    ),
    query<ReviewCountsRow>(
      `SELECT
         COUNT(*) FILTER (WHERE reply_status = 'published')::int AS answered,
         COUNT(*) FILTER (WHERE reply_status IN ('pending', 'queued', 'needs_approval'))::int AS waiting
       FROM gbp_reviews
      WHERE org_id = $1`,
      [orgId],
    ),
    query<KeywordRow>(
      `WITH latest AS (
         SELECT movement
           FROM gbp_keyword_rank_snapshots
          WHERE org_id = $1
            AND snapshot_date = (
              SELECT MAX(snapshot_date)
                FROM gbp_keyword_rank_snapshots
               WHERE org_id = $1
            )
       )
       SELECT
         COUNT(*) FILTER (WHERE movement > 0)::int AS up,
         COUNT(*) FILTER (WHERE movement < 0)::int AS down,
         COUNT(*) FILTER (WHERE movement = 0)::int AS flat
       FROM latest`,
      [orgId],
    ),
    getActivityFeedForOrg(orgId, 25),
  ]);

  const conn = connRows[0];
  const state = conn?.connection_state || "disconnected";
  const timezone = conn?.timezone || DEFAULT_TIMEZONE;

  const post = postRows[0];
  const reviewCounts = reviewRows[0] ?? { answered: 0, waiting: 0 };
  const keyword = keywordRows[0] ?? { up: 0, down: 0, flat: 0 };
  const tracked = keyword.up + keyword.down + keyword.flat;
  const score =
    tracked > 0 ? Math.round(((keyword.up + keyword.flat * 0.5) / tracked) * 100) : 0;

  const paused = state === "paused";
  const suspended = state === "suspended";
  const needsReconnect =
    state === "disconnected" || state === "expired" || state === "revoked" || state === "error";
  const needsApproval =
    post?.status === "awaiting_approval" || post?.status === "needs_approval";

  return {
    orgId,
    owner: {
      userId: conn?.user_id ?? null,
      email: conn?.email ?? null,
    },
    ownerTimezone: timezone,
    weekStart,
    thisWeekPost: post
      ? {
          id: post.id,
          body: post.body,
          summary: post.summary,
          status: post.status,
          isWarmup: Boolean(post.is_warmup),
          scheduledFor: post.scheduled_for,
          publishedAt: post.published_at,
          photoUrl: post.photo_url,
          approveUrl: `/posts/${post.id}`,
          needsApproval,
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
      tracked,
      score,
    },
    connection: {
      label: suspended
        ? "Suspended"
        : paused
        ? "Paused"
        : state === "active" || state === "connected"
        ? "Connected"
        : "Needs reconnection",
      connectionState: state,
      pausedReason: conn?.paused_reason ?? null,
      lastRefreshedAt: conn?.last_refreshed_at ?? null,
      paused,
      suspended,
      needsReconnect,
    },
    activity,
  };
}
