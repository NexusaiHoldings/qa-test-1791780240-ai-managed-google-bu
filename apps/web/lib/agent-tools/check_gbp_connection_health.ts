import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type HealthStatus = "healthy" | "degraded" | "unhealthy";

interface ConnectionHealthData {
  locationName: string;
  checkedAt: string;
  token: {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    refreshedAttempted: boolean;
    refreshedSucceeded: boolean;
  };
  verification: {
    state: string;
    isVerified: boolean;
  };
  recentApiErrors: {
    total: number;
    codes: string[];
  };
  verdict: {
    status: HealthStatus;
    reasons: string[];
  };
}

const VERIFIED_STATES = new Set<string>([
  "VERIFIED",
  "VERIFICATION_STATE_VERIFIED",
  "LOCATION_VERIFIED",
]);

const DEGRADED_ERROR_CODES = new Set<string>([
  "429",
  "500",
  "502",
  "503",
  "504",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
]);

const UNHEALTHY_ERROR_CODES = new Set<string>([
  "401",
  "403",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "INVALID_GRANT",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeJsonParse<T>(input: string | null | undefined): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function toHandlerResult(data: ConnectionHealthData): HandlerResult {
  return {
    ok: true,
    data,
  } as HandlerResult;
}

function toErrorResult(message: string, details?: Record<string, unknown>): HandlerResult {
  return {
    ok: false,
    error: {
      code: "check_gbp_connection_health_failed",
      message,
      ...(details ? { details } : {}),
    },
  } as HandlerResult;
}

export async function handleCheckGbpConnectionHealth(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const db = (ctx as { db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).db;
  if (!db) {
    return toErrorResult("Database client missing on handler context.");
  }

  const locationName = asString(args.locationName ?? args.location_name);
  if (!locationName) {
    return toErrorResult("Missing required argument: locationName");
  }

  try {
    const connRes = await db.query(
      `
        SELECT
          location_name,
          verification_state,
          access_token,
          refresh_token,
          expires_at,
          token_payload_json
        FROM gbp_connections
        WHERE location_name = $1
        LIMIT 1
      `,
      [locationName],
    );

    if (!connRes.rows[0]) {
      return toErrorResult("GBP connection not found for location.", { locationName });
    }

    const row = connRes.rows[0];
    const verificationState = asString(row.verification_state) ?? "UNKNOWN";
    const isVerified = VERIFIED_STATES.has(verificationState);

    const hasAccessToken = Boolean(asString(row.access_token));
    const hasRefreshToken = Boolean(asString(row.refresh_token));

    let refreshedAttempted = false;
    let refreshedSucceeded = false;

    const expiresAtRaw = row.expires_at;
    const expiresAt =
      expiresAtRaw instanceof Date
        ? expiresAtRaw
        : typeof expiresAtRaw === "string"
          ? new Date(expiresAtRaw)
          : null;

    const expiresSoon =
      expiresAt instanceof Date &&
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

    if (hasRefreshToken && (!hasAccessToken || expiresSoon)) {
      refreshedAttempted = true;
      try {
        const payload = safeJsonParse<{ access_token?: string; expires_at?: string }>(
          asString(row.token_payload_json),
        );

        const nextAccess = asString(payload?.access_token);
        const nextExpiry = asString(payload?.expires_at);

        if (nextAccess) {
          await db.query(
            `
              UPDATE gbp_connections
              SET access_token = $2,
                  expires_at = COALESCE($3::timestamptz, expires_at),
                  updated_at = NOW()
              WHERE location_name = $1
            `,
            [locationName, nextAccess, nextExpiry],
          );
          refreshedSucceeded = true;
        }
      } catch {
        refreshedSucceeded = false;
      }
    }

    const errorRes = await db.query(
      `
        SELECT error_code
        FROM gbp_api_calls
        WHERE location_name = $1
          AND created_at >= NOW() - INTERVAL '24 hours'
          AND error_code IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 25
      `,
      [locationName],
    );

    const codes = errorRes.rows
      .map((r) => asString(r.error_code))
      .filter((v): v is string => Boolean(v));

    let status: HealthStatus = "healthy";
    const reasons: string[] = [];

    if (!hasRefreshToken || (!hasAccessToken && !refreshedSucceeded)) {
      status = "unhealthy";
      reasons.push("Token is missing or could not be refreshed.");
    }

    if (!isVerified) {
      if (status === "healthy") status = "degraded";
      reasons.push(`Location verification state is ${verificationState}.`);
    }

    if (codes.some((c) => UNHEALTHY_ERROR_CODES.has(c))) {
      status = "unhealthy";
      reasons.push("Recent API authorization errors detected.");
    } else if (codes.some((c) => DEGRADED_ERROR_CODES.has(c))) {
      if (status === "healthy") status = "degraded";
      reasons.push("Recent API transient/quota errors detected.");
    }

    if (reasons.length === 0) {
      reasons.push("Connection is healthy.");
    }

    const data: ConnectionHealthData = {
      locationName,
      checkedAt: new Date().toISOString(),
      token: {
        hasAccessToken,
        hasRefreshToken,
        refreshedAttempted,
        refreshedSucceeded,
      },
      verification: {
        state: verificationState,
        isVerified,
      },
      recentApiErrors: {
        total: codes.length,
        codes: Array.from(new Set(codes)),
      },
      verdict: {
        status,
        reasons,
      },
    };

    return toHandlerResult(data);
  } catch (error) {
    return toErrorResult("Failed to check GBP connection health.", {
      message: error instanceof Error ? error.message : "unknown_error",
      locationName,
    });
  }
}
