import { NextRequest, NextResponse } from "next/server";
import { getConnectionByLocation, syncReviewsForConnection } from "@/lib/gbp/review-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Google Cloud Pub/Sub push webhook for GBP notifications (F1-006).
 *
 * Google delivers a NEW_REVIEW (and related) notification as a Pub/Sub push: a
 * POST whose JSON body is `{ message: { data: <base64>, attributes }, subscription }`.
 * The base64 `data` decodes to a JSON payload carrying the affected location and a
 * notification type. On a review notification we resolve the connection for that
 * location and run an immediate review sync so the 24-hour reply SLA does not wait
 * for the 6-hourly poll.
 *
 * Pub/Sub expects a 2xx ack; we therefore return 200 even for no-ops (unknown
 * location, non-review notification) so Google does not redeliver endlessly. A
 * shared-secret token (GBP_PUBSUB_TOKEN) may be enforced via `?token=` or a
 * Bearer header when configured.
 */

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    message_id?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface GbpNotification {
  location?: string;
  notificationType?: string;
  notification_type?: string;
  notificationTypes?: string[];
  notification_types?: string[];
}

const REVIEW_NOTIFICATION_TYPES = new Set([
  "NEW_REVIEW",
  "UPDATED_REVIEW",
  "NEW_REVIEW_REPLY",
]);

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.GBP_PUBSUB_TOKEN;
  if (!expected) return true; // no token configured → accept (dev/preview)
  const queryToken = request.nextUrl.searchParams.get("token");
  if (queryToken && queryToken === expected) return true;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${expected}`) return true;
  return false;
}

function decodePayload(envelope: PubSubEnvelope): GbpNotification | null {
  const data = envelope.message?.data;
  if (!data) return null;
  try {
    const json = Buffer.from(data, "base64").toString("utf8");
    return JSON.parse(json) as GbpNotification;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let envelope: PubSubEnvelope;
  try {
    envelope = (await request.json()) as PubSubEnvelope;
  } catch {
    // Malformed body — ack so Pub/Sub stops retrying a bad message.
    return NextResponse.json({ ok: true, skipped: "invalid_json" });
  }

  const payload = decodePayload(envelope);
  if (!payload || !payload.location) {
    return NextResponse.json({ ok: true, skipped: "no_location" });
  }

  const types = [
    payload.notificationType,
    payload.notification_type,
    ...(payload.notificationTypes ?? []),
    ...(payload.notification_types ?? []),
  ]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => t.toUpperCase());
  // When a type is present but none are review-related, skip; if no type at all,
  // fall through and sync (the location was named, which is enough).
  if (types.length > 0 && !types.some((t) => REVIEW_NOTIFICATION_TYPES.has(t))) {
    return NextResponse.json({ ok: true, skipped: "non_review_notification", types });
  }

  const connection = await getConnectionByLocation(payload.location);
  if (!connection) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "gbp_webhook_no_connection",
        location: payload.location,
      }),
    );
    return NextResponse.json({ ok: true, skipped: "no_connection" });
  }

  try {
    const result = await syncReviewsForConnection(connection);
    console.info(
      JSON.stringify({
        level: "info",
        msg: "gbp_webhook_sync",
        connectionId: connection.id,
        fetched: result.fetched,
        ingested: result.ingested,
        processed: result.processed.length,
      }),
    );
    return NextResponse.json({
      ok: true,
      connectionId: connection.id,
      ingested: result.ingested,
      processed: result.processed.length,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_webhook_sync_failed",
        connectionId: connection.id,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    // Ack anyway; the 6-hourly poll is the backstop.
    return NextResponse.json({ ok: true, error: "sync_failed" });
  }
}
