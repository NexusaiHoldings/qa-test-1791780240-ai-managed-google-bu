import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type HealthVerdict = "healthy" | "degraded" | "unhealthy";

type ConnectionRow = {
  id: string;
  org_id: string;
  location_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
};

type VerificationRow = {
  location_id: string;
  verification_state: string;
  fetched_at: string;
};

type ApiErrorRow = {
  status_code: number | null;
  error_code: string | null;
  created_at: string;
};

const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const RECENT_ERROR_LOOKBACK_HOURS = 24;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asUuidLike(value: string | null): string | null {
  if (!value) return null;
  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  return uuidLike ? value : null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function runQuery<T = unknown>(ctx: HandlerContext, sql: string, params: unknown[]): Promise<T[]> {
  const maybeDb = (ctx as { db?: { query?: (q: string, p?: unknown[]) => Promise<{ rows?: T[] } | T[]> } }).db;
  if (!maybeDb?.query) {
    throw new Error("Database client unavailable on handler context");
  }
  const result = await maybeDb.query(sql, params);
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function maybeRefreshToken(
  ctx: HandlerContext,
  connection: ConnectionRow,
): Promise<{ refreshed: boolean; newExpiryIso: string | null; refreshError: string | null }> {
  const expiresAt = parseDate(connection.token_expires_at);
  const shouldRefresh =
    !expiresAt || expiresAt.getTime() - Date.now() <= TOKEN_REFRESH_WINDOW_MS;

  if (!shouldRefresh) {
    return { refreshed: false, newExpiryIso: connection.token_expires_at, refreshError: null };
  }

  try {
    const bridge = (ctx as { bridge?: { invokeMutation?: (name: string, payload: Record<string, unknown>) => Promise<unknown> } }).bridge;
    if (!bridge?.invokeMutation) {
      return {
        refreshed: false,
        newExpiryIso: connection.token_expires_at,
        refreshError: "mutation_bridge_unavailable",
      };
    }

    const payload = {
      connectionId: connection.id,
      locationId: connection.location_id,
      orgId: connection.org_id,
      reason: "health_check",
      requestedAt: nowIso(),
      confirm: true,
    };

    const response = await bridge.invokeMutation("refresh_gbp_connection_token", payload);
    const nextExpiry =
      typeof (response as { tokenExpiresAt?: unknown })?.tokenExpiresAt === "string"
        ? ((response as { tokenExpiresAt: string }).tokenExpiresAt ?? null)
        : connection.token_expires_at;

    return { refreshed: true, newExpiryIso: nextExpiry, refreshError: null };
  } catch (error) {
    return {
      refreshed: false,
      newExpiryIso: connection.token_expires_at,
      refreshError: error instanceof Error ? error.message : "token_refresh_failed",
    };
  }
}

export async function handleCheckGbpConnectionHealth(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const locationId = asString(args.locationId);
    const orgId = asUuidLike(asString(args.orgId) ?? "");

    if (!locationId || !orgId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "Both orgId (uuid) and locationId are required",
        },
      } as HandlerResult;
    }

    const connections = await runQuery<ConnectionRow>(
      ctx,
      `
      SELECT id, org_id, location_id, access_token_encrypted, refresh_token_encrypted, token_expires_at
      FROM gbp_connections
      WHERE org_id = $1 AND location_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [orgId, locationId],
    );

    if (connections.length === 0) {
      return {
        ok: false,
        error: { code: "not_found", message: "GBP connection not found for location" },
      } as HandlerResult;
    }

    const connection = connections[0];
    const tokenCheck = await maybeRefreshToken(ctx, connection);

    const verificationRows = await runQuery<VerificationRow>(
      ctx,
      `
      SELECT location_id, verification_state, fetched_at
      FROM gbp_location_verification
      WHERE org_id = $1 AND location_id = $2
      ORDER BY fetched_at DESC
      LIMIT 1
      `,
      [orgId, locationId],
    );

    const recentErrors = await runQuery<ApiErrorRow>(
      ctx,
      `
      SELECT status_code, error_code, created_at
      FROM gbp_api_calls
      WHERE org_id = $1
        AND location_id = $2
        AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
        AND (
          (status_code IS NOT NULL AND status_code >= 400)
          OR error_code IS NOT NULL
        )
      ORDER BY created_at DESC
      LIMIT 25
      `,
      [orgId, locationId, RECENT_ERROR_LOOKBACK_HOURS],
    );

    const verificationState = verificationRows[0]?.verification_state ?? "unknown";
    const unverified =
      verificationState === "unverified" ||
      verificationState === "suspended" ||
      verificationState === "pending";

    const authFailures = recentErrors.filter(
      (e) => e.status_code === 401 || e.status_code === 403 || e.error_code === "AUTH_ERROR",
    ).length;

    const serverFailures = recentErrors.filter((e) => (e.status_code ?? 0) >= 500).length;

    let verdict: HealthVerdict = "healthy";
    if (tokenCheck.refreshError || authFailures > 0 || unverified) {
      verdict = "unhealthy";
    } else if (serverFailures > 2 || recentErrors.length > 5) {
      verdict = "degraded";
    }

    return {
      ok: true,
      data: {
        verdict,
        locationId,
        orgId,
        token: {
          refreshed: tokenCheck.refreshed,
          expiresAt: tokenCheck.newExpiryIso,
          refreshError: tokenCheck.refreshError,
        },
        verification: {
          state: verificationState,
          checkedAt: verificationRows[0]?.fetched_at ?? null,
        },
        recentApiErrors: {
          lookbackHours: RECENT_ERROR_LOOKBACK_HOURS,
          count: recentErrors.length,
          authFailures,
          serverFailures,
          latest: recentErrors.slice(0, 5),
        },
      },
    } as HandlerResult;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "check_gbp_connection_health_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    } as HandlerResult;
  }
}
