import Link from "next/link";
import { getServerSession } from "@nexus/identity-and-access";
import { getDashboardActivityFeed } from "@/lib/gbp/activity-feed";
import { getDisclosureText } from "@/lib/gbp/disclosure";

export const dynamic = "force-dynamic";

type DashboardStats = {
  publishedThisWeek: number;
  reviewsAnswered: number;
  reviewsWaiting: number;
  keywordUp: number;
  keywordDown: number;
  keywordFlat: number;
  connectionState: "connected" | "paused" | "suspended" | "pending" | "disconnected";
  publishingStatus: string | null;
  locationTitle: string | null;
  timezone: string;
  thisWeekPostPreview: {
    body: string | null;
    status: string | null;
    scheduledFor: string | null;
    isWarmup: boolean;
  } | null;
};

async function getDashboardStats(orgId: string): Promise<DashboardStats> {
  const { sql } = await import("@/lib/db");
  const connectionRows = await sql<{
    connection_state: string | null;
    paused_reason: string | null;
    selected_location_title: string | null;
    selected_location_metadata: unknown;
  }[]>`
    SELECT
      connection_state,
      paused_reason,
      selected_location_title,
      selected_location_metadata
    FROM gbp_connections
    WHERE org_id = ${orgId}
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  const conn = connectionRows[0];
  const metadata = (conn?.selected_location_metadata ?? {}) as Record<string, unknown>;
  const publishingStatusRaw = metadata?.publishing_status;
  const publishingStatus =
    typeof publishingStatusRaw === "string" ? publishingStatusRaw : conn?.paused_reason ?? null;

  const stateRaw = (conn?.connection_state ?? "pending").toLowerCase();
  let connectionState: DashboardStats["connectionState"] = "pending";
  if (stateRaw.includes("suspend")) connectionState = "suspended";
  else if (stateRaw.includes("pause")) connectionState = "paused";
  else if (stateRaw.includes("connect")) connectionState = "connected";
  else if (stateRaw.includes("disconnect")) connectionState = "disconnected";

  const postRows = await sql<{
    body: string | null;
    status: string | null;
    scheduled_for: string | null;
    is_warmup: boolean;
  }[]>`
    SELECT body, status, scheduled_for::text, is_warmup
    FROM gbp_posts
    WHERE org_id = ${orgId}
      AND created_at >= date_trunc('week', NOW())
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const publishCountRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM gbp_posts
    WHERE org_id = ${orgId}
      AND status IN ('published', 'approved')
      AND created_at >= date_trunc('week', NOW())
  `;

  const reviewRows = await sql<{ answered: string; waiting: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE reply_status IN ('published', 'approved'))::text AS answered,
      COUNT(*) FILTER (WHERE reply_status IN ('pending', 'queued', 'drafted'))::text AS waiting
    FROM gbp_reviews
    WHERE org_id = ${orgId}
      AND created_at >= date_trunc('week', NOW())
  `;

  const rankRows = await sql<{ direction: string; c: string }[]>`
    SELECT
      CASE
        WHEN movement > 0 THEN 'up'
        WHEN movement < 0 THEN 'down'
        ELSE 'flat'
      END AS direction,
      COUNT(*)::text AS c
    FROM gbp_keyword_rank_snapshots
    WHERE org_id = ${orgId}
      AND snapshot_date >= (CURRENT_DATE - INTERVAL '7 days')
    GROUP BY 1
  `;

  let keywordUp = 0;
  let keywordDown = 0;
  let keywordFlat = 0;
  for (const row of rankRows) {
    const n = Number(row.c);
    if (row.direction === "up") keywordUp = n;
    else if (row.direction === "down") keywordDown = n;
    else keywordFlat = n;
  }

  return {
    publishedThisWeek: Number(publishCountRows[0]?.count ?? 0),
    reviewsAnswered: Number(reviewRows[0]?.answered ?? 0),
    reviewsWaiting: Number(reviewRows[0]?.waiting ?? 0),
    keywordUp,
    keywordDown,
    keywordFlat,
    connectionState,
    publishingStatus,
    locationTitle: conn?.selected_location_title ?? null,
    timezone: "America/New_York",
    thisWeekPostPreview: postRows[0]
      ? {
          body: postRows[0].body,
          status: postRows[0].status,
          scheduledFor: postRows[0].scheduled_for,
          isWarmup: postRows[0].is_warmup,
        }
      : null,
  };
}

function connectionBanner(stats: DashboardStats): { title: string; detail: string; actionHref: string; actionLabel: string } | null {
  if (stats.connectionState === "suspended") {
    return {
      title: "Google connection suspended",
      detail: "Publishing is paused until your location is back in good standing.",
      actionHref: "/settings/gbp",
      actionLabel: "Reconnect",
    };
  }
  if (stats.connectionState === "paused") {
    return {
      title: "Publishing paused",
      detail: stats.publishingStatus ? `Status: ${stats.publishingStatus}` : "We are waiting for reconnect.",
      actionHref: "/settings/gbp",
      actionLabel: "Reconnect",
    };
  }
  if (stats.connectionState === "disconnected") {
    return {
      title: "Google connection disconnected",
      detail: "Reconnect to resume weekly posting and review replies.",
      actionHref: "/settings/gbp",
      actionLabel: "Reconnect",
    };
  }
  return null;
}

export default async function GbpDashboardPage(): Promise<JSX.Element> {
  const session = await getServerSession();
  const orgId = (session as { orgId?: string } | null)?.orgId;

  if (!orgId) {
    return (
      <main>
        <h1>GBP Dashboard</h1>
        <p>Connect your business profile to see weekly activity.</p>
        <div className="empty">
          <p className="muted">No organization context found for this session.</p>
        </div>
      </main>
    );
  }

  const [stats, feed, disclosure] = await Promise.all([
    getDashboardStats(orgId),
    getDashboardActivityFeed(orgId, 20),
    getDisclosureText(),
  ]);

  const banner = connectionBanner(stats);
  const isFirstWeekEmpty = !stats.thisWeekPostPreview && stats.publishedThisWeek === 0 && stats.reviewsAnswered === 0;

  return (
    <main>
      <h1>Dashboard</h1>
      <p>
        One profile, one weekly log, one monthly snapshot. {stats.locationTitle ? `Location: ${stats.locationTitle}.` : ""}
      </p>

      {banner ? (
        <section className="card" aria-live="polite">
          <h2>{banner.title}</h2>
          <p className="muted">{banner.detail}</p>
          <p>
            <Link className="btn" href={banner.actionHref}>
              {banner.actionLabel}
            </Link>
          </p>
        </section>
      ) : null}

      <section className="card">
        <h2>This week</h2>
        {isFirstWeekEmpty ? (
          <div className="empty">
            <p>Your first post goes out Thursday.</p>
            <p className="muted">We’ll prepare a draft in your voice and ask for one-tap approval during warm-up.</p>
          </div>
        ) : (
          <>
            <p>{stats.thisWeekPostPreview?.body ?? "Draft in progress."}</p>
            <p className="muted">
              {stats.thisWeekPostPreview?.status ? `Status: ${stats.thisWeekPostPreview.status}. ` : ""}
              {stats.thisWeekPostPreview?.scheduledFor ? `Scheduled: ${new Date(stats.thisWeekPostPreview.scheduledFor).toLocaleString()}` : ""}
            </p>
            <p>
              <Link className="btn" href="/work">
                {stats.connectionState === "connected" ? "Approve this week" : "Reconnect"}
              </Link>
            </p>
          </>
        )}
      </section>

      <section style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <article className="card">
          <h3>Reviews</h3>
          <p>
            Answered: <strong>{stats.reviewsAnswered}</strong>
          </p>
          <p>
            Waiting: <strong>{stats.reviewsWaiting}</strong>
          </p>
        </article>

        <article className="card">
          <h3>Keyword movement</h3>
          <p>Up: <strong>{stats.keywordUp}</strong></p>
          <p>Down: <strong>{stats.keywordDown}</strong></p>
          <p>Flat: <strong>{stats.keywordFlat}</strong></p>
        </article>

        <article className="card">
          <h3>Connection</h3>
          <p>Status: <strong>{stats.connectionState}</strong></p>
          <p className="muted">{stats.publishingStatus ? `Publishing: ${stats.publishingStatus}` : "Publishing normal"}</p>
        </article>
      </section>

      <section className="card">
        <h2>Activity</h2>
        {feed.length === 0 ? (
          <div className="empty">
            <p>No activity yet.</p>
          </div>
        ) : (
          <ul>
            {feed.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> — {item.description}
                <div className="muted">{item.timestampLabel}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        <p className="muted">{disclosure}</p>
      </footer>
    </main>
  );
}
