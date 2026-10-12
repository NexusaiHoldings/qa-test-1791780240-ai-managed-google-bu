import type { JSX } from "react";
import { redirect } from "next/navigation";
import { resolveGbpContext } from "@/lib/gbp/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

type LocationRow = {
  account_name: string;
  location_name: string;
  title: string;
  primary_category_display_name: string | null;
  verification_state: string | null;
  average_rating: string | null;
  user_role: string | null;
  is_selectable: boolean;
  selectable_reason: string | null;
};

/** Pause copy per verification state. VERIFIED → no pause (returns null). */
function pausedReasonFor(verificationState: string | null): string | null {
  if (!verificationState || verificationState === "VERIFIED") return null;
  if (verificationState === "SUSPENDED") {
    return "This location is suspended by Google. We’ll start publishing automatically once Google reinstates it.";
  }
  return "This location isn’t verified yet. We’ll start publishing automatically once Google verifies it.";
}

async function selectLocation(formData: FormData): Promise<void> {
  "use server";
  const ctx = await resolveGbpContext();
  if (!ctx) {
    redirect("/login");
  }
  const locationName = String(formData.get("locationName") ?? "");
  if (!locationName) {
    redirect("/connect/select-location?error=no_selection");
  }

  const db = getPool();
  const locRes = await db.query(
    `SELECT account_name, location_name, title, primary_category_display_name,
            verification_state, metadata, is_selectable
       FROM gbp_locations_cache
      WHERE org_id = $1 AND location_name = $2
      LIMIT 1`,
    [ctx.orgId, locationName],
  );
  if (locRes.rowCount === 0) {
    redirect("/connect/select-location?error=unknown_location");
  }
  const loc = locRes.rows[0] as {
    account_name: string;
    location_name: string;
    title: string;
    primary_category_display_name: string | null;
    verification_state: string | null;
    metadata: unknown;
    is_selectable: boolean;
  };

  // Guard against a disabled (agency-managed) listing being posted directly.
  if (!loc.is_selectable) {
    redirect("/connect/select-location?error=access_required");
  }

  const pausedReason = pausedReasonFor(loc.verification_state);
  await db.query(
    `UPDATE gbp_connections
        SET selected_account_name = $2,
            selected_location_name = $3,
            selected_location_title = $4,
            selected_location_metadata = $5::jsonb,
            primary_category_display_name = $6,
            verification_state = $7,
            connection_state = $8,
            paused_reason = $9,
            updated_at = NOW()
      WHERE org_id = $1`,
    [
      ctx.orgId,
      loc.account_name,
      loc.location_name,
      loc.title,
      JSON.stringify(loc.metadata ?? {}),
      loc.primary_category_display_name,
      loc.verification_state,
      pausedReason ? "paused" : "active",
      pausedReason,
    ],
  );
  redirect("/");
}

export default async function SelectLocationPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    return (
      <main>
        <h1>Choose your location</h1>
        <p className="muted">
          Please <a href="/login">log in</a> to finish connecting.
        </p>
      </main>
    );
  }

  const rows = await getPool().query(
    `SELECT account_name, location_name, title, primary_category_display_name,
            verification_state, average_rating, user_role, is_selectable, selectable_reason
       FROM gbp_locations_cache
      WHERE org_id = $1
      ORDER BY is_selectable DESC, updated_at DESC`,
    [ctx.orgId],
  );
  const locations = rows.rows as LocationRow[];

  // Edge case: zero locations → route to a "claim your profile" explainer.
  if (locations.length === 0) {
    return (
      <main>
        <h1>No Business Profile locations found</h1>
        <p className="muted">
          Your Google account isn’t managing any Business Profile locations yet.
        </p>
        <div className="card empty">
          <p aria-hidden="true" style={{ fontSize: "2.5rem" }}>
            📍
          </p>
          <p>
            Claim or create your Business Profile on Google first, then come back
            and reconnect — we’ll pick it up automatically.
          </p>
          <a
            className="btn"
            href="https://www.google.com/business/"
            target="_blank"
            rel="noreferrer"
          >
            Claim your profile
          </a>
        </div>
      </main>
    );
  }

  const errorCode = searchParams?.error;
  const selectableCount = locations.filter((l) => l.is_selectable).length;

  return (
    <main>
      <h1>Choose your location</h1>
      <p className="muted">
        Authorize → <strong>Choose location</strong> → Done
      </p>

      {errorCode === "access_required" && (
        <div className="card" role="alert">
          <p>
            That location is managed by an agency account. Grant access first
            (steps below), then reconnect.
          </p>
        </div>
      )}

      <form action={selectLocation}>
        <ul>
          {locations.map((loc) => {
            const pausedReason = pausedReasonFor(loc.verification_state);
            return (
              <li key={loc.location_name} className="card">
                <label>
                  <input
                    type="radio"
                    name="locationName"
                    value={loc.location_name}
                    disabled={!loc.is_selectable}
                    required
                  />{" "}
                  <strong>📍 {loc.title}</strong>
                </label>
                <p className="muted">
                  {loc.primary_category_display_name ?? "No category"} · ⭐{" "}
                  {loc.average_rating ?? "—"} ·{" "}
                  {loc.verification_state ?? "Unknown"}
                </p>

                {!loc.is_selectable && (
                  <p>
                    <strong>Agency-managed account.</strong> You’re not an owner
                    or manager of this listing. In Google Business Profile, open{" "}
                    <em>Business Profile settings → People and access → Add</em>,
                    enter your Google account email, choose the{" "}
                    <em>Manager</em> (or Owner) role, then return here and
                    reconnect.
                  </p>
                )}

                {loc.is_selectable && pausedReason && (
                  <p>{pausedReason}</p>
                )}
              </li>
            );
          })}
        </ul>
        <button type="submit" disabled={selectableCount === 0}>
          Use this location
        </button>
      </form>

      {selectableCount === 0 && (
        <p className="muted">
          None of your locations can be managed with this Google account yet.
          Grant Owner or Manager access using the steps above, then reconnect.
        </p>
      )}
    </main>
  );
}
