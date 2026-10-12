import { redirect } from "next/navigation";
import { Pool } from "pg";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

type LocationRow = {
  account_name: string;
  location_name: string;
  title: string;
  primary_category_display_name: string | null;
  verification_state: string | null;
  average_rating: string | null;
  is_selectable: boolean;
  selectable_reason: string | null;
};

async function getOrgId(): Promise<string> {
  const orgId = process.env.DEMO_ORG_ID;
  if (!orgId) throw new Error("Missing DEMO_ORG_ID");
  return orgId;
}

async function selectLocation(formData: FormData): Promise<void> {
  "use server";
  const orgId = await getOrgId();
  const locationName = String(formData.get("locationName") ?? "");
  if (!locationName) return;

  const locRes = await db.query(
    `SELECT account_name, location_name, title, primary_category_display_name, verification_state
     FROM gbp_locations_cache
     WHERE org_id = $1 AND location_name = $2
     LIMIT 1`,
    [orgId, locationName],
  );
  if (locRes.rowCount === 0) return;
  const loc = locRes.rows[0] as {
    account_name: string;
    location_name: string;
    title: string;
    primary_category_display_name: string | null;
    verification_state: string | null;
  };

  const paused = loc.verification_state && loc.verification_state !== "VERIFIED";
  await db.query(
    `UPDATE gbp_connections
     SET selected_account_name = $2,
         selected_location_name = $3,
         selected_location_title = $4,
         primary_category_display_name = $5,
         verification_state = $6,
         connection_state = $7,
         paused_reason = $8,
         updated_at = NOW()
     WHERE org_id = $1`,
    [
      orgId,
      loc.account_name,
      loc.location_name,
      loc.title,
      loc.primary_category_display_name,
      loc.verification_state,
      paused ? "paused" : "active",
      paused ? "We'll start publishing once Google reinstates or verifies this location." : null,
    ],
  );
  redirect("/");
}

export default async function SelectLocationPage(): Promise<JSX.Element> {
  const orgId = await getOrgId();
  const rows = await db.query(
    `SELECT account_name, location_name, title, primary_category_display_name, verification_state, average_rating, is_selectable, selectable_reason
     FROM gbp_locations_cache
     WHERE org_id = $1
     ORDER BY updated_at DESC`,
    [orgId],
  );
  const locations = rows.rows as LocationRow[];

  if (locations.length === 0) {
    return (
      <main>
        <h1>No locations found</h1>
        <p className="muted">Claim your Business Profile first, then reconnect.</p>
        <a className="btn" href="https://www.google.com/business/" target="_blank" rel="noreferrer">Claim your profile</a>
      </main>
    );
  }

  return (
    <main>
      <h1>Choose your location</h1>
      <p className="muted">Authorize → <strong>Choose location</strong> → Done</p>

      <form action={selectLocation}>
        <ul>
          {locations.map((loc) => (
            <li key={loc.location_name} className="card">
              <label>
                <input type="radio" name="locationName" value={loc.location_name} disabled={!loc.is_selectable} required />
                <strong>{loc.title}</strong>
              </label>
              <p className="muted">
                {loc.primary_category_display_name ?? "No category"} · ⭐ {loc.average_rating ?? "—"} · {loc.verification_state ?? "Unknown"}
              </p>
              {!loc.is_selectable && (
                <p>
                  Agency-managed account detected. Ask the profile owner to add your Google account as Owner or Manager in
                  Business Profile settings.
                </p>
              )}
            </li>
          ))}
        </ul>
        <button type="submit">Use this location</button>
      </form>
    </main>
  );
}
