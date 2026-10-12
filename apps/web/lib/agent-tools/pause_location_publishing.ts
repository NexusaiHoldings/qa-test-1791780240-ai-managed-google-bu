import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  locationId?: unknown;
  incidentType?: unknown;
  reason?: unknown;
  source?: unknown;
  occurredAt?: unknown;
  status?: unknown;
  requiresConfirmation?: unknown;
  confirmed?: unknown;
};

type DbClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type NotificationPayload = {
  orgId: string;
  locationId: string;
  publishingStatus: "paused" | "suspended";
  incidentType: string;
  reason: string;
  source: string;
  occurredAt: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized: string = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function getDbFromContext(ctx: HandlerContext): DbClient {
  const candidate: unknown = (ctx as { db?: unknown }).db;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as DbClient).query === "function"
  ) {
    return candidate as DbClient;
  }
  throw new Error("pause_location_publishing requires ctx.db.query");
}

async function notifyOwner(
  ctx: HandlerContext,
  payload: NotificationPayload,
): Promise<{ delivered: boolean; channel: string }> {
  const notifier: unknown = (ctx as { notifyOwner?: unknown }).notifyOwner;
  if (typeof notifier === "function") {
    await (notifier as (name: string, data: NotificationPayload) => Promise<void>)(
      "gbp_location_publishing_paused",
      payload,
    );
    return { delivered: true, channel: "ctx.notifyOwner" };
  }

  const logger: unknown = (ctx as { logger?: unknown }).logger;
  if (typeof logger === "object" && logger && typeof (logger as { info?: unknown }).info === "function") {
    (logger as { info: (entry: Record<string, unknown>) => void }).info({
      event: "owner_notification_skipped",
      tool: "pause_location_publishing",
      reason: "notifyOwner_missing_on_context",
      payload,
    });
  }

  return { delivered: false, channel: "none" };
}

export async function handlePauseLocationPublishing(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const locationId: string | null = asNonEmptyString(args.locationId);
  const incidentType: string = asNonEmptyString(args.incidentType) ?? "unknown";
  const reason: string = asNonEmptyString(args.reason) ?? "No reason supplied";
  const source: string = asNonEmptyString(args.source) ?? "agent";
  const occurredAtIso: string = asNonEmptyString(args.occurredAt) ?? new Date().toISOString();
  const requestedStatusRaw: string = (asNonEmptyString(args.status) ?? "paused").toLowerCase();
  const publishingStatus: "paused" | "suspended" =
    requestedStatusRaw === "suspended" ? "suspended" : "paused";
  const requiresConfirmation: boolean = parseBoolean(args.requiresConfirmation, true);
  const confirmed: boolean = parseBoolean(args.confirmed, false);

  if (!locationId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "locationId is required",
    } satisfies HandlerResult;
  }

  if (requiresConfirmation && !confirmed) {
    return {
      ok: false,
      error: "confirmation_required",
      message: "pause_location_publishing is confirm-gated. Re-run with confirmed=true.",
      data: {
        locationId,
        requestedStatus: publishingStatus,
        incidentType,
        autonomy: "autonomous",
        mutationRoutedVia: "cross_boundary_bridge",
      },
    } satisfies HandlerResult;
  }

  const db: DbClient = getDbFromContext(ctx);

  const locationLookup = await db.query(
    `
      SELECT id, org_id
      FROM gbp_locations
      WHERE id = $1
      LIMIT 1
    `,
    [locationId],
  );

  if (locationLookup.rows.length === 0) {
    return {
      ok: false,
      error: "not_found",
      message: `GBP location not found: ${locationId}`,
    } satisfies HandlerResult;
  }

  const row: Record<string, unknown> = locationLookup.rows[0];
  const orgId: string | null = asNonEmptyString(row.org_id);
  if (!orgId) {
    return {
      ok: false,
      error: "data_integrity_error",
      message: "Location exists but org_id is missing",
    } satisfies HandlerResult;
  }

  await db.query(
    `
      UPDATE gbp_locations
      SET publishing_status = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [locationId, publishingStatus],
  );

  await db.query(
    `
      INSERT INTO gbp_health_incidents (
        id,
        org_id,
        location_id,
        incident_type,
        severity,
        status,
        source,
        reason,
        occurred_at,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        CASE WHEN $4 = 'suspended' THEN 'high' ELSE 'medium' END,
        'open',
        $5,
        $6,
        $7::timestamptz,
        NOW(),
        NOW()
      )
    `,
    [orgId, locationId, incidentType, publishingStatus, source, reason, occurredAtIso],
  );

  const notification = await notifyOwner(ctx, {
    orgId,
    locationId,
    publishingStatus,
    incidentType,
    reason,
    source,
    occurredAt: occurredAtIso,
  });

  return {
    ok: true,
    data: {
      locationId,
      orgId,
      publishingStatus,
      incidentType,
      source,
      occurredAt: occurredAtIso,
      ownerNotification: notification,
      autonomy: "autonomous",
      mutationRoutedVia: "cross_boundary_bridge",
    },
  } satisfies HandlerResult;
}
