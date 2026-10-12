import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveGbpContext } from "@/lib/gbp/access";
import {
  approvePost,
  getPost,
  regeneratePost,
  skipPost,
  type GbpPostRecord,
  type GbpPostStatus,
} from "@/lib/gbp/post-publisher";
import type { VarianceResult } from "@/lib/gbp/variance-guard";
import type { ClaimsResult } from "@/lib/gbp/claims-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABELS: Record<GbpPostStatus, string> = {
  published: "Published",
  scheduled: "Scheduled",
  needs_approval: "Needs your OK",
  failed: "Failed",
  skipped: "Skipped",
};

const CTA_LABELS: Record<string, string> = {
  "call-now": "Call now",
  "book-online": "Book online",
  "request-quote": "Request a quote",
  "learn-more": "Learn more",
};

function ScoreBar({ score }: { score: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 80 ? "#15803d" : clamped >= 50 ? "#b45309" : "#b91c1c";
  return (
    <div
      aria-label={`Score ${clamped} out of 100`}
      style={{
        background: "rgba(0,0,0,0.08)",
        borderRadius: "999px",
        height: "10px",
        overflow: "hidden",
        margin: "0.4rem 0",
      }}
    >
      <div style={{ width: `${clamped}%`, background: color, height: "100%" }} />
    </div>
  );
}

function CheckRow({ passed, label, detail }: { passed: boolean; label: string; detail: string }): JSX.Element {
  return (
    <li style={{ marginBottom: "0.4rem" }}>
      <span aria-hidden="true" style={{ marginRight: "0.4rem" }}>
        {passed ? "✅" : "⚠️"}
      </span>
      <strong>{label}</strong>
      <br />
      <span className="muted">{detail}</span>
    </li>
  );
}

function isVariance(detail: unknown): detail is VarianceResult {
  return typeof detail === "object" && detail !== null && Array.isArray((detail as VarianceResult).checks);
}

function isClaims(detail: unknown): detail is ClaimsResult {
  return typeof detail === "object" && detail !== null && Array.isArray((detail as ClaimsResult).violations);
}

function GuardPanels({ post }: { post: GbpPostRecord }): JSX.Element {
  const variance = post.varianceDetail;
  const claims = post.claimsDetail;
  return (
    <section aria-label="Content checks" style={{ marginTop: "1.5rem" }}>
      <h2>Content checks (in plain language)</h2>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Freshness &amp; variety</h3>
        {isVariance(variance) ? (
          <>
            <p className="muted">{variance.summary}</p>
            <ScoreBar score={variance.score} />
            <ul style={{ listStyle: "none", paddingLeft: 0 }}>
              {variance.checks.map((c) => (
                <CheckRow key={c.code} passed={c.passed} label={c.label} detail={c.detail} />
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">
            {post.variancePassed ? "Passed the freshness checks." : "Did not pass the freshness checks."}
          </p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Safe-to-publish claims</h3>
        {isClaims(claims) ? (
          <>
            <p className="muted">{claims.summary}</p>
            <ScoreBar score={claims.score} />
            {claims.violations.length === 0 ? (
              <p className="muted">
                No prices, guarantees, license numbers or made-up jobs — all clear.
              </p>
            ) : (
              <ul style={{ listStyle: "none", paddingLeft: 0 }}>
                {claims.violations.map((v, i) => (
                  <CheckRow
                    key={`${v.code}-${i}`}
                    passed={false}
                    label={v.message}
                    detail={`Found: "${v.evidence}"`}
                  />
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">
            {post.claimsPassed ? "Passed the claims checks." : "Did not pass the claims checks."}
          </p>
        )}
      </div>
    </section>
  );
}

export default async function PostDetailPage({
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

  const post = await getPost(params.id);
  if (!post || post.orgId !== ctx.orgId) {
    notFound();
  }

  async function approve(): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    await approvePost(params.id, inner.userId);
    revalidatePath(`/posts/${params.id}`);
    revalidatePath("/posts");
    redirect("/posts");
  }

  async function regenerate(): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    await regeneratePost(params.id, inner.userId);
    revalidatePath(`/posts/${params.id}`);
  }

  async function skip(): Promise<void> {
    "use server";
    const inner = await resolveGbpContext();
    if (!inner) redirect("/login");
    await skipPost(params.id, inner.userId);
    revalidatePath("/posts");
    redirect("/posts");
  }

  const canAct = post.status === "needs_approval" || post.status === "failed";

  return (
    <main>
      <p className="muted">
        <Link href="/posts">← All posts</Link>
      </p>
      <h1>Post — {STATUS_LABELS[post.status]}</h1>
      <p className="muted">
        {post.serviceCity ? `${post.serviceCity} · ` : ""}
        {post.serviceLine} · {post.season}
        {post.isWarmup ? " · warm-up" : ""}
      </p>

      {post.failureReason ? (
        <div className="card" role="alert" style={{ borderColor: "#b45309" }}>
          <strong>Why this is waiting for you:</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            {post.failureReason}
          </p>
        </div>
      ) : null}

      <article className="card" style={{ marginTop: "1rem" }}>
        {post.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.photoUrl}
            alt=""
            style={{
              width: "100%",
              maxHeight: "300px",
              objectFit: "cover",
              borderRadius: "8px",
              marginBottom: "0.75rem",
            }}
          />
        ) : null}
        <p style={{ whiteSpace: "pre-wrap" }}>{post.body}</p>
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
      </article>

      <GuardPanels post={post} />

      {canAct ? (
        <section aria-label="Actions" style={{ marginTop: "1.5rem" }}>
          <h2>Your call</h2>
          <div className="toolbar">
            <form action={approve}>
              <button type="submit">Approve &amp; publish</button>
            </form>
            <form action={regenerate}>
              <button type="submit" className="secondary">
                Regenerate
              </button>
            </form>
            <form action={skip}>
              <button type="submit" className="secondary">
                Skip this week
              </button>
            </form>
          </div>
          <p className="muted">
            Approve publishes it to Google now. Regenerate writes a fresh version.
            Skip retires it with no post this week.
          </p>
        </section>
      ) : null}
    </main>
  );
}
