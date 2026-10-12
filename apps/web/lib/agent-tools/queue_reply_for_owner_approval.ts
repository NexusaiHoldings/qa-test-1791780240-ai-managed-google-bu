/**
 * Company-local agent tool: queue_reply_for_owner_approval (F1-DT003).
 *
 * Confirm-gated MUTATION. Places a sensitive review's safe draft into the owner
 * approval queue (the authoritative `gbp_review_responses.status = pending_owner`
 * transition) together with the flag reasons that forced human review, and
 * schedules the owner notification so the 24-hour reply SLA is not missed. The
 * planner calls this tool whenever a review's classified sensitivity is
 * `elevated` or `high`, or when a generated draft fails moderation or the claims
 * guard — i.e. any time the reply may NOT be auto-published.
 *
 * Carve-out discipline (matches the sibling `publish_review_reply` handler):
 * `gbp_review_responses` is reconciled by the domain's review-poll cron, so this
 * handler does NOT issue a cross-boundary DB write against a table outside its
 * carve-out. Instead it emits the authoritative state-transition event
 * (`gbp.review.queued_for_owner_approval`) plus a notification-scheduled event
 * (`gbp.review.owner_notification_scheduled`). `apps/web/lib/events.ts` logs
 * every event and forwards keystone events to the portfolio runtime (notifications
 * lego + admin audit + weekly digest), which performs the row update and sends the
 * owner email — satisfying the "queue + notify" contract without the handler
 * reaching across the table boundary.
 *
 * Autonomy = human_review: analysis tools (sensitivity / claims classification)
 * run inline via the generic LLM handler; mutations like this one route through
 * the cross-boundary mutation bridge (apps/web/app/api/cron/approved-actions/
 * route.ts), which invokes this handler with (ctx, args).
 *
 * The handler signature matches the lego-handler shape the bridge dispatches:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Google Business Profile review reply hard limit (comment length). */
const REPLY_MAX_LENGTH = 4096;

/** Queue state written for every row that still needs a human decision. */
const PENDING_OWNER_STATUS = "pending_owner";

/**
 * Sensitivities that FORCE the owner-approval queue. A draft may only be
 * auto-published for low/none sensitivity with a clean moderation + claims pass;
 * anything in this set (or any failed guard) must be queued for the owner.
 */
const SENSITIVE_LEVELS = new Set<string>(["elevated", "high", "critical"]);

interface ParsedArgs {
  /** gbp_review_responses row id this queue action transitions (when known). */
  readonly responseId: string | null;
  /** GBP review resource name or opaque review id the draft replies to. */
  readonly reviewId: string;
  /** GBP location (gbp_locations_cache) the review belongs to. */
  readonly locationId: string | null;
  /** Owning org (one-org-per-business tenancy boundary). */
  readonly orgId: string | null;
  /** The safe draft reply awaiting owner approval. */
  readonly draftReply: string;
  /** Why the draft could not be auto-published (moderation / claims / sensitivity). */
  readonly flagReasons: string[];
  /** Classified sensitivity of the review, lower-cased ("high", "elevated", ...). */
  readonly sensitivity: string | null;
  /** RFC-3339 instant at which the owner should be notified. */
  readonly notifyOwnerAt: string;
  /** gbp_connections row id backing the review's location (for the audit event). */
  readonly connectionId: string | null;
  /** Owner / actor the approval request is addressed to. */
  readonly actorId: string | null;
  /** Validate-only mode: build the payload but emit nothing. */
  readonly dryRun: boolean;
}

/** A thrown validation failure that maps to an HTTP 4xx HandlerResult. */
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

/** Normalize a flag-reason input (array, comma string, or single string) to string[]. */
function asStringArray(value: unknown): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    const s = asString(raw);
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (typeof value === "string") {
    for (const part of value.split(/[,;\n]/)) push(part);
  }
  return out;
}

/**
 * Resolve the notification instant. Accepts an explicit RFC-3339 string; falls
 * back to "now" when absent or unparseable so a sensitive review is never left
 * un-notified (the owner SLA is 24h — a missing timestamp must not silently
 * delay the alert).
 */
function resolveNotifyAt(value: unknown): string {
  const raw = asString(value);
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
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
 * Validate and normalize the flat args the bridge hands us. A queue action is
 * only meaningful with a target review and a non-empty safe draft; a sensitive
 * review with no draft would leave the owner with nothing to approve.
 */
function parseArgs(args: Args): ParsedArgs {
  const reviewId = firstString(args, [
    "reviewId",
    "review_id",
    "reviewName",
    "review_name",
    "name",
  ]);
  if (!reviewId) {
    throw new ValidationError(
      "invalid_arguments",
      "queue_reply_for_owner_approval requires a `reviewId` (or reviewName) identifying the review.",
    );
  }

  const draftReply = firstString(args, [
    "draftReply",
    "draft_reply",
    "replyText",
    "reply_text",
    "reply",
    "comment",
    "text",
  ]);
  if (!draftReply) {
    throw new ValidationError(
      "invalid_arguments",
      "queue_reply_for_owner_approval requires a non-empty `draftReply` for the owner to approve.",
    );
  }
  if (draftReply.length > REPLY_MAX_LENGTH) {
    throw new ValidationError(
      "reply_too_long",
      `\`draftReply\` exceeds the Google Business Profile ${REPLY_MAX_LENGTH}-character reply limit.`,
    );
  }

  const sensitivity = (firstString(args, ["sensitivity", "sensitivity_level"]) ?? "").toLowerCase() || null;

  // Flag reasons: explicit list, plus an inferred reason when sensitivity alone
  // triggered the queue so the owner always sees WHY approval was required.
  const flagReasons = asStringArray(args.flagReasons ?? args.flag_reasons ?? args.reasons);
  if (sensitivity && SENSITIVE_LEVELS.has(sensitivity)) {
    const inferred = `sensitivity_${sensitivity}`;
    if (!flagReasons.includes(inferred)) flagReasons.push(inferred);
  }
  if (flagReasons.length === 0) {
    // The tool is confirm-gated: it should only be reached when something forced
    // human review. Record a generic reason rather than an empty list so the
    // audit trail and owner email are never blank.
    flagReasons.push("owner_approval_required");
  }

  return {
    responseId: firstString(args, ["responseId", "response_id", "reviewResponseId"]) ?? null,
    reviewId,
    locationId: firstString(args, ["locationId", "location_id", "locationName", "location_name"]) ?? null,
    orgId: firstString(args, ["orgId", "org_id", "organizationId", "organization_id"]) ?? null,
    draftReply,
    flagReasons,
    sensitivity,
    notifyOwnerAt: resolveNotifyAt(args.notifyOwnerAt ?? args.notify_owner_at ?? args.notifyAt),
    connectionId: firstString(args, ["connectionId", "connection_id"]) ?? null,
    actorId: firstString(args, ["actorId", "actor_id", "ownerId", "owner_id", "userId", "user_id"]) ?? null,
    dryRun: asBool(args.dryRun) || asBool(args.dry_run),
  };
}

/** Shared event payload describing the queued review (JSON-serializable). */
function queuePayload(parsed: ParsedArgs): Record<string, unknown> {
  return {
    responseId: parsed.responseId,
    reviewId: parsed.reviewId,
    locationId: parsed.locationId,
    orgId: parsed.orgId,
    connectionId: parsed.connectionId,
    actorId: parsed.actorId,
    status: PENDING_OWNER_STATUS,
    draftReply: parsed.draftReply,
    flagReasons: parsed.flagReasons,
    sensitivity: parsed.sensitivity,
    notifyOwnerAt: parsed.notifyOwnerAt,
  };
}

/**
 * Entry point registered in DOMAIN_DISPATCH as `queue_reply_for_owner_approval`.
 */
export async function handleQueueReplyForOwnerApproval(
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

  const payload = queuePayload(parsed);

  // Dry-run: echo the exact state transition we would emit, without touching the
  // event bus. Used by the planner to confirm the queue action before committing.
  if (parsed.dryRun) {
    return ok({
      status: "validated",
      tool: "queue_reply_for_owner_approval",
      autonomy: "human_review",
      ...payload,
    });
  }

  // 1) Authoritative state transition → gbp_review_responses.status = pending_owner.
  //    The review-poll cron reconciles the row (and the admin audit trail) from
  //    this event; the handler stays inside its carve-out.
  await ctx.events.publish("gbp.review.queued_for_owner_approval", payload);

  // 2) Schedule the owner notification (notifications lego / weekly digest). Kept
  //    as a separate event so the delivery pipeline can honor notifyOwnerAt and
  //    de-duplicate per review without re-reading the queue table.
  await ctx.events.publish("gbp.review.owner_notification_scheduled", {
    responseId: parsed.responseId,
    reviewId: parsed.reviewId,
    locationId: parsed.locationId,
    orgId: parsed.orgId,
    actorId: parsed.actorId,
    notifyOwnerAt: parsed.notifyOwnerAt,
    flagReasons: parsed.flagReasons,
    sensitivity: parsed.sensitivity,
  });

  return ok({
    status: "queued",
    tool: "queue_reply_for_owner_approval",
    autonomy: "human_review",
    reviewId: parsed.reviewId,
    responseId: parsed.responseId,
    queueStatus: PENDING_OWNER_STATUS,
    flagReasons: parsed.flagReasons,
    notifyOwnerAt: parsed.notifyOwnerAt,
  });
}
