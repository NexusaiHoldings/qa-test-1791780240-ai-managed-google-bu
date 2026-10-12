import type { JSX } from "react";
import Link from "next/link";
import { resolveGbpContext } from "@/lib/gbp/access";
import {
  getSlotForOrg,
  listPosts,
  nextSlotDate,
  type GbpPostRecord,
  type GbpPostStatus,
} from "@/lib/gbp/post-publisher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const STATUS_LABELS: Record<GbpPostStatus, string> = {
  published: "Published",
  scheduled: "Scheduled",
  needs_approval: "Needs your OK",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_COLORS: Record<GbpPostStatus, string> = {
  published: "#15803d",
  scheduled: "#1d4ed8",
  needs_approval: "#b45309",
  failed: "#b91c1c",
  skipped: "#6b7280",
};

function StatusPill({ status }: { status: GbpPostStatus }): JSX.Element {
  return (
    <span
      className="muted"
      style={{
        display: "inline-block",
        padding: "0.15rem 0.6rem",
        borderRadius: "999px",
        border: `1px solid ${STATUS_COLORS[status]}`,
        color: STATUS_COLORS[status],
        fontSize: "0.8rem",
        fontWeight: 600,
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const CTA_LABELS: Record<string, string> = {
  "call-now": "Call now",
  "book-online": "Book online",
  "request-quote": "Request a quote",
  "learn-more": "Learn more",
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** A single published post rendered as a realistic Google-post preview card. */
function PostPreview({ post }: { post: GbpPostRecord }): JSX.Element {
  return (
    <article className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <StatusPill status={post.status} />
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {post.status === "published"
            ? formatDate(post.publishedAt)
            : formatDate(post.scheduledFor ?? post.createdAt)}
        </span>
      </div>

      {post.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.photoUrl}
          alt=""
          style={{
            width: "100%",
            maxHeight: "260px",
            objectFit: "cover",
            borderRadius: "8px",
            marginBottom: "0.75rem",
          }}
        />
      ) : null}

      <p style={{ whiteSpace: "pre-wrap" }}>{post.body}</p>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          marginTop: "0.75rem",
        }}
      >
        <span
          style={{
            border: "1px solid var(--border, #d1d5db)",
            borderRadius: "999px",
            padding: "0.3rem 0.9rem",
            fontWeight: 600,
            fontSize: "0.85rem",
          }}
        >
          {CTA_LABELS[post.ctaType ?? "learn-more"] ?? "Learn more"}
        </span>
        <Link className="muted" href={`/posts/${post.id}`}>
          View details →
        </Link>
      </div>
    </article>
  );
}

export default async function PostsPage(): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    return (
      <main>
        <h1>Your posts</h1>
        <p className="muted">
          Please <a href="/login">log in</a> to see your Google Business Profile
          posts.
        </p>
      </main>
    );
  }

  const [posts, slot] = await Promise.all([
    listPosts(ctx.orgId),
    getSlotForOrg(ctx.orgId),
  ]);

  const nextDate = slot ? nextSlotDate(slot, new Date()) : null;
  const nextLabel = nextDate
    ? `${DAY_NAMES[nextDate.getUTCDay()]} ${String(nextDate.getUTCHours()).padStart(2, "0")}:${String(
        nextDate.getUTCMinutes(),
      ).padStart(2, "0")}`
    : null;

  return (
    <main>
      <h1>Your posts</h1>
      <p>
        Every week we publish a fresh, locally-specific post to your Google
        Business Profile — using your own photos and your voice.
      </p>

      {slot ? (
        <div
          className="card"
          style={{
            background: "linear-gradient(135deg, rgba(29,78,216,0.08), transparent)",
            marginBottom: "1.5rem",
          }}
        >
          <h2 style={{ marginTop: 0 }}>
            {nextLabel ? `Next post lands ${nextLabel}` : "Weekly posting is on"}
          </h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            {slot.warmupPostsRemaining > 0
              ? `You're in warm-up: the next ${slot.warmupPostsRemaining} post${
                  slot.warmupPostsRemaining > 1 ? "s" : ""
                } will wait for your one-tap OK before going live.`
              : "Posts publish automatically once they pass the content checks."}
          </p>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ marginTop: 0 }}>Weekly posting isn&rsquo;t set up yet</h2>
          <p className="muted">
            Connect a location to pick your weekly publish slot and voice.
          </p>
          <Link className="btn" href="/connect">
            Connect Google
          </Link>
        </div>
      )}

      {posts.length === 0 ? (
        <div className="empty">
          <p aria-hidden="true" style={{ fontSize: "2.5rem" }}>
            📸
          </p>
          <h2>No posts yet</h2>
          <p className="muted">
            Your first weekly post starts with a photo. Upload a shot of a recent
            job, your team or your truck and we&rsquo;ll turn it into a post.
          </p>
          <Link className="btn" href="/photos">
            Upload your first photo
          </Link>
        </div>
      ) : (
        <section aria-label="Post timeline">
          {posts.map((post) => (
            <PostPreview key={post.id} post={post} />
          ))}
        </section>
      )}
    </main>
  );
}
