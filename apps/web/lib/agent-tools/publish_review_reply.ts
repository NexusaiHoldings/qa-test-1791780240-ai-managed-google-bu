import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  reviewResponseId?: unknown;
  approvedText?: unknown;
  actorType?: unknown;
  actorId?: unknown;
  approvedAt?: unknown;
  metadata?: unknown;
};

type DbClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveDb(ctx: HandlerContext): DbClient | null {
  const maybeDb = (ctx as Record<string, unknown>)?.db as DbClient | undefined;
  return maybeDb && typeof maybeDb.query === "function" ? maybeDb : null;
}

async function callUpdateReply(
  ctx: HandlerContext,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; providerReply?: string; providerPayload?: unknown; error?: string }> {
  const maybeFn = (ctx as Record<string, unknown>)?.gbp?.reviews?.updateReply;
  if (typeof maybeFn === "function") {
    try {
      const result = await (maybeFn as (p: Record<string, unknown>) => Promise<unknown>)(payload);
      const providerReply =
        typeof (result as Record<string, unknown>)?.comment === "string"
          ? ((result as Record<string, unknown>).comment as string)
          : undefined;
      return { ok: true, providerReply, providerPayload: result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "reviews.updateReply failed",
      };
    }
  }

  return {
    ok: false,
    error: "GBP client unavailable on HandlerContext (ctx.gbp.reviews.updateReply missing)",
  };
}

export async function handlePublishReviewReply(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const db = resolveDb(ctx);
  if (!db) {
    return {
      ok: false,
      error: "db_unavailable",
      message: "Database client is unavailable in handler context.",
    } as HandlerResult;
  }

  const reviewResponseId = asString(args.reviewResponseId);
  if (!reviewResponseId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "reviewResponseId is required.",
    } as HandlerResult;
  }

  const actorType = asString(args.actorType) ?? "agent";
  const actorId = asString(args.actorId);
  const approvedAt = asDate(args.approvedAt) ?? new Date();

  const existing = await db.query(
    `
      SELECT
        id,
        review_name,
        location_name,
        draft_text,
        approved_text,
        status
      FROM gbp_review_responses
      WHERE id = $1
      LIMIT 1
    `,
    [reviewResponseId],
  );

  if (existing.rows.length === 0) {
    return {
      ok: false,
      error: "not_found",
      message: "Review response not found.",
    } as HandlerResult;
  }

  const row = existing.rows[0];
  const status = asString(row.status);
  const approvedTextFromArgs = asString(args.approvedText);
  const approvedTextFromDb = asString(row.approved_text);
  const draftText = asString(row.draft_text);
  const replyText = approvedTextFromArgs ?? approvedTextFromDb ?? draftText;

  if (!replyText) {
    return {
      ok: false,
      error: "missing_reply_text",
      message: "No reply text available to publish.",
    } as HandlerResult;
  }

  if (status === "published") {
    return {
      ok: true,
      status: "already_published",
      reviewResponseId,
      message: "Reply already published.",
    } as HandlerResult;
  }

  if (!(status === "approved" || status === "auto_approved" || status === "ready_to_publish")) {
    return {
      ok: false,
      error: "not_approved",
      message: "Reply is not in an approved state for publishing.",
      currentStatus: status,
    } as HandlerResult;
  }

  const reviewName = asString(row.review_name);
  const locationName = asString(row.location_name);
  if (!reviewName || !locationName) {
    return {
      ok: false,
      error: "missing_provider_identifiers",
      message: "review_name/location_name missing on gbp_review_responses row.",
    } as HandlerResult;
  }

  const providerResult = await callUpdateReply(ctx, {
    reviewName,
    locationName,
    comment: replyText,
  });

  if (!providerResult.ok) {
    await db.query(
      `
        UPDATE gbp_review_responses
        SET
          status = $2,
          last_error = $3,
          updated_at = NOW()
        WHERE id = $1
      `,
      [reviewResponseId, "publish_failed", providerResult.error ?? "unknown_error"],
    );

    await db.query(
      `
        INSERT INTO gbp_audit_events (
          id,
          event_type,
          actor_type,
          actor_id,
          ref_id,
          payload,
          created_at
        ) VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          NOW()
        )
      `,
      [
        "gbp.review_reply.publish_failed",
        actorType,
        actorId,
        reviewResponseId,
        JSON.stringify({
          reason: providerResult.error ?? "unknown_error",
        }),
      ],
    );

    return {
      ok: false,
      error: "provider_publish_failed",
      message: providerResult.error ?? "Failed to publish reply to provider.",
      reviewResponseId,
    } as HandlerResult;
  }

  await db.query(
    `
      UPDATE gbp_review_responses
      SET
        approved_text = $2,
        approved_at = COALESCE(approved_at, $3),
        status = $4,
        published_at = NOW(),
        provider_reply = $5,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      reviewResponseId,
      replyText,
      approvedAt.toISOString(),
      "published",
      providerResult.providerReply ?? replyText,
    ],
  );

  await db.query(
    `
      INSERT INTO gbp_audit_events (
        id,
        event_type,
        actor_type,
        actor_id,
        ref_id,
        payload,
        created_at
      ) VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        NOW()
      )
    `,
    [
      "gbp.review_reply.published",
      actorType,
      actorId,
      reviewResponseId,
      JSON.stringify({
        reviewName,
        locationName,
        publishedText: replyText,
        metadata: args.metadata ?? null,
      }),
    ],
  );

  return {
    ok: true,
    status: "published",
    reviewResponseId,
    reviewName,
    locationName,
    publishedText: replyText,
    publishedAt: new Date().toISOString(),
  } as HandlerResult;
}
