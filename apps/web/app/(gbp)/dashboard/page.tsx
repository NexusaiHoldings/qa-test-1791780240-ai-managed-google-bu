import { redirect } from "next/navigation";
import { getServerSession } from "@nexus/identity-and-access";
import { getWeeklyDigestSummaryForSessionUser } from "@/lib/gbp/digest";
import { getDisclosureText } from "@/lib/gbp/disclosure";

function formatPct(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0;
  return `${Math.round(clamped)}%`;
}

function formatDateTime(
  iso: string | null,
  timezone: string,
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}

export default async function GbpDashboardPage(): Promise<JSX.Element> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const summary = await getWeeklyDigestSummaryForSessionUser(session.user.id);

  const isPaused = summary.connection.connectionState === "paused";
  const isSuspended = summary.connection.connectionState === "suspended";
  const needsReconnect =
    summary.connection.connectionState === "disconnected" ||
    summary.connection.connectionState === "expired";

  return (
    <main>
      <h1>Profile Activity Dashboard</h1>
      <p>
        One weekly view of posts, reviews, rankings, and connection health for your
        Google Business Profile.
      </p>

      {(isPaused || isSuspended) && (
        <section className="card" aria-live="polite">
          <h2>{isSuspended ? "Publishing suspended" : "Publishing paused"}</h2>
          <p className="muted">
            {summary.connection.pausedReason?.trim() ||
              "Publishing is currently paused for this location."}
          </p>
        </section>
      )}

      <section className="card">
        <h2>This week</h2>
        {summary.thisWeekPost ? (
          <>
            <p className="muted">
              Scheduled:{" "}
              {formatDateTime(
                summary.thisWeekPost.scheduledFor,
                summary.ownerTimezone,
              )}
            </p>
            <p>{summary.thisWeekPost.body}</p>
            {summary.thisWeekPost.status === "awaiting_approval" ? (
              <a className="btn" href={summary.thisWeekPost.approveUrl}>
                Approve post
              </a>
            ) : needsReconnect ? (
              <a className="btn" href="/gbp/connect">
                Reconnect Google
              </a>
            ) : (
              <p className="muted">No action needed.</p>
            )}
          </>
        ) : (
          <div className="empty">
            <p>Your first post goes out Thursday.</p>
          </div>
        )}
      </section>

      <section>
        <div className="card">
          <h3>Reviews</h3>
          <p>
            {summary.reviews.answered} answered · {summary.reviews.waiting} waiting
          </p>
        </div>
        <div className="card">
          <h3>Keyword movement</h3>
          <p>
            {summary.keywords.up} up · {summary.keywords.down} down ·{" "}
            {summary.keywords.flat} flat
          </p>
          <p className="muted">Visibility score: {formatPct(summary.keywords.score)}</p>
        </div>
        <div className="card">
          <h3>Connection</h3>
          <p>{summary.connection.label}</p>
          <p className="muted">
            Last refresh:{" "}
            {formatDateTime(summary.connection.lastRefreshedAt, summary.ownerTimezone)}
          </p>
        </div>
      </section>

      <section className="card">
        <h2>Activity</h2>
        {summary.activity.length === 0 ? (
          <div className="empty">
            <p>No activity yet. We’ll show posting, review, and ranking updates here.</p>
          </div>
        ) : (
          <ul>
            {summary.activity.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <div className="muted">
                  {formatDateTime(item.occurredAt, summary.ownerTimezone)}
                </div>
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
