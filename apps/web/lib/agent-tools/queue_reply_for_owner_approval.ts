import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  orgId?: unknown;
  locationId?: unknown;
  reviewId?: unknown;
  reviewResponseId?: unknown;
  draftReplyText?: unknown;
  sensitivityLabel?: unknown;
  sensitivityScore?: unknown;
  moderationResult?: unknown;
  claimsGuardResult?: unknown;
  flagReasons?: unknown;
  requestedByUserId?: unknown;
  ownerUserId?: unknown;
  notifyAt?: unknown;
  metadata?: unknown;
};

type JsonRecord = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v: string = value.trim();
  return v.length > 0 ? v : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
    .filter((v: string) => v.length > 0);
}

function toJson(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function getDb(ctx: HandlerContext): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
} {
  const maybeDb: unknown = (ctx as unknown as { db?: unknown }).db;
  if (
    !maybeDb ||
    typeof maybeDb !== "object" ||
    typeof (maybeDb as { query?: unknown }).query !== "function"
  ) {
    throw new Error("handler_context_missing_db");
  }
  return maybeDb as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
}

function buildReasons(args: Args): string[] {
  const provided: string[] = asStringArray(args.flagReasons);
  if (provided.length > 0) return provided;

  const reasons: string[] = [];
  const sensitivityLabel: string | null = asString(args.sensitivityLabel);
  const sensitivityScore: number | null = asNumber(args.sensitivityScore);

  if (sensitivityLabel && (sensitivityLabel.toLowerCase() === "elevated" || sensitivityLabel.toLowerCase() === "high")) {
    reasons.push(`sensitivity_${sensitivityLabel.toLowerCase()}`);
  } else if (sensitivityScore !== null && sensitivityScore >= 0.6) {
    reasons.push("sensitivity_elevated");
  }

  const moderation: JsonRecord = toJson(args.moderationResult);
  if (moderation.failed === true || moderation.allowed === false) {
    reasons.push("moderation_failed");
  }

  const claims: JsonRecord = toJson(args.claimsGuardResult);
  if (claims.failed === true || claims.allowed === false) {
    reasons.push("claims_guard_failed");
  }

  if (reasons.length === 0) reasons.push("manual_review_required");
  return reasons;
}

export async function handleQueueReplyForOwnerApproval(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const db = getDb(ctx);

    const orgId: string | null = asString(args.orgId);
    const locationId: string | null = asString(args.locationId);
    const reviewId: string | null = asString(args.reviewId);
    const draftReplyText: string | null = asString(args.draftReplyText);
    const reviewResponseId: string = asString(args.reviewResponseId) ?? randomUUID();

    if (!orgId || !locationId || !reviewId || !draftReplyText) {
      return {
        ok: false,
        error: "invalid_args",
        meta: {
          required: ["orgId", "locationId", "reviewId", "draftReplyText"],
        },
      };
    }

    const reasons: string[] = buildReasons(args);
    const moderationResult: JsonRecord = toJson(args.moderationResult);
    const claimsGuardResult: JsonRecord = toJson(args.claimsGuardResult);
    const metadata: JsonRecord = toJson(args.metadata);

    const sensitivityLabel: string | null = asString(args.sensitivityLabel);
    const sensitivityScore: number | null = asNumber(args.sensitivityScore);
    const requestedByUserId: string | null = asString(args.requestedByUserId);
    const ownerUserId: string | null = asString(args.ownerUserId);
    const notifyAtRaw: string | null = asString(args.notifyAt);
    const notifyAt: string = notifyAtRaw ?? new Date().toISOString();

    await db.query(
      `
      INSERT INTO gbp_review_responses (
        id,
        org_id,
        location_id,
        review_id,
        draft_reply,
        status,
        flag_reasons,
        sensitivity_label,
        sensitivity_score,
        moderation_result,
        claims_guard_result,
        metadata,
        requested_by_user_id,
        owner_user_id,
        queued_at,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,
        'pending_owner',
        $6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        draft_reply = EXCLUDED.draft_reply,
        status = 'pending_owner',
        flag_reasons = EXCLUDED.flag_reasons,
        sensitivity_label = EXCLUDED.sensitivity_label,
        sensitivity_score = EXCLUDED.sensitivity_score,
        moderation_result = EXCLUDED.moderation_result,
        claims_guard_result = EXCLUDED.claims_guard_result,
        metadata = EXCLUDED.metadata,
        requested_by_user_id = EXCLUDED.requested_by_user_id,
        owner_user_id = EXCLUDED.owner_user_id,
        updated_at = NOW()
      `,
      [
        reviewResponseId,
        orgId,
        locationId,
        reviewId,
        draftReplyText,
        JSON.stringify(reasons),
        sensitivityLabel,
        sensitivityScore,
        JSON.stringify(moderationResult),
        JSON.stringify(claimsGuardResult),
        JSON.stringify(metadata),
        requestedByUserId,
        ownerUserId,
      ],
    );

    await db.query(
      `
      INSERT INTO gbp_owner_notifications (
        id,
        org_id,
        location_id,
        review_response_id,
        notification_type,
        status,
        payload,
        scheduled_for,
        created_at,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,
        'owner_review_approval_required',
        'scheduled',
        $5,
        $6::timestamptz,
        NOW(),
        NOW()
      )
      `,
      [
        randomUUID(),
        orgId,
        locationId,
        reviewResponseId,
        JSON.stringify({
          reviewId,
          reasons,
          sensitivityLabel,
          sensitivityScore,
        }),
        notifyAt,
      ],
    );

    return {
      ok: true,
      data: {
        reviewResponseId,
        status: "pending_owner",
        reasons,
        notifyAt,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: "queue_reply_for_owner_approval_failed",
      meta: {
        message: error instanceof Error ? error.message : "unknown_error",
      },
    };
  }
}
