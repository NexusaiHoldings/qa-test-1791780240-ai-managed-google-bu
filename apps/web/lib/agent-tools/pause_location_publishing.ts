import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  location_id?: unknown;
  locationId?: unknown;
  reason?: unknown;
  details?: unknown;
  source_event?: unknown;
  sourceEvent?: unknown;
  status?: unknown;
  previous_status?: unknown;
  previousStatus?: unknown;
};

type JsonObject = Record<string, unknown>;

type PgLikeClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
};

const VALID_REASONS = new Set([
  "suspension",
  "policy_rejection",
  "revoked_token",
  "publish_failures",
]);

const VALID_TARGET_STATUSES = new Set(["paused", "suspended"]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getDbClientFromContext(ctx: HandlerContext): PgLikeClient | null {
  const candidates: unknown[] = [
    (ctx as unknown as { db?: unknown }).db,
    (ctx as unknown as { pg?: unknown }).pg,
    (ctx as unknown as { pool?: unknown }).pool,
    (ctx as unknown as { client?: unknown }).client,
    (ctx as unknown as { services?: { db?: unknown } }).services?.db,
    (ctx as unknown as { runtime?: { db?: unknown } }).runtime?.db,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "query" in (candidate as Record<string, unknown>) &&
      typeof (candidate as { query?: unknown }).query === "function"
    ) {
      return candidate as PgLikeClient;
    }
  }
  return null;
}

function getOrgIdFromContext(ctx: HandlerContext): string | null {
  const direct = asString((ctx as unknown as { orgId?: unknown }).orgId);
  if (direct) return direct;

  const sessionOrg = asString(
    (ctx as unknown as { session?: { orgId?: unknown } }).session?.orgId,
  );
  if (sessionOrg) return sessionOrg;

  const tenantOrg = asString(
    (ctx as unknown as { tenant?: { orgId?: unknown } }).tenant?.orgId,
  );
  return tenantOrg;
}

function toHandlerError(code: string, message: string, meta?: JsonObject): HandlerResult {
  return {
    ok: false,
    code,
    message,
    ...(meta ? { meta } : {}),
  } as unknown as HandlerResult;
}

function toHandlerOk(message: string, data: JsonObject): HandlerResult {
  return {
    ok: true,
    message,
    data,
  } as unknown as HandlerResult;
}

export async function handlePauseLocationPublishing(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const db = getDbClientFromContext(ctx);
  if (!db) {
    return toHandlerError("db_unavailable", "Database client is unavailable in handler context.");
  }

  const orgId = getOrgIdFromContext(ctx);
  if (!orgId) {
    return toHandlerError("missing_org", "Organization context is required.");
  }

  const locationId = asString(args.location_id) ?? asString(args.locationId);
  if (!locationId) {
    return toHandlerError("invalid_args", "location_id is required.");
  }

  const reason = (asString(args.reason) ?? "").toLowerCase();
  if (!VALID_REASONS.has(reason)) {
    return toHandlerError(
      "invalid_args",
      "reason must be one of: suspension, policy_rejection, revoked_token, publish_failures.",
    );
  }

  const requestedStatus = (asString(args.status) ?? "").toLowerCase();
  const targetStatus = VALID_TARGET_STATUSES.has(requestedStatus)
    ? requestedStatus
    : reason === "suspension"
      ? "suspended"
      : "paused";

  const details: JsonObject =
    args.details && typeof args.details === "object" ? (args.details as JsonObject) : {};
  const sourceEvent = asString(args.source_event) ?? asString(args.sourceEvent) ?? reason;
  const previousStatusArg =
    asString(args.previous_status) ?? asString(args.previousStatus) ?? undefined;

  const nowIso = new Date().toISOString();

  try {
    const locationRes = await db.query(
      `SELECT id, org_id, publishing_status
       FROM gbp_locations
       WHERE id = $1 AND org_id = $2
       LIMIT 1`,
      [locationId, orgId],
    );

    const location = locationRes.rows?.[0];
    if (!location) {
      return toHandlerError("not_found", "Location not found for org.", { location_id: locationId });
    }

    const previousStatus = previousStatusArg ?? asString(location.publishing_status) ?? "active";

    await db.query(
      `UPDATE gbp_locations
       SET publishing_status = $1,
           updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [targetStatus, locationId, orgId],
    );

    await db.query(
      `INSERT INTO gbp_health_incidents
         (id, org_id, location_id, incident_type, severity, status, title, summary, metadata, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())`,
      [
        orgId,
        locationId,
        "publishing_paused",
        targetStatus === "suspended" ? "high" : "medium",
        "open",
        "Publishing paused by agent tool",
        `Publishing status changed from ${previousStatus} to ${targetStatus} due to ${reason}.`,
        JSON.stringify({
          reason,
          previous_status: previousStatus,
          new_status: targetStatus,
          source_event: sourceEvent,
          occurred_at: nowIso,
          details,
        }),
      ],
    );

    await db.query(
      `INSERT INTO notifications_outbox
         (id, org_id, channel, template_key, recipient_ref, payload, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())`,
      [
        orgId,
        "in_app",
        "gbp_location_publishing_paused",
        locationId,
        JSON.stringify({
          location_id: locationId,
          reason,
          source_event: sourceEvent,
          previous_status: previousStatus,
          new_status: targetStatus,
          details,
        }),
        "queued",
      ],
    );

    return toHandlerOk("Location publishing paused.", {
      location_id: locationId,
      previous_status: previousStatus,
      new_status: targetStatus,
      reason,
      source_event: sourceEvent,
    });
  } catch (error: unknown) {
    return toHandlerError("pause_failed", "Failed to pause location publishing.", {
      location_id: locationId,
      org_id: orgId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
}
