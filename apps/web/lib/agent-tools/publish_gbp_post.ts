/**
 * Company-local agent tool: publish_gbp_post (F1-DT001).
 *
 * Confirm-gated MUTATION. Publishes a guarded local post (with its owner-
 * supplied photo) to a connected Google Business Profile location via the
 * Business Profile v4 `localPosts.create` endpoint, then records the published
 * status + Google resource name through the substrate event bus (keystone audit
 * event forwarded to analytics/admin audit by apps/web/lib/events.ts).
 *
 * Autonomy = autonomous: analysis tools run inline via the generic LLM handler;
 * mutations like this one route through the cross-boundary mutation bridge
 * (apps/web/app/api/cron/approved-actions/route.ts), which invokes this handler
 * with (ctx, args) once the runtime has approved the action AND the guards have
 * passed. The guard contract is re-verified here defensively: the handler only
 * publishes when the owner's `auto_publish_posts` authorization — or an explicit
 * warm-up approval — is present in the approved action's args.
 *
 * The handler signature matches the lego-handler shape the bridge dispatches:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Google Business Profile v4 call-to-action action types. */
const CTA_ACTION_TYPES = new Set<string>([
  "BOOK",
  "ORDER",
  "SHOP",
  "LEARN_MORE",
  "SIGN_UP",
  "CALL",
]);

/** Google Business Profile v4 localPosts endpoint (location-scoped parent). */
const GBP_API_BASE = "https://mybusiness.googleapis.com/v4";

/** Hard ceiling on the outbound Google call so the cron worker never hangs. */
const PUBLISH_TIMEOUT_MS = 15_000;

interface ParsedArgs {
  readonly locationName: string;
  readonly summary: string;
  readonly photoUrl: string;
  readonly languageCode: string;
  readonly callToActionType: string | null;
  readonly callToActionUrl: string | null;
  readonly accessToken: string;
  readonly connectionId: string | null;
  readonly sourceDraftId: string | null;
  readonly actorId: string | null;
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

/** Coerce common truthy encodings (true / "true" / 1 / "1") to boolean. */
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
 * Validate and normalize the flat args the bridge hands us. Also enforces the
 * authorization guard: a confirm-gated publish may only proceed when the owner
 * has standing `auto_publish_posts` authorization OR an explicit warm-up
 * approval for this run.
 */
function parseArgs(args: Args): ParsedArgs {
  const locationName = firstString(args, ["locationName", "location_name", "location"]);
  if (!locationName) {
    throw new ValidationError("invalid_arguments", "publish_gbp_post requires `locationName`.");
  }
  // GBP v4 localPosts is parented on accounts/{id}/locations/{id}.
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(locationName)) {
    throw new ValidationError(
      "invalid_location_name",
      "`locationName` must be of the form accounts/{account}/locations/{location}.",
    );
  }

  const summary = firstString(args, ["summary", "text", "body"]);
  if (!summary) {
    throw new ValidationError("invalid_arguments", "publish_gbp_post requires a non-empty `summary`.");
  }
  // GBP localPost summary hard limit is 1500 chars.
  if (summary.length > 1500) {
    throw new ValidationError(
      "summary_too_long",
      "`summary` exceeds the Google Business Profile 1500-character limit.",
    );
  }

  const photoUrl = firstString(args, ["photoUrl", "photo_url", "mediaUrl", "media_url", "sourceUrl"]);
  if (!photoUrl) {
    throw new ValidationError(
      "missing_photo",
      "publish_gbp_post requires a photo URL — weekly posts publish the owner's uploaded photo.",
    );
  }

  const authorized = anyBool(args, [
    "autoPublishAuthorized",
    "auto_publish_authorized",
    "auto_publish_posts",
    "warmupApproved",
    "warmup_approved",
  ]);
  if (!authorized) {
    throw new ValidationError(
      "not_authorized",
      "publish blocked: owner auto_publish_posts authorization or warm-up approval is required.",
      403,
    );
  }

  const callToActionType = firstString(args, ["callToActionType", "call_to_action_type", "ctaType"]);
  if (callToActionType && !CTA_ACTION_TYPES.has(callToActionType)) {
    throw new ValidationError(
      "invalid_cta_type",
      `Unsupported call-to-action type: ${callToActionType}.`,
    );
  }
  const callToActionUrl = firstString(args, ["callToActionUrl", "call_to_action_url", "ctaUrl"]);
  // Every CTA except CALL requires a URL; CALL uses the location phone number.
  if (callToActionType && callToActionType !== "CALL" && !callToActionUrl) {
    throw new ValidationError(
      "missing_cta_url",
      `Call-to-action ${callToActionType} requires \`callToActionUrl\`.`,
    );
  }

  const dryRun = asBool(args.dryRun) || asBool(args.dry_run);

  // The live publish needs a short-lived GBP access token minted by the domain
  // OAuth layer (apps/web/lib/gbp/oauth.ts) and carried on the approved action.
  const accessToken = firstString(args, ["accessToken", "access_token", "gbpAccessToken"]) ?? "";
  if (!dryRun && !accessToken) {
    throw new ValidationError(
      "missing_access_token",
      "publish_gbp_post requires a GBP `accessToken` to call the Business Profile API.",
      424,
    );
  }

  return {
    locationName,
    summary,
    photoUrl,
    languageCode: firstString(args, ["languageCode", "language_code"]) ?? "en-US",
    callToActionType: callToActionType ?? null,
    callToActionUrl: callToActionUrl ?? null,
    accessToken,
    connectionId: firstString(args, ["connectionId", "connection_id"]) ?? null,
    sourceDraftId: firstString(args, ["sourceDraftId", "source_draft_id", "draftId"]) ?? null,
    actorId: firstString(args, ["actorId", "actor_id", "userId", "user_id", "ownerId"]) ?? null,
    dryRun,
  };
}

/** Assemble the LocalPost request body for the GBP v4 localPosts.create call. */
function buildLocalPostBody(parsed: ParsedArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    languageCode: parsed.languageCode,
    summary: parsed.summary,
    topicType: "STANDARD",
    media: [{ mediaFormat: "PHOTO", sourceUrl: parsed.photoUrl }],
  };
  if (parsed.callToActionType) {
    const cta: Record<string, unknown> = { actionType: parsed.callToActionType };
    if (parsed.callToActionUrl) cta.url = parsed.callToActionUrl;
    body.callToAction = cta;
  }
  return body;
}

interface GbpPublishOutcome {
  readonly resourceName: string;
  readonly state: string;
  readonly searchUrl: string | null;
}

/**
 * POST the local post to Google. Returns the created resource name + state, or
 * throws a ValidationError carrying the upstream status so the bridge records a
 * `failed` outcome with a useful message.
 */
async function publishToGbp(parsed: ParsedArgs): Promise<GbpPublishOutcome> {
  const url = `${GBP_API_BASE}/${parsed.locationName}/localPosts`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parsed.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildLocalPostBody(parsed)),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new ValidationError("gbp_request_failed", `Google Business Profile request failed: ${reason}`, 502);
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
    const mappedStatus = response.status === 401 || response.status === 403 ? response.status : 502;
    throw new ValidationError(
      "gbp_publish_rejected",
      `Google rejected the local post (${response.status}): ${detail}`,
      mappedStatus,
    );
  }

  const resourceName = asString(payload.name);
  if (!resourceName) {
    throw new ValidationError(
      "gbp_missing_resource_name",
      "Google accepted the post but returned no resource name.",
      502,
    );
  }

  return {
    resourceName,
    state: asString(payload.state) ?? "LIVE",
    searchUrl: asString(payload.searchUrl) ?? null,
  };
}

/**
 * Entry point registered in DOMAIN_DISPATCH as `publish_gbp_post`.
 */
export async function handlePublishGbpPost(
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

  // Dry-run: validate + echo the exact request we would send, without calling
  // Google. Used by the planner to confirm guards before the real mutation.
  if (parsed.dryRun) {
    return ok({
      status: "validated",
      tool: "publish_gbp_post",
      autonomy: "autonomous",
      locationName: parsed.locationName,
      request: buildLocalPostBody(parsed),
      sourceDraftId: parsed.sourceDraftId,
    });
  }

  let outcome: GbpPublishOutcome;
  try {
    outcome = await publishToGbp(parsed);
  } catch (error: unknown) {
    const code = error instanceof ValidationError ? error.code : "gbp_publish_failed";
    const httpStatus = error instanceof ValidationError ? error.httpStatus : 502;
    const message = error instanceof Error ? error.message : "Unknown publish error";

    // Record the failed attempt as an audit event (fire-and-forget) so the
    // weekly digest + admin audit reflect why the post did not go live.
    await ctx.events.publish("gbp.post.publish_failed", {
      locationName: parsed.locationName,
      sourceDraftId: parsed.sourceDraftId,
      connectionId: parsed.connectionId,
      actorId: parsed.actorId,
      code,
      message,
    });

    return fail(httpStatus, code, message, {
      locationName: parsed.locationName,
      sourceDraftId: parsed.sourceDraftId,
    });
  }

  // Record the published status + Google resource name. events.ts logs every
  // event and forwards keystone events to the portfolio runtime (analytics +
  // admin audit trail), satisfying the "record gbp_posts status + emit audit
  // event" contract without a cross-boundary DB write.
  await ctx.events.publish("gbp.post.published", {
    locationName: parsed.locationName,
    resourceName: outcome.resourceName,
    state: outcome.state,
    searchUrl: outcome.searchUrl,
    sourceDraftId: parsed.sourceDraftId,
    connectionId: parsed.connectionId,
    actorId: parsed.actorId,
    callToActionType: parsed.callToActionType,
  });

  return ok({
    status: "published",
    tool: "publish_gbp_post",
    autonomy: "autonomous",
    locationName: parsed.locationName,
    resourceName: outcome.resourceName,
    state: outcome.state,
    searchUrl: outcome.searchUrl,
    sourceDraftId: parsed.sourceDraftId,
  });
}
