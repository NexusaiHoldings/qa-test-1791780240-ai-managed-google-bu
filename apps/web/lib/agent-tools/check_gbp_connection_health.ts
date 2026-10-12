/**
 * Company-local agent tool: check_gbp_connection_health (F1-DT005).
 *
 * Confirm-gated MUTATION. Probes a connected Google Business Profile location's
 * health and returns a verdict:
 *   1. token validity   — is there a usable access token, and a refresh token to
 *                         mint a new one? If the access token is at/near expiry
 *                         AND a refresh token exists, refresh it in place (the
 *                         mutation) via apps/web/lib/gbp/oauth.ts.
 *   2. verification      — is the location VERIFIED, or SUSPENDED / UNVERIFIED /
 *                         PENDING (degraded)?
 *   3. recent API errors — auth failures (401/403) in the last 24h make the
 *                         connection unhealthy; transient/quota errors (429/5xx)
 *                         make it degraded. Pulled from gbp_api_calls.
 *
 * Autonomy = autonomous: analysis tools run inline via the generic LLM handler;
 * this mutation routes through the cross-boundary mutation bridge
 * (apps/web/app/api/cron/approved-actions/route.ts), which invokes this handler
 * with (ctx, args). It is also called by the 15-minute gbp-health-check cron and
 * defensively before every publish, so it must run without an interactive
 * confirmation flag — the bridge/cron is the authorization boundary.
 *
 * Handler signature matches the lego-handler shape the bridge dispatches:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { refreshConnectionToken } from "@/lib/gbp/oauth";

type Args = Record<string, unknown>;

type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** Verification states Google reports that mean the listing can publish. */
const VERIFIED_STATES = new Set<string>([
  "VERIFIED",
  "VERIFICATION_STATE_VERIFIED",
  "LOCATION_VERIFIED",
]);

/** Refresh the access token once it is within this window of expiry. */
const EXPIRY_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Auth-class HTTP statuses in gbp_api_calls that make the connection unhealthy. */
const UNHEALTHY_STATUSES = new Set<number>([401, 403]);

/** Transient / quota HTTP statuses that make the connection degraded. */
const DEGRADED_STATUSES = new Set<number>([408, 425, 429, 500, 502, 503, 504]);

interface ConnectionRow {
  readonly id: string;
  readonly org_id: string;
  readonly access_token: string | null;
  readonly refresh_token_ciphertext: string | null;
  readonly token_expires_at: Date | string | null;
  readonly selected_location_name: string | null;
  readonly selected_location_title: string | null;
  readonly verification_state: string | null;
  readonly connection_state: string | null;
  readonly paused_reason: string | null;
  readonly last_refreshed_at: Date | string | null;
}

interface ApiCallRow {
  readonly response_status: number | null;
  readonly error_message: string | null;
  readonly created_at: Date | string | null;
}

interface ConnectionHealthData {
  readonly connectionId: string;
  readonly orgId: string;
  readonly locationName: string | null;
  readonly locationTitle: string | null;
  readonly checkedAt: string;
  readonly token: {
    readonly hasAccessToken: boolean;
    readonly hasRefreshToken: boolean;
    readonly expiresAt: string | null;
    readonly expiresSoon: boolean;
    readonly refreshAttempted: boolean;
    readonly refreshSucceeded: boolean;
    readonly refreshError: string | null;
  };
  readonly verification: {
    readonly state: string;
    readonly isVerified: boolean;
  };
  readonly connectionState: string;
  readonly recentApiErrors: {
    readonly total: number;
    readonly statuses: number[];
    readonly lastErrorAt: string | null;
  };
  readonly verdict: {
    readonly status: HealthStatus;
    readonly reasons: string[];
  };
}

/** JSON success response in the shape the bridge consumes (`status` / `body`). */
function ok(body: Record<string, unknown>, status = 200): HandlerResult {
  return { status, body };
}

/** Structured error response (status >= 400 → bridge records a `failed` outcome). */
function fail(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HandlerResult {
  return {
    status,
    body: { error: { code, message, details: details ?? {} } },
  };
}

/** Coerce to a trimmed non-empty string, else null. */
function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** First defined non-empty string among the provided candidate keys. */
function firstString(args: Args, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = asString(args[key]);
    if (found) return found;
  }
  return null;
}

/** Parse a timestamptz column (pg returns Date; JSON transport returns string). */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Coerce a pg numeric/string response_status into a finite integer, else null. */
function toStatusCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Entry point registered in DOMAIN_DISPATCH as `check_gbp_connection_health`.
 */
export async function handleCheckGbpConnectionHealth(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const db = ctx?.db;
  if (!db || typeof db.query !== "function") {
    return fail(500, "dependency_unavailable", "Database client not found on handler context.");
  }

  // Resolve the connection by any identifier the caller supplies. gbp_connections
  // is UNIQUE per org, so org_id / connection id / selected location all resolve
  // to a single row.
  const connectionId = firstString(args, ["connectionId", "connection_id"]);
  const orgId = firstString(args, ["orgId", "org_id"]);
  const locationName = firstString(args, ["locationName", "location_name", "location"]);

  if (!connectionId && !orgId && !locationName) {
    return fail(
      400,
      "invalid_arguments",
      "check_gbp_connection_health requires one of: connectionId, orgId, or locationName.",
    );
  }

  let conn: ConnectionRow | undefined;
  try {
    let rows: ConnectionRow[];
    if (connectionId) {
      rows = await db.query<ConnectionRow>(
        `SELECT id, org_id, access_token, refresh_token_ciphertext, token_expires_at,
                selected_location_name, selected_location_title, verification_state,
                connection_state, paused_reason, last_refreshed_at
           FROM gbp_connections
          WHERE id = $1
          LIMIT 1`,
        connectionId,
      );
    } else if (orgId) {
      rows = await db.query<ConnectionRow>(
        `SELECT id, org_id, access_token, refresh_token_ciphertext, token_expires_at,
                selected_location_name, selected_location_title, verification_state,
                connection_state, paused_reason, last_refreshed_at
           FROM gbp_connections
          WHERE org_id = $1
          LIMIT 1`,
        orgId,
      );
    } else {
      rows = await db.query<ConnectionRow>(
        `SELECT id, org_id, access_token, refresh_token_ciphertext, token_expires_at,
                selected_location_name, selected_location_title, verification_state,
                connection_state, paused_reason, last_refreshed_at
           FROM gbp_connections
          WHERE selected_location_name = $1
          LIMIT 1`,
        locationName as string,
      );
    }
    conn = rows[0];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return fail(502, "connection_lookup_failed", "Failed to load the GBP connection.", { message });
  }

  if (!conn) {
    return fail(404, "connection_not_found", "No GBP connection matched the supplied identifier.", {
      connectionId,
      orgId,
      locationName,
    });
  }

  const resolvedConnectionId = String(conn.id);
  const resolvedOrgId = String(conn.org_id);
  const verificationState = asString(conn.verification_state) ?? "UNKNOWN";
  const isVerified = VERIFIED_STATES.has(verificationState);
  const connectionState = asString(conn.connection_state) ?? "unknown";

  const hasAccessToken = Boolean(asString(conn.access_token));
  const hasRefreshToken = Boolean(asString(conn.refresh_token_ciphertext));

  let expiresAt = toDate(conn.token_expires_at);
  const nowMs = Date.now();
  const isExpiredOrSoon =
    expiresAt === null || expiresAt.getTime() - nowMs < EXPIRY_REFRESH_WINDOW_MS;

  // ── Mutation: refresh the access token when it is missing / near expiry ──
  let refreshAttempted = false;
  let refreshSucceeded = false;
  let refreshError: string | null = null;
  let effectiveHasAccessToken = hasAccessToken;

  if (hasRefreshToken && (!hasAccessToken || isExpiredOrSoon)) {
    refreshAttempted = true;
    try {
      const refreshed = await refreshConnectionToken(resolvedConnectionId);
      refreshSucceeded = true;
      effectiveHasAccessToken = true;
      expiresAt = new Date(nowMs + refreshed.expiresIn * 1000);
    } catch (error: unknown) {
      refreshError = error instanceof Error ? error.message : "unknown_error";
    }
  }

  // ── Recent API errors from the quota/telemetry ledger (last 24h) ──
  let errorRows: ApiCallRow[] = [];
  try {
    errorRows = await db.query<ApiCallRow>(
      `SELECT response_status, error_message, created_at
         FROM gbp_api_calls
        WHERE connection_id = $1
          AND created_at >= NOW() - INTERVAL '24 hours'
          AND (response_status >= 400 OR error_message IS NOT NULL)
        ORDER BY created_at DESC
        LIMIT 50`,
      resolvedConnectionId,
    );
  } catch {
    // Telemetry is best-effort — a missing/locked ledger must not fail the probe.
    errorRows = [];
  }

  const statuses = errorRows
    .map((r) => toStatusCode(r.response_status))
    .filter((v): v is number => v !== null && v >= 400);
  const uniqueStatuses = Array.from(new Set(statuses)).sort((a, b) => a - b);
  const lastErrorAt = errorRows.length > 0 ? toDate(errorRows[0].created_at) : null;

  const hasAuthError = statuses.some((s) => UNHEALTHY_STATUSES.has(s));
  const hasTransientError = statuses.some((s) => DEGRADED_STATUSES.has(s));

  // ── Verdict ──
  let status: HealthStatus = "healthy";
  const reasons: string[] = [];
  const demote = (next: HealthStatus): void => {
    const rank: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unhealthy: 2 };
    if (rank[next] > rank[status]) status = next;
  };

  if (!hasRefreshToken) {
    demote("unhealthy");
    reasons.push("No refresh token on file — the connection must be re-authorized.");
  }
  if (!effectiveHasAccessToken) {
    demote("unhealthy");
    reasons.push(
      refreshAttempted
        ? `Access token is unusable and the refresh failed${refreshError ? ` (${refreshError})` : ""}.`
        : "No access token on file.",
    );
  }
  if (hasAuthError) {
    demote("unhealthy");
    reasons.push("Google returned authorization errors (401/403) in the last 24h.");
  }
  if (connectionState === "paused") {
    demote("degraded");
    reasons.push(
      conn.paused_reason
        ? `Connection is paused: ${conn.paused_reason}.`
        : "Connection is paused.",
    );
  }
  if (!isVerified) {
    demote("degraded");
    reasons.push(`Location verification state is ${verificationState}.`);
  }
  if (hasTransientError) {
    demote("degraded");
    reasons.push("Google returned transient/quota errors (429/5xx) in the last 24h.");
  }
  if (reasons.length === 0) {
    reasons.push("Token valid, location verified, no recent API errors.");
  }

  const data: ConnectionHealthData = {
    connectionId: resolvedConnectionId,
    orgId: resolvedOrgId,
    locationName: asString(conn.selected_location_name),
    locationTitle: asString(conn.selected_location_title),
    checkedAt: new Date(nowMs).toISOString(),
    token: {
      hasAccessToken: effectiveHasAccessToken,
      hasRefreshToken,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      expiresSoon: isExpiredOrSoon,
      refreshAttempted,
      refreshSucceeded,
      refreshError,
    },
    verification: {
      state: verificationState,
      isVerified,
    },
    connectionState,
    recentApiErrors: {
      total: statuses.length,
      statuses: uniqueStatuses,
      lastErrorAt: lastErrorAt ? lastErrorAt.toISOString() : null,
    },
    verdict: {
      status,
      reasons,
    },
  };

  return ok({
    status: "checked",
    tool: "check_gbp_connection_health",
    autonomy: "autonomous",
    health: data,
  });
}
