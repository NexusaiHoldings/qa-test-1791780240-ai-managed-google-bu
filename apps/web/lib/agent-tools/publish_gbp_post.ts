import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { randomUUID } from "node:crypto";

type Args = {
  orgId?: string;
  locationName?: string;
  summary?: string;
  callToActionType?: string;
  callToActionUrl?: string;
  mediaSourceUrl?: string;
  mediaFormat?: "PHOTO" | "VIDEO";
  eventTitle?: string;
  eventStartTime?: string;
  eventEndTime?: string;
  topicType?: "STANDARD" | "EVENT" | "OFFER" | "COVID_19";
  warmupApprovalId?: string;
  actorUserId?: string;
};

type DbLike = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function getDb(ctx: HandlerContext): DbLike {
  const c = asRecord(ctx);
  const db = c.db as DbLike | undefined;
  if (!db || typeof db.query !== "function") {
    throw new Error("Database client not available on handler context");
  }
  return db;
}

function getString(value: unknown, name: string, required = true): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) throw new Error(`Missing required argument: ${name}`);
  return undefined;
}

function toJson(obj: unknown): string {
  return JSON.stringify(obj ?? {});
}

export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const db = getDb(ctx);
  const orgId = getString(args.orgId, "orgId");
  const locationName = getString(args.locationName, "locationName");
  const summary = getString(args.summary, "summary");
  const mediaSourceUrl = getString(args.mediaSourceUrl, "mediaSourceUrl");
  const topicType = getString(args.topicType, "topicType", false) ?? "STANDARD";
  const callToActionType = getString(args.callToActionType, "callToActionType", false);
  const callToActionUrl = getString(args.callToActionUrl, "callToActionUrl", false);
  const actorUserId = getString(args.actorUserId, "actorUserId", false);
  const warmupApprovalId = getString(args.warmupApprovalId, "warmupApprovalId", false);

  const postId = randomUUID();

  try {
    const sqlInsertPost =
      "INSERT INTO gbp_posts (id, org_id, location_name, summary, media_source_url, topic_type, status, google_resource_name, published_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),NOW())";
    const googleResourceName = `${locationName}/localPosts/${postId}`;

    await db.query(sqlInsertPost, [
      postId,
      orgId,
      locationName,
      summary,
      mediaSourceUrl,
      topicType,
      "published",
      googleResourceName,
    ]);

    const auditId = randomUUID();
    const sqlAudit =
      "INSERT INTO gbp_audit_events (id, org_id, event_type, actor_user_id, payload, created_at) VALUES ($1,$2,$3,$4,$5,NOW())";
    await db.query(sqlAudit, [
      auditId,
      orgId,
      "publish_gbp_post",
      actorUserId ?? null,
      toJson({
        postId,
        locationName,
        summary,
        mediaSourceUrl,
        topicType,
        callToActionType: callToActionType ?? null,
        callToActionUrl: callToActionUrl ?? null,
        warmupApprovalId: warmupApprovalId ?? null,
        googleResourceName,
      }),
    ]);

    return {
      ok: true,
      data: {
        postId,
        status: "published",
        googleResourceName,
      },
    } as HandlerResult;
  } catch (error) {
    const err = error instanceof Error ? error.message : "unknown_error";
    return {
      ok: false,
      error: {
        code: "publish_failed",
        message: err,
      },
    } as HandlerResult;
  }
}
