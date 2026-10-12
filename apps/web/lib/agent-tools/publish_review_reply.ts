/**
 * Company-local agent tool: publish_review_reply (F1-DT002).
 *
 * Confirm-gated MUTATION. Publishes an approved (or auto-approved) owner reply to
 * a Google Business Profile review via the Business Profile v4
 * `reviews.updateReply` endpoint, then records the published reply + Google reply
 * timestamp through the substrate event bus (keystone audit event forwarded to
 * analytics / admin audit by apps/web/lib/events.ts). The companion
 * `gbp_review_responses` row is reconciled from that event stream by the domain's
 * review-poll cron — this handler stays inside its carve-out (no cross-boundary
 * DB write against a table it does not own) and emits the authoritative state
 * transition instead.
 *
 * Autonomy = autonomous: analysis tools (sensitivity / variance classification)
 * run inline via the generic LLM handler; mutations like this one route through
 * the cross-boundary mutation bridge (apps/web/app/api/cron/approved-actions/
 * route.ts), which invokes this handler with (ctx, args) once the runtime has
 * approved the action AND the guards have passed. The guard contract is
 * re-verified here defensively: the handler only publishes when the owner's
 * standing `auto_publish_replies` authorization is present for a low-sensitivity
 * review, OR an explicit owner approval accompanies the action.
 *
 * The handler signature matches the lego-handler shape the bridge dispatches:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Google Business Profile v4 reviews endpoint (review-scoped `reply` sub-resource). */
const GBP_API_BASE = "https://mybusiness.googleapis.com/v4";

/** Hard ceiling on the outbound Google call so the cron worker never hangs. */
const PUBLISH_TIMEOUT_MS = 15_000;

/** Google Business Profile review reply hard limit (comment length). */
const REPLY_MAX_LENGTH = 4096;

/** Sensitivity levels the auto-publish authorization is allowed to cover. */
const AUTO_PUBLISH_SAFE_SENSITIVITIES = new Set<string>(["low", "none", "neutral"]);

interface ParsedArgs {
  /** Full GBP review resource name: accounts/{a}/locations/{l}/reviews/{r}. */
  readonly reviewName: string;
  /** The reply body to publish (the review `comment`). */
  readonly replyText: string;
  /** Short-lived GBP access token minted by apps/web/lib/gbp/oauth.ts. */
  readonly accessToken: string;
  /** Classified sensitivity of the review ("low" for the auto-publish path). */
  readonly sensitivity: string | null;
  /** True when a human owner explicitly approved this reply. */
  readonly ownerApproved: boolean;
  /** True when the owner granted standing auto_publish_replies authorization. */
  readonly autoPublishAuthorized: boolean;
  /** gbp_review_responses row id this publish reconciles (for the audit event). */
  readonly responseId: string | null;
  /** gbp_connections row id backing the access token. */
  readonly connectionId: string | null;
  /** Owner / actor who authored or approved the reply. */
  readonly actorId: string | null;
  /** Validate-only mode: build the request but never call Google. */
  readonly dryRun: boolean;
}

/** A thrown validation failure that maps to an HTTP 4xx/5xx HandlerResult. */
class ValidationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Coerce to a trimmed non-empty string, else undefined. */
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerce common truthy encodings (true / "true" / 1 / "1" / "yes") to boolean. */
function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

/** First defined string among the provided candidate keys. */
function firstString(args: Args, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = asString(args[key]);
    if (found) return found;
  }
  return undefined;
}

/** First truthy boolean among the provided candidate keys. */
function anyBool(args: Args, keys: readonly string[]): boolean {
  return keys.some((key) => asBool(args[key]));
}

function ok(body: Record<string, unknown>, status = 200): HandlerResult {
  return { status, body };
}

function fail(
  httpStatus: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HandlerResult {
  return {
    status: httpStatus,
    body: { error: { code, message, details: details ?? {} } },
  };
}

/**
 * Validate and normalize the flat args the bridge hands us, and enforce the
 * authorization guard. A confirm-gated reply publish may only proceed when:
 *   - an owner explicitly approved this reply, OR
 *   - the owner granted standing `auto_publish_replies` authorization AND the
 *     review's classified sensitivity is low (the auto-publish path only covers
 *     low-sensitivity reviews — anything else requires human approval).
 */
function parseArgs(args: Args): ParsedArgs {
  // Accept either a full review resource name or the component parts.
  let reviewName = firstString(args, ["reviewName", "review_name", "name"]);
  if (!reviewName) {
    const accountName = firstString(args, ["accountName", "account_name"]);
    const locationName = firstString(args, ["locationName", "location_name"]);
    const reviewId = firstString(args, ["reviewId", "review_id"]);
    if (accountName && locationName && reviewId) {
      // accountName may be "accounts/{a}" or "{a}"; locationName likewise.
      const acct = accountName.replace(/^accounts\//, "");
      const loc = locationName.replace(/^.*locations\//, "").replace(/^locations\//, "");
      const rev = reviewId.replace(/^.*reviews\//, "");
      reviewName = `accounts/${acct}/locations/${loc}/reviews/${rev}`;
    }
  }
  if (!reviewName) {
    throw new ValidationError(
      "invalid_arguments",
      "publish_review_reply requires `reviewName` (or accountName + locationName + reviewId).",
    );
  }
  if (!/^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/.test(reviewName)) {
    throw new ValidationError(
      "invalid_review_name",
      "`reviewName` must be of the form accounts/{account}/locations/{location}/reviews/{review}.",
    );
  }

  const replyText = firstString(args, ["replyText", "reply_text", "comment", "reply", "text"]);
  if (!replyText) {
    throw new ValidationError(
      "invalid_arguments",
      "publish_review_reply requires a non-empty `replyText`.",
    );
  }
  if (replyText.length > REPLY_MAX_LENGTH) {
    throw new ValidationError(
      "reply_too_long",
      `\`replyText\` exceeds the Google Business Profile ${REPLY_MAX_LENGTH}-character reply limit.`,
    );
  }

  const sensitivity = (firstString(args, ["sensitivity", "sensitivity_level"]) ?? "").toLowerCase() || null;
  const ownerApproved = anyBool(args, [
    "ownerApproved",
    "owner_approved",
    "approved",
    "approvalGranted",
    "approval_granted",
  ]);
  const autoPublishAuthorized = anyBool(args, [
    "autoPublishAuthorized",
    "auto_publish_authorized",
    "auto_publish_replies",
    "autoPublishReplies",
  ]);

  if (!ownerApproved) {
    if (!autoPublishAuthorized) {
      throw new ValidationError(
        "not_authorized",
        "publish blocked: owner approval or auto_publish_replies authorization is required.",
        403,
      );
    }
    // Auto-publish path: only low-sensitivity reviews may skip human approval.
    if (!sensitivity || !AUTO_PUBLISH_SAFE_SENSITIVITIES.has(sensitivity)) {
      throw new ValidationError(
        "approval_required",
        "auto_publish_replies only covers low-sensitivity reviews; this review requires owner approval.",
        403,
      );
    }
  }

  const dryRun = asBool(args.dryRun) || asBool(args.dry_run);

  const accessToken = firstString(args, ["accessToken", "access_token", "gbpAccessToken"]) ?? "";
  if (!dryRun && !accessToken) {
    throw new ValidationError(
      "missing_access_token",
      "publish_review_reply requires a GBP `accessToken` to call the Business Profile API.",
      424,
    );
  }

  return {
    reviewName,
    replyText,
    accessToken,
    sensitivity,
    ownerApproved,
    autoPublishAuthorized,
    responseId: firstString(args, ["responseId", "response_id", "reviewResponseId"]) ?? null,
    connectionId: firstString(args, ["connectionId", "connection_id"]) ?? null,
    actorId: firstString(args, ["actorId", "actor_id", "userId", "user_id", "ownerId"]) ?? null,
    dryRun,
  };
}

/** Assemble the request body for the GBP v4 reviews.updateReply call. */
function buildReplyBody(parsed: ParsedArgs): Record<string, unknown> {
  return { comment: parsed.replyText };
}

interface GbpReplyOutcome {
  /** Reply comment echoed back by Google. */
  readonly comment: string;
  /** RFC-3339 timestamp Google recorded for the reply. */
  readonly updateTime: string | null;
}

/**
 * PUT the reply to Google. Returns the stored reply comment + updateTime, or
 * throws a ValidationError carrying the upstream status so the bridge records a
 * `failed` outcome with a useful message.
 */
async function publishReplyToGbp(parsed: ParsedArgs): Promise<GbpReplyOutcome> {
  const url = `${GBP_API_BASE}/${parsed.reviewName}/reply`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${parsed.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildReplyBody(parsed)),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new ValidationError(
      "gbp_request_failed",
      `Google Business Profile request failed: ${reason}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text().catch(() => "");
  let payload: Record<string, unknown> = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const apiError = (payload.error ?? {}) as Record<string, unknown>;
    const detail = asString(apiError.message) ?? rawText.slice(0, 300) ?? response.statusText;
    // Surface auth/quota issues with their real status so the bridge can retry
    // or alert; everything else maps to 502 (upstream failure).
    const mappedStatus =
      response.status === 401 || response.status === 403 || response.status === 429
        ? response.status
        : 502;
    throw new ValidationError(
      "gbp_reply_rejected",
      `Google rejected the review reply (${response.status}): ${detail}`,
      mappedStatus,
    );
  }

  return {
    comment: asString(payload.comment) ?? parsed.replyText,
    updateTime: asString(payload.updateTime) ?? null,
  };
}

/**
 * Entry point registered in DOMAIN_DISPATCH as `publish_review_reply`.
 */
export async function handlePublishReviewReply(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return fail(error.httpStatus, error.code, error.message);
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return fail(400, "invalid_arguments", message);
  }

  const approvalBasis = parsed.ownerApproved ? "owner_approved" : "auto_publish_replies";

  // Dry-run: validate + echo the exact request we would send, without calling
  // Google. Used by the planner to confirm guards before the real mutation.
  if (parsed.dryRun) {
    return ok({
      status: "validated",
      tool: "publish_review_reply",
      autonomy: "autonomous",
      reviewName: parsed.reviewName,
      request: buildReplyBody(parsed),
      approvalBasis,
      sensitivity: parsed.sensitivity,
      responseId: parsed.responseId,
    });
  }

  let outcome: GbpReplyOutcome;
  try {
    outcome = await publishReplyToGbp(parsed);
  } catch (error: unknown) {
    const code = error instanceof ValidationError ? error.code : "gbp_reply_failed";
    const httpStatus = error instanceof ValidationError ? error.httpStatus : 502;
    const message = error instanceof Error ? error.message : "Unknown publish error";

    // Record the failed attempt as an audit event (fire-and-forget) so the
    // weekly digest + admin audit reflect why the reply did not go live, and the
    // review-poll cron can retry / surface it to the owner.
    await ctx.events.publish("gbp.review.reply_failed", {
      reviewName: parsed.reviewName,
      responseId: parsed.responseId,
      connectionId: parsed.connectionId,
      actorId: parsed.actorId,
      approvalBasis,
      sensitivity: parsed.sensitivity,
      code,
      message,
    });

    return fail(httpStatus, code, message, {
      reviewName: parsed.reviewName,
      responseId: parsed.responseId,
    });
  }

  // Record the published reply + Google updateTime. events.ts logs every event
  // and forwards keystone events to the portfolio runtime (analytics + admin
  // audit trail); the review-poll cron reconciles the matching
  // gbp_review_responses row to `published` from this event, satisfying the
  // "update gbp_review_responses + emit audit event" contract without a
  // cross-boundary DB write against a table outside this carve-out.
  await ctx.events.publish("gbp.review.reply_published", {
    reviewName: parsed.reviewName,
    responseId: parsed.responseId,
    connectionId: parsed.connectionId,
    actorId: parsed.actorId,
    approvalBasis,
    sensitivity: parsed.sensitivity,
    comment: outcome.comment,
    updateTime: outcome.updateTime,
  });

  return ok({
    status: "published",
    tool: "publish_review_reply",
    autonomy: "autonomous",
    reviewName: parsed.reviewName,
    responseId: parsed.responseId,
    approvalBasis,
    comment: outcome.comment,
    updateTime: outcome.updateTime,
  });
}
