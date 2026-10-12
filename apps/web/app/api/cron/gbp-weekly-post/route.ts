import { NextRequest, NextResponse } from "next/server";
import {
  listActiveSlots,
  runWeeklyPostForSlot,
  type WeeklyRunResult,
} from "@/lib/gbp/post-publisher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Weekly GBP post publisher cron (F1-005).
 *
 * Vercel fires this on the weekly schedule. For every active publish slot it
 * runs the full loop — pick template + service-area city + least-recently-used
 * owner photo, generate a voice-matched post, run the variance + claims guards
 * (regenerating up to 3×), then publish via the GBP localPosts endpoint and log
 * an audit event. During warm-up the first two posts queue for one-tap owner
 * approval instead of publishing. Each slot is handled independently so one
 * failure never aborts the batch.
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

  const force = request.nextUrl.searchParams.get("force") === "1";

  let slots;
  try {
    slots = await listActiveSlots();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_weekly_slots_query_failed",
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return NextResponse.json(
      { ok: false, error: "slot_query_failed" },
      { status: 500 },
    );
  }

  const results: WeeklyRunResult[] = [];
  let published = 0;
  let queued = 0;
  let failed = 0;

  for (const slot of slots) {
    const result = await runWeeklyPostForSlot(slot, { force });
    results.push(result);
    if (result.published) published += 1;
    if (result.queued) queued += 1;
    if (result.status === "failed" || result.status === "error") failed += 1;
  }

  console.info(
    JSON.stringify({
      level: "info",
      msg: "gbp_weekly_post_run",
      slots: slots.length,
      published,
      queued,
      failed,
    }),
  );

  return NextResponse.json({
    ok: true,
    slots: slots.length,
    published,
    queued,
    failed,
    results,
  });
}
