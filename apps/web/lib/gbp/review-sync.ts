/**
 * Review sync (F1-006).
 *
 * Pulls reviews from the Google Business Profile v4 `reviews.list` endpoint for a
 * connection's selected location, mirrors each new one into `gbp_reviews` (the
 * raw comment is PII-redacted + sensitivity-classified inside `ingestReview`
 * before it is ever persisted), and runs the responder pipeline on new reviews.
 *
 * Two entry points:
 *   - `syncReviewsForConnection` — one connection (used by the Pub/Sub webhook).
 *   - `syncAllConnections`       — every active connection (used by the 6-hourly
 *     poll cron).
 *
 * DB access uses the substrate's lazy `require("pg")` pool so preview builds
 * without DATABASE_URL still compile; all queries are parameterized.
 */

import { googleApiCallRaw } from "@/lib/gbp/google-client";
import { refreshConnectionToken } from "@/lib/gbp/oauth";
import { redactReviewerName } from "@/lib/gbp/pii-redact";
import { ingestReview, processReview, type ProcessResult } from "@/lib/gbp/review-responder";

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
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

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export interface GbpConnection {
  id: string;
  orgId: string;
  accountName: string | null;
  locationName: string | null;
}

/** Map Google's star-rating enum to an integer 1–5. */
const STAR_MAP: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

function parseStarRating(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.min(5, Math.round(value)));
  if (typeof value === "string") return STAR_MAP[value.toUpperCase()] ?? 0;
  return 0;
}

interface GoogleReviewer {
  displayName?: string;
  isAnonymous?: boolean;
}

interface GoogleReview {
  reviewId?: string;
  name?: string;
  reviewer?: GoogleReviewer;
  starRating?: string | number;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string } | null;
}

interface GoogleReviewsResponse {
  reviews?: GoogleReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}

/** Build the `accounts/.../locations/...` resource path for a connection. */
function buildLocationResource(accountName: string | null, locationName: string): string {
  if (locationName.startsWith("accounts/")) return locationName;
  if (accountName) return `${accountName.replace(/\/$/, "")}/${locationName.replace(/^\//, "")}`;
  return locationName;
}

/** List active connections eligible for review sync. */
export async function listActiveConnections(): Promise<GbpConnection[]> {
  const rows = await query(
    `SELECT id, org_id, selected_account_name, selected_location_name
       FROM gbp_connections
      WHERE connection_state = 'active' AND selected_location_name IS NOT NULL
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    accountName: r.selected_account_name == null ? null : String(r.selected_account_name),
    locationName: r.selected_location_name == null ? null : String(r.selected_location_name),
  }));
}

/** Resolve a single connection by id (used by the webhook, keyed on location). */
export async function getConnectionByLocation(locationName: string): Promise<GbpConnection | null> {
  const normalized = locationName.replace(/^\//, "");
  const rows = await query(
    `SELECT id, org_id, selected_account_name, selected_location_name
       FROM gbp_connections
      WHERE connection_state = 'active'
        AND (selected_location_name = $1 OR selected_location_name = $2 OR $1 LIKE '%' || selected_location_name)
      ORDER BY created_at ASC
      LIMIT 1`,
    [normalized, locationName],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    accountName: r.selected_account_name == null ? null : String(r.selected_account_name),
    locationName: r.selected_location_name == null ? null : String(r.selected_location_name),
  };
}

export interface SyncResult {
  connectionId: string;
  orgId: string;
  fetched: number;
  ingested: number;
  processed: ProcessResult[];
  error: string | null;
}

/**
 * Fetch reviews for one connection, mirror new ones, and run the responder on
 * each new review. Reviews that Google shows as already owner-replied are marked
 * skipped (we never overwrite a manual reply). Never throws — a per-connection
 * error is captured in the result.
 */
export async function syncReviewsForConnection(connection: GbpConnection): Promise<SyncResult> {
  const result: SyncResult = {
    connectionId: connection.id,
    orgId: connection.orgId,
    fetched: 0,
    ingested: 0,
    processed: [],
    error: null,
  };
  if (!connection.locationName) {
    result.error = "connection_has_no_location";
    return result;
  }

  try {
    const { accessToken } = await refreshConnectionToken(connection.id);
    const resource = buildLocationResource(connection.accountName, connection.locationName);

    const response = await googleApiCallRaw<GoogleReviewsResponse>({
      baseUrl: "https://mybusiness.googleapis.com",
      endpoint: `v4/${resource}/reviews?pageSize=50&orderBy=updateTime desc`,
      method: "GET",
      accessToken,
      orgId: connection.orgId,
      connectionId: connection.id,
    });

    const reviews = Array.isArray(response?.reviews) ? response.reviews : [];
    result.fetched = reviews.length;

    for (const raw of reviews) {
      const googleReviewId = raw.reviewId ?? (raw.name ? raw.name.split("/").pop() ?? "" : "");
      if (!googleReviewId) continue;

      const ingest = await ingestReview({
        orgId: connection.orgId,
        connectionId: connection.id,
        locationName: connection.locationName,
        googleReviewId,
        googleReviewName: raw.name ?? null,
        reviewerDisplayName: redactReviewerName(raw.reviewer?.displayName, Boolean(raw.reviewer?.isAnonymous)),
        reviewerIsAnonymous: Boolean(raw.reviewer?.isAnonymous),
        starRating: parseStarRating(raw.starRating),
        rawComment: raw.comment ?? null,
        reviewCreateTime: raw.createTime ?? null,
        reviewUpdateTime: raw.updateTime ?? null,
      });

      if (!ingest.isNew) continue;
      result.ingested += 1;

      // Respect a reply the owner already left directly on Google.
      if (raw.reviewReply && (raw.reviewReply.comment ?? "").trim()) {
        await query(
          `UPDATE gbp_reviews
              SET reply_status = 'skipped', published_reply = $2, published_at = NOW(),
                  failure_reason = 'already_replied_on_google', updated_at = NOW()
            WHERE id = $1`,
          [ingest.review.id, raw.reviewReply.comment ?? null],
        );
        continue;
      }

      const processed = await processReview(ingest.review.id);
      result.processed.push(processed);
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : "unknown_error";
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_sync_failed",
        connectionId: connection.id,
        orgId: connection.orgId,
        error: result.error,
      }),
    );
    return result;
  }
}

export interface SyncAllResult {
  connections: number;
  fetched: number;
  ingested: number;
  autoPublished: number;
  queued: number;
  failed: number;
  results: SyncResult[];
}

/** Sync every active connection — the 6-hourly poll entry point. */
export async function syncAllConnections(): Promise<SyncAllResult> {
  const connections = await listActiveConnections();
  const summary: SyncAllResult = {
    connections: connections.length,
    fetched: 0,
    ingested: 0,
    autoPublished: 0,
    queued: 0,
    failed: 0,
    results: [],
  };

  for (const connection of connections) {
    const res = await syncReviewsForConnection(connection);
    summary.results.push(res);
    summary.fetched += res.fetched;
    summary.ingested += res.ingested;
    for (const p of res.processed) {
      if (p.action === "auto_published") summary.autoPublished += 1;
      else if (p.action === "queued") summary.queued += 1;
      else if (p.action === "failed") summary.failed += 1;
    }
    if (res.error) summary.failed += 1;
  }

  return summary;
}
