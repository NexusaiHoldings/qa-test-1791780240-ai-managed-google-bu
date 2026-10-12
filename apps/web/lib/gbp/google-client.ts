/**
 * Google Business Profile HTTP client.
 *
 * EVERY outbound Google API call MUST flow through this module: each call is
 * timed and written to `gbp_api_calls` (the quota ledger the operator health
 * monitor consumes), success or failure. Uses the substrate's externalized
 * `pg` pattern — a lazy `require("pg")` so Next's file tracer bundles the
 * driver and preview builds without a DB still compile (pool created on first
 * query, never at module load / build time).
 */

export type GoogleCallInput = {
  orgId?: string;
  connectionId?: string;
  method: string;
  endpoint: string;
  accessToken: string;
  body?: unknown;
};

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PoolLike;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

const db = {
  query: (sql: string, params?: unknown[]) => getPool().query(sql, params),
};

async function logCall(args: {
  orgId?: string;
  connectionId?: string;
  method: string;
  endpoint: string;
  requestBody?: unknown;
  responseStatus?: number;
  responseBody?: unknown;
  errorMessage?: string;
  latencyMs: number;
}): Promise<void> {
  await db.query(
    `INSERT INTO gbp_api_calls
      (org_id, connection_id, method, endpoint, request_body, response_status, response_body, error_message, latency_ms)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)`,
    [
      args.orgId ?? null,
      args.connectionId ?? null,
      args.method,
      args.endpoint,
      args.requestBody ? JSON.stringify(args.requestBody) : null,
      args.responseStatus ?? null,
      args.responseBody ? JSON.stringify(args.responseBody) : null,
      args.errorMessage ?? null,
      args.latencyMs,
    ],
  );
}

export async function googleApiCall<T>(input: GoogleCallInput): Promise<T> {
  const started = Date.now();
  try {
    const response = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${input.endpoint}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;

    await logCall({
      orgId: input.orgId,
      connectionId: input.connectionId,
      method: input.method,
      endpoint: input.endpoint,
      requestBody: input.body,
      responseStatus: response.status,
      responseBody: parsed,
      latencyMs: Date.now() - started,
    });

    if (!response.ok) {
      throw new Error(`Google API ${response.status}: ${text}`);
    }
    return parsed as T;
  } catch (error) {
    await logCall({
      orgId: input.orgId,
      connectionId: input.connectionId,
      method: input.method,
      endpoint: input.endpoint,
      requestBody: input.body,
      errorMessage: error instanceof Error ? error.message : "unknown_error",
      latencyMs: Date.now() - started,
    });
    throw error;
  }
}

export async function googleApiCallRaw<T>(
  input: GoogleCallInput & { baseUrl: string; endpoint: string },
): Promise<T> {
  const started = Date.now();
  try {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/${input.endpoint.replace(/^\//, "")}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;

    await logCall({
      orgId: input.orgId,
      connectionId: input.connectionId,
      method: input.method,
      endpoint: `${input.baseUrl}/${input.endpoint}`,
      requestBody: input.body,
      responseStatus: response.status,
      responseBody: parsed,
      latencyMs: Date.now() - started,
    });

    if (!response.ok) {
      throw new Error(`Google API ${response.status}: ${text}`);
    }
    return parsed as T;
  } catch (error) {
    await logCall({
      orgId: input.orgId,
      connectionId: input.connectionId,
      method: input.method,
      endpoint: `${input.baseUrl}/${input.endpoint}`,
      requestBody: input.body,
      errorMessage: error instanceof Error ? error.message : "unknown_error",
      latencyMs: Date.now() - started,
    });
    throw error;
  }
}
