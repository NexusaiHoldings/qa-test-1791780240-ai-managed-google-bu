import type { JSX } from "react";
import Link from "next/link";
import { resolveGbpContext } from "@/lib/gbp/access";
import {
  getReviewCounts,
  listReviews,
  type GbpReviewRecord,
} from "@/lib/gbp/review-responder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function Stars({ rating }: { rating: number }): JSX.Element {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span aria-label={`${full} out of 5 stars`} style={{ letterSpacing: "0.1em" }}>
      <span style={{ color: "#d97706" }}>{"★".repeat(full)}</span>
      <span className="muted">{"☆".repeat(5 - full)}</span>
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function excerpt(text: string | null, max = 180): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A warm-accent card for a review waiting on the owner. */
function QueueCard({ review }: { review: GbpReviewRecord }): JSX.Element {
  const why = review.sensitivityReasons[0]?.label ?? "This one needs your eyes before we reply.";
  return (
    <article
      className="card"
      style={{
        marginBottom: "1rem",
        borderColor: review.sensitivity === "high" ? "#b45309" : "#d97706",
        background: "linear-gradient(135deg, rgba(217,119,6,0.08), transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <Stars rating={review.starRating} />
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {review.reviewerDisplayName} · {formatDate(review.reviewCreateTime ?? review.createdAt)}
        </span>
      </div>

      {review.hadComment ? (
        <p style={{ marginBottom: "0.5rem" }}>{excerpt(review.commentRedacted)}</p>
      ) : (
        <p className="muted" style={{ marginBottom: "0.5rem" }}>
          Star rating only — no written comment.
        </p>
      )}

      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        <strong style={{ color: review.sensitivity === "high" ? "#b45309" : "#d97706" }}>
          Why it&rsquo;s here:
        </strong>{" "}
        {why}
      </p>

      <Link className="btn" href={`/reviews/${review.id}`}>
        Review &amp; reply →
      </Link>
    </article>
  );
}

/** A muted card for a review we already answered, with the reply inline. */
function AnsweredCard({ review }: { review: GbpReviewRecord }): JSX.Element {
  return (
    <article className="card" style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.4rem",
        }}
      >
        <Stars rating={review.starRating} />
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {review.reviewerDisplayName} · {formatDate(review.reviewCreateTime ?? review.createdAt)}
        </span>
      </div>

      {review.hadComment ? (
        <p className="muted" style={{ marginBottom: "0.5rem" }}>
          {excerpt(review.commentRedacted, 140)}
        </p>
      ) : null}

      {review.publishedReply ? (
        <div
          style={{
            borderLeft: "3px solid var(--border, #d1d5db)",
            paddingLeft: "0.75rem",
            marginTop: "0.5rem",
          }}
        >
          <span className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Your reply
          </span>
          <p style={{ margin: "0.25rem 0 0" }}>{review.publishedReply}</p>
        </div>
      ) : null}

      <div style={{ marginTop: "0.5rem" }}>
        <Link className="muted" href={`/reviews/${review.id}`}>
          View details →
        </Link>
      </div>
    </article>
  );
}

export default async function ReviewsPage(): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    return (
      <main>
        <h1>Reviews</h1>
        <p className="muted">
          Please <a href="/login">log in</a> to see your Google reviews.
        </p>
      </main>
    );
  }

  const [reviews, counts] = await Promise.all([
    listReviews(ctx.orgId),
    getReviewCounts(ctx.orgId),
  ]);

  const needsYou = reviews.filter((r) => r.replyStatus === "queued");
  const answered = reviews.filter(
    (r) => r.replyStatus === "published" || r.replyStatus === "auto_published",
  );

  return (
    <main>
      <h1>Reviews</h1>
      <p>
        Every review gets answered in your voice, usually within a day. The ones
        that need your judgment wait up top; everything else is already handled.
      </p>

      <section aria-label="Needs you" style={{ marginTop: "1.5rem" }}>
        <h2>Needs you</h2>
        {needsYou.length === 0 ? (
          <div className="empty">
            <p aria-hidden="true" style={{ fontSize: "2.5rem" }}>
              🎉
            </p>
            <h3 style={{ margin: "0.25rem 0" }}>All caught up</h3>
            <p className="muted">
              {counts.answeredThisMonth > 0
                ? `${counts.answeredThisMonth} review${counts.answeredThisMonth === 1 ? "" : "s"} answered this month — nothing needs you right now.`
                : "Nothing needs you right now. New reviews will show up here if they need a closer look."}
            </p>
          </div>
        ) : (
          needsYou.map((review) => <QueueCard key={review.id} review={review} />)
        )}
      </section>

      <section aria-label="Answered automatically" style={{ marginTop: "2rem" }}>
        <h2>Answered automatically</h2>
        {answered.length === 0 ? (
          <p className="muted">
            No auto-answered reviews yet. Once your warm-up replies are approved,
            low-risk reviews publish on their own.
          </p>
        ) : (
          answered.map((review) => <AnsweredCard key={review.id} review={review} />)
        )}
      </section>
    </main>
  );
}
