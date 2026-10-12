import { sql, googleGet } from "@/lib/gbp/google-client";

export async function listSelectableLocations(
  orgId: string,
  userId: string
): Promise<{
  locations: Array<{
    locationName: string;
    title: string;
    primaryCategory: string | null;
    starRating: number | null;
    isVerified: boolean;
    isSuspended: boolean;
  }>;
}> {
  const accountsResp = (await googleGet(orgId, "/v1/accounts")) as { accounts?: Array<{ name: string }> };
  const accounts = accountsResp.accounts ?? [];
  const out: Array<{
    locationName: string;
    title: string;
    primaryCategory: string | null;
    starRating: number | null;
    isVerified: boolean;
    isSuspended: boolean;
  }> = [];

  for (const acct of accounts) {
    const locResp = (await googleGet(orgId, `/v1/${acct.name}/locations`)) as {
      locations?: Array<{
        name: string;
        title?: string;
        primaryCategory?: { displayName?: string };
        metadata?: { placeId?: string };
        profile?: { description?: string };
        relationshipData?: { isVerified?: boolean };
        storefrontAddress?: Record<string, unknown>;
      }>;
    };

    for (const loc of locResp.locations ?? []) {
      out.push({
        locationName: loc.name,
        title: loc.title ?? loc.name,
        primaryCategory: loc.primaryCategory?.displayName ?? null,
        starRating: null,
        isVerified: Boolean(loc.relationshipData?.isVerified),
        isSuspended: false,
      });
    }
  }

  await sql(
    `insert into gbp_location_cache (id, org_id, user_id, payload_json, created_at)
     values (gen_random_uuid(), $1, $2, $3::jsonb, now())`,
    [orgId, userId, JSON.stringify(out)]
  );

  return { locations: out };
}

export async function selectLocationForOrg(orgId: string, userId: string, locationName: string): Promise<void> {
  const rows = await sql<{ payload_json: unknown[] }>(
    `select payload_json
     from gbp_location_cache
     where org_id = $1 and user_id = $2
     order by created_at desc
     limit 1`,
    [orgId, userId]
  );
  const payload = (rows[0]?.payload_json ?? []) as Array<{
    locationName: string;
    title: string;
    primaryCategory: string | null;
    starRating: number | null;
    isVerified: boolean;
    isSuspended: boolean;
  }>;
  const selected = payload.find((x) => x.locationName === locationName);
  if (!selected) {
    throw new Error("Selected location not found");
  }

  await sql(
    `update gbp_connections
     set selected_location_name = $1,
         selected_location_title = $2,
         selected_primary_category = $3,
         selected_star_rating = $4,
         verification_state = $5,
         publishing_paused = $6,
         updated_at = now()
     where org_id = $7`,
    [
      selected.locationName,
      selected.title,
      selected.primaryCategory,
      selected.starRating,
      selected.isVerified ? "VERIFIED" : "UNVERIFIED",
      selected.isSuspended || !selected.isVerified,
      orgId,
    ]
  );
}
