import type { JSX } from "react";
import { redirect } from "next/navigation";
import { resolveGbpContext } from "@/lib/gbp/access";
import {
  getWeeklyDigestSummaryForOrg,
  type WeeklyDigestSummary,
} from "@/lib/gbp/digest";
import { getDisclosureText } from "@/lib/gbp/disclosure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatPct(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0;
  return `${Math.round(clamped)}%`;
}

function formatDateTime(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  } catch {
    // Unknown IANA zone — fall back to a UTC render rather than throwing.
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  }
}

function postStatusLabel(status: string, isWarmup: boolean): string {
  const base =
    status === "published"
      ? "Published"
      : status === "awaiting_approval" || status === "needs_approval"
      ? "Waiting for your approval"
      : status === "scheduled"
      ? "Scheduled"
      : status === "failed"
      ? "Needs attention"
      : "Drafted";
  return isWarmup ? `${base} · warm-up` : base;
}

/**
 * Profile Activity Dashboard — the single-screen weekly log. A calm card grid:
 * an optional connection banner, one focal "This week" card (the actual post
 * preview), three secondary stat cards (reviews, keyword movement, connection),
 * a timestamped vertical activity feed in the owner's timezone, and the FTC
 * disclosure footer. The brand accent is reserved for the single primary action
 * (approve the post, or reconnect Google).
 */
export default async function GbpDashboardPage(): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    redirect("/login");
  }

  const summary: WeeklyDigestSummary = await getWeeklyDigestSummaryForOrg(
    ctx.orgId,
  );
  const tz = summary.ownerTimezone;
  const { connection, thisWeekPost } = summary;

  return (
    <main>
      <h1>This week on your profile</h1>
      <p>
        One view of your post, reviews, keyword movement, and connection — nothing
        to configure.
      </p>

      {(connection.paused || connection.suspended) && (
        <section className="card" aria-live="polite">
          <h2>{connection.suspended ? "Publishing suspended" : "Publishing paused"}</h2>
          <p className="muted">
            {connection.pausedReason?.trim() ||
              (connection.suspended
                ? "Google has suspended this profile. Posting and replies are on hold until it is reinstated."
                : "Publishing is paused for this location. We'll resume automatically once it's re-enabled.")}
          </p>
          <a className="btn" href="/connect">
            Review connection
          </a>
        </section>
      )}

      {connection.needsReconnect && (
        <section className="card" aria-live="polite">
          <h2>Reconnect your Google Business Profile</h2>
          <p className="muted">
            We can&apos;t reach Google right now, so posts and replies are on hold.
            Reconnecting takes about a minute.
          </p>
          <a className="btn" href="/connect">
            Reconnect Google
          </a>
        </section>
      )}

      <section className="card">
        <h2>This week</h2>
        {thisWeekPost ? (
          <>
            <p className="muted">
              {postStatusLabel(thisWeekPost.status, thisWeekPost.isWarmup)}
              {" · "}
              {thisWeekPost.publishedAt
                ? `Published ${formatDateTime(thisWeekPost.publishedAt, tz)}`
                : thisWeekPost.scheduledFor
                ? `Goes out ${formatDateTime(thisWeekPost.scheduledFor, tz)}`
                : "Scheduling…"}
            </p>
            {thisWeekPost.summary ? (
              <p>
                <strong>{thisWeekPost.summary}</strong>
              </p>
            ) : null}
            <p>{thisWeekPost.body}</p>
            {thisWeekPost.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thisWeekPost.photoUrl}
                alt="This week's post photo"
                style={{ maxWidth: "100%", borderRadius: "8px", marginTop: "8px" }}
              />
            ) : null}
            {thisWeekPost.needsApproval ? (
              <a className="btn" href={thisWeekPost.approveUrl}>
                Review &amp; approve
              </a>
            ) : (
              <a className="btn secondary" href={thisWeekPost.approveUrl}>
                View post
              </a>
            )}
          </>
        ) : (
          <div className="empty">
            <p>Your first post goes out Thursday.</p>
            <p className="muted">
              We&apos;re warming up your profile. There&apos;s nothing you need to do
              — your first weekly post is on its way.
            </p>
          </div>
        )}
      </section>

      <section aria-label="This week at a glance">
        <div className="card">
          <h3>Reviews</h3>
          <p>
            <strong>{summary.reviews.answered}</strong> answered
          </p>
          <p className="muted">
            {summary.reviews.waiting === 0
              ? "Nothing waiting"
              : `${summary.reviews.waiting} waiting for a reply`}
          </p>
        </div>
        <div className="card">
          <h3>Keyword movement</h3>
          {summary.keywords.tracked === 0 ? (
            <p className="muted">Tracking starts after your first week.</p>
          ) : (
            <>
              <p>
                <strong>{summary.keywords.up}</strong> up ·{" "}
                {summary.keywords.down} down · {summary.keywords.flat} steady
              </p>
              <p className="muted">
                Visibility score {formatPct(summary.keywords.score)}
              </p>
            </>
          )}
        </div>
        <div className="card">
          <h3>Connection</h3>
          <p>
            <strong>{connection.label}</strong>
          </p>
          <p className="muted">
            Last refreshed {formatDateTime(connection.lastRefreshedAt, tz)}
          </p>
        </div>
      </section>

      <section className="card">
        <h2>Activity</h2>
        {summary.activity.length === 0 ? (
          <div className="empty">
            <p>No activity yet.</p>
            <p className="muted">
              Posts, review replies, and ranking updates will show up here as they
              happen.
            </p>
          </div>
        ) : (
          <ul>
            {summary.activity.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <strong>{item.title}</strong>
                <div className="muted">{formatDateTime(item.occurredAt, tz)}</div>
                {item.detail ? <p>{item.detail}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="muted">
        <p>{getDisclosureText()}</p>
      </footer>
    </main>
  );
}
