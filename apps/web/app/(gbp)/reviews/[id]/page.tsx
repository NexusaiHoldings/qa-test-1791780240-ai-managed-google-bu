import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveGbpContext } from "@/lib/gbp/access";
import {
  approveReply,
  dontReply,
  editAndPostReply,
  getReview,
  type GbpReviewRecord,
  type ReviewReplyStatus,
} from "@/lib/gbp/review-responder";
import type { SensitivityLevel } from "@/lib/gbp/review-sensitivity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABELS: Record<ReviewReplyStatus, string> = {
  pending: "Being drafted",
  queued: "Needs your OK",
  auto_published: "Answered automatically",
  published: "Answered",
  skipped: "No reply",
  failed: "Couldn't post",
};

const SENSITIVITY_LABELS: Record<SensitivityLevel, string> = {
  low: "Low sensitivity",
  elevated: "Elevated — needs your review",
  high: "High — possible legal matter",
};

function Stars({ rating }: { rating: number }): JSX.Element {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span aria-label={`${full} out of 5 stars`} style={{ letterSpacing: "0.1em", fontSize: "1.2rem" }}>
      <span style={{ color: "#d97706" }}>{"★".repeat(full)}</span>
      <span className="muted">{"☆".repeat(5 - full)}</span>
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default async function ReviewDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    redirect("/login");
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(params.id)) {
    notFound();
  }

  const review = await getReview(params.id);
  if (!review || review.orgId !== ctx.orgId) {
    notFound();
  }

  async function approve(): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    await approveReply(params.id, inner.userId);
    revalidatePath(`/reviews/${params.id}`);
    revalidatePath("/reviews");
    redirect("/reviews");
  }

  async function editAndPost(formData: FormData): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    const text = String(formData.get("reply") ?? "").trim();
    if (!text) {
      revalidatePath(`/reviews/${params.id}`);
      return;
    }
    await editAndPostReply(params.id, text, inner.userId);
    revalidatePath(`/reviews/${params.id}`);
    revalidatePath("/reviews");
    redirect("/reviews");
  }

  async function skip(): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    await dontReply(params.id, inner.userId);
    revalidatePath("/reviews");
    redirect("/reviews");
  }

  const canAct = review.replyStatus === "queued" || review.replyStatus === "failed";
  const isAnswered =
    review.replyStatus === "published" || review.replyStatus === "auto_published";

  return (
    <main>
      <p className="muted">
        <Link href="/reviews">← All reviews</Link>
      </p>
      <h1>Review — {STATUS_LABELS[review.replyStatus]}</h1>
      <p className="muted">
        {SENSITIVITY_LABELS[review.sensitivity]} ·{" "}
        {review.reviewerDisplayName} · {formatDate(review.reviewCreateTime ?? review.createdAt)}
      </p>

      {review.sensitivity === "high" ? (
        <div className="card" role="note" style={{ borderColor: "#b45309", background: "rgba(180,83,9,0.06)" }}>
          <p style={{ margin: 0 }}>
            <strong>This looks like a legal matter.</strong>{" "}
            <span className="muted">
              Before replying publicly, consider talking to counsel. The draft below is deliberately
              neutral — it admits no fault and promises nothing.
            </span>
          </p>
        </div>
      ) : null}

      <ReviewAndDraft
        review={review}
        canAct={canAct}
        isAnswered={isAnswered}
        approve={approve}
        editAndPost={editAndPost}
        skip={skip}
      />
    </main>
  );
}

function WhyFlagged({ review }: { review: GbpReviewRecord }): JSX.Element | null {
  if (review.sensitivityReasons.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Why this needs you</h3>
      <ul>
        {review.sensitivityReasons.map((reason, i) => (
          <li key={`${reason.category}-${i}`} className="muted">
            {reason.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewAndDraft({
  review,
  canAct,
  isAnswered,
  approve,
  editAndPost,
  skip,
}: {
  review: GbpReviewRecord;
  canAct: boolean;
  isAnswered: boolean;
  approve: () => Promise<void>;
  editAndPost: (formData: FormData) => Promise<void>;
  skip: () => Promise<void>;
}): JSX.Element {
  return (
    <section
      aria-label="Review and reply"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "1.5rem",
        marginTop: "1.5rem",
        alignItems: "start",
      }}
    >
      <article className="card">
        <Stars rating={review.starRating} />
        <h2 style={{ marginTop: "0.5rem" }}>What they wrote</h2>
        {review.hadComment ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{review.commentRedacted}</p>
        ) : (
          <p className="muted">They left a star rating with no written comment.</p>
        )}
        <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
          Personal details (names, phone numbers, addresses) are removed automatically before
          anything is stored or drafted.
        </p>
        <WhyFlagged review={review} />
      </article>

      <article className="card">
        <h2 style={{ marginTop: 0 }}>
          {isAnswered ? "Your published reply" : "Suggested reply"}
        </h2>

        {isAnswered ? (
          <>
            <p style={{ whiteSpace: "pre-wrap" }}>{review.publishedReply ?? review.draftReply}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              {review.replyStatus === "auto_published"
                ? "Published automatically after passing the safety checks."
                : "Published after your approval."}
            </p>
          </>
        ) : canAct ? (
          <>
            {review.failureReason && review.replyStatus === "failed" ? (
              <p className="muted" role="alert">
                We couldn&rsquo;t post the last attempt: {review.failureReason}
              </p>
            ) : null}
            <form action={editAndPost}>
              <label htmlFor="reply">
                <strong>Edit before posting</strong>
              </label>
              <textarea
                id="reply"
                name="reply"
                rows={6}
                defaultValue={review.draftReply ?? ""}
                style={{ width: "100%", marginTop: "0.5rem" }}
              />
              <div className="toolbar" style={{ marginTop: "0.75rem" }}>
                <button type="submit">Edit &amp; post</button>
              </div>
            </form>

            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <form action={approve}>
                <button type="submit" className="secondary">
                  Approve as-is
                </button>
              </form>
              <form action={skip}>
                <button type="submit" className="secondary">
                  Don&rsquo;t reply
                </button>
              </form>
            </div>
            <p className="muted" style={{ marginTop: "0.5rem" }}>
              Approve posts the draft to Google as-is. Edit &amp; post publishes your wording.
              Don&rsquo;t reply retires this review with no public response.
            </p>
          </>
        ) : (
          <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
            {review.replyStatus === "skipped"
              ? "You chose not to reply to this review."
              : review.draftReply ?? "A draft is being prepared."}
          </p>
        )}
      </article>
    </section>
  );
}
