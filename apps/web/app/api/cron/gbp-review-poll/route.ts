import { NextRequest, NextResponse } from "next/server";
import { syncAllConnections } from "@/lib/gbp/review-sync";
import { escalateStaleReviews } from "@/lib/gbp/review-responder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GBP review poll cron (F1-006).
 *
 * Vercel fires this every 6 hours as the reliability backstop behind the Pub/Sub
 * push webhook: for every active connection it pulls the latest reviews, mirrors
 * new ones (PII-redacted + sensitivity-classified), drafts a reply, and either
 * auto-publishes LOW-risk replies (after the 3-reply warm-up) or queues
 * ELEVATED/HIGH ones for the owner with a notification. It then escalates any
 * queued review the owner hasn't acted on within the escalation window (72h) to a
 * support ticket. Each connection is handled independently so one failure never
 * aborts the batch.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET` when configured.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  let sync;
  try {
    sync = await syncAllConnections();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_poll_sync_failed",
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 500 });
  }

  let escalated = 0;
  try {
    escalated = await escalateStaleReviews();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_poll_escalation_failed",
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }

  console.info(
    JSON.stringify({
      level: "info",
      msg: "gbp_review_poll_run",
      connections: sync.connections,
      fetched: sync.fetched,
      ingested: sync.ingested,
      autoPublished: sync.autoPublished,
      queued: sync.queued,
      failed: sync.failed,
      escalated,
    }),
  );

  return NextResponse.json({
    ok: true,
    connections: sync.connections,
    fetched: sync.fetched,
    ingested: sync.ingested,
    autoPublished: sync.autoPublished,
    queued: sync.queued,
    failed: sync.failed,
    escalated,
  });
}
