import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  orgId?: string;
  accountId?: string;
  locationId?: string;
  runId?: string;
  [key: string]: unknown;
};

type SnapshotRow = {
  id: string;
  keyword: string;
  latitude: number;
  longitude: number;
  rankPosition: number | null;
  provider: string;
  providerQueryId: string | null;
  capturedAt: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed: number = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isConfirmAllowed(args: Args): boolean {
  const confirm: unknown = args.confirm;
  if (confirm === true) return true;
  if (typeof confirm === "string") {
    const normalized: string = confirm.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "confirm";
  }
  return false;
}

function ok(result: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    output: result,
  } as unknown as HandlerResult;
}

function fail(code: string, message: string, details?: Record<string, unknown>): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  } as unknown as HandlerResult;
}

export async function handleFetchLocalRankPositions(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    if (!isConfirmAllowed(args)) {
      return fail(
        "confirmation_required",
        "This tool spends rank-provider credits and requires explicit confirmation.",
      );
    }

    const orgId: string | null =
      asNonEmptyString(args.orgId) ??
      asNonEmptyString((ctx as unknown as { orgId?: unknown }).orgId);
    const accountId: string | null = asNonEmptyString(args.accountId);
    const locationId: string | null = asNonEmptyString(args.locationId);
    const runId: string | null = asNonEmptyString(args.runId);

    if (!orgId) {
      return fail("invalid_arguments", "Missing required orgId.");
    }
    if (!accountId) {
      return fail("invalid_arguments", "Missing required accountId.");
    }
    if (!locationId) {
      return fail("invalid_arguments", "Missing required locationId.");
    }

    const db = (ctx as unknown as { db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).db;
    if (!db || typeof db.query !== "function") {
      return fail("dependency_unavailable", "Database client not found on handler context.");
    }

    const activeKeywordsRes = await db.query(
      `
      SELECT keyword
      FROM gbp_keywords
      WHERE org_id = $1
        AND account_id = $2
        AND location_id = $3
        AND is_active = TRUE
      ORDER BY keyword ASC
      `,
      [orgId, accountId, locationId],
    );

    const keywords: string[] = activeKeywordsRes.rows
      .map((r: Record<string, unknown>) => asNonEmptyString(r.keyword))
      .filter((v: string | null): v is string => v !== null);

    if (keywords.length === 0) {
      return ok({
        status: "no_keywords",
        orgId,
        accountId,
        locationId,
        snapshotsInserted: 0,
      });
    }

    const locationRes = await db.query(
      `
      SELECT service_area_centroid_lat, service_area_centroid_lng
      FROM gbp_locations
      WHERE org_id = $1
        AND account_id = $2
        AND location_id = $3
      LIMIT 1
      `,
      [orgId, accountId, locationId],
    );

    const locationRow: Record<string, unknown> | undefined = locationRes.rows[0];
    const latitude: number | null = asFiniteNumber(locationRow?.service_area_centroid_lat);
    const longitude: number | null = asFiniteNumber(locationRow?.service_area_centroid_lng);

    if (latitude === null || longitude === null) {
      return fail(
        "missing_centroid",
        "Primary service-area centroid is required before fetching local rank positions.",
      );
    }

    const rankProvider = (ctx as unknown as {
      rankProvider?: {
        fetchLocalRankPosition: (input: {
          keyword: string;
          latitude: number;
          longitude: number;
          accountId: string;
          locationId: string;
          orgId: string;
        }) => Promise<{ position: number | null; provider: string; queryId?: string | null }>;
      };
    }).rankProvider;

    if (!rankProvider || typeof rankProvider.fetchLocalRankPosition !== "function") {
      return fail("dependency_unavailable", "Rank provider client not found on handler context.");
    }

    const snapshots: SnapshotRow[] = [];
    const failures: Array<{ keyword: string; error: string }> = [];

    for (const keyword of keywords) {
      try {
        const providerResult = await rankProvider.fetchLocalRankPosition({
          keyword,
          latitude,
          longitude,
          accountId,
          locationId,
          orgId,
        });

        const insertRes = await db.query(
          `
          INSERT INTO gbp_rank_snapshots (
            org_id,
            account_id,
            location_id,
            keyword,
            centroid_lat,
            centroid_lng,
            rank_position,
            provider_name,
            provider_query_id,
            captured_at,
            run_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
          RETURNING id, keyword, centroid_lat, centroid_lng, rank_position, provider_name, provider_query_id, captured_at
          `,
          [
            orgId,
            accountId,
            locationId,
            keyword,
            latitude,
            longitude,
            providerResult.position,
            providerResult.provider,
            providerResult.queryId ?? null,
            runId,
          ],
        );

        const row: Record<string, unknown> | undefined = insertRes.rows[0];
        snapshots.push({
          id: String(row?.id ?? ""),
          keyword: String(row?.keyword ?? keyword),
          latitude: asFiniteNumber(row?.centroid_lat) ?? latitude,
          longitude: asFiniteNumber(row?.centroid_lng) ?? longitude,
          rankPosition: asFiniteNumber(row?.rank_position),
          provider: String(row?.provider_name ?? providerResult.provider),
          providerQueryId: asNonEmptyString(row?.provider_query_id),
          capturedAt: String(row?.captured_at ?? new Date().toISOString()),
        });
      } catch (error: unknown) {
        failures.push({
          keyword,
          error: error instanceof Error ? error.message : "Unknown provider/database error",
        });
      }
    }

    return ok({
      status: failures.length > 0 ? "partial_success" : "success",
      orgId,
      accountId,
      locationId,
      centroid: { latitude, longitude },
      snapshotsInserted: snapshots.length,
      failures,
      snapshots,
    });
  } catch (error: unknown) {
    return fail(
      "internal_error",
      "Failed to fetch local rank positions.",
      {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    );
  }
}
