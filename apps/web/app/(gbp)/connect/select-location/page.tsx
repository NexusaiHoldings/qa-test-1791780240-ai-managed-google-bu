import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@nexus/identity-and-access";
import { getCurrentOrgContext } from "@nexus/organizations-and-teams";
import { listSelectableLocations, selectLocationForOrg } from "@/lib/gbp/access";
import { getConnectionByOrgId } from "@/lib/gbp/oauth";

type SearchParams = {
  error?: string;
};

export default async function SelectLocationPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<JSX.Element> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const org = await getCurrentOrgContext();
  if (!org?.orgId) {
    return (
      <main>
        <h1>Choose your location</h1>
        <p>Authorize → Choose location → Done</p>
        <div className="empty">
          <p className="muted">No organization context found.</p>
        </div>
      </main>
    );
  }

  const connection = await getConnectionByOrgId(org.orgId);

  if (!connection) {
    redirect("/connect");
  }

  const data = await listSelectableLocations(org.orgId, session.user.id);

  async function handleSelect(formData: FormData): Promise<void> {
    "use server";
    const locationName = String(formData.get("locationName") ?? "");
    if (!locationName) return;
    await selectLocationForOrg(org.orgId, session.user.id, locationName);
    redirect("/connect/select-location?success=1");
  }

  const errorCopy =
    searchParams.error === "agency_access_required"
      ? "Google says this profile is agency-managed. Ask the owner to add your Google account as Owner or Manager in Business Profile settings."
      : searchParams.error === "oauth_denied"
      ? "Authorization was denied. Try again."
      : searchParams.error
      ? "Something went wrong while connecting Google."
      : null;

  return (
    <main>
      <h1>Choose your Business Profile location</h1>
      <p>Authorize → Choose location → Done</p>

      {errorCopy ? (
        <section className="empty">
          <h2>We couldn’t finish that step</h2>
          <p className="muted">{errorCopy}</p>
          <p>
            <Link className="btn" href="/connect">
              Try again
            </Link>
          </p>
        </section>
      ) : null}

      {data.locations.length === 0 ? (
        <section className="empty">
          <h2>No locations found</h2>
          <p className="muted">
            If you haven’t claimed your profile yet, start in Google Business Profile and claim your business
            first.
          </p>
          <p>
            <a
              className="btn"
              href="https://www.google.com/business/"
              target="_blank"
              rel="noreferrer"
            >
              Claim your profile
            </a>
          </p>
        </section>
      ) : (
        <form action={handleSelect}>
          <section className="card">
            <h2>Step 2 of 3: Pick one location</h2>
            <p className="muted">
              We only manage one location per subscription. You can change this later.
            </p>

            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Location</th>
                  <th>Category</th>
                  <th>Stars</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.locations.map((loc) => (
                  <tr key={loc.locationName}>
                    <td>
                      <input type="radio" name="locationName" value={loc.locationName} required />
                    </td>
                    <td>{loc.title}</td>
                    <td>{loc.primaryCategory ?? "—"}</td>
                    <td>{loc.starRating?.toFixed(1) ?? "—"}</td>
                    <td>
                      {loc.isSuspended || !loc.isVerified
                        ? "Paused until Google reinstates/verifies"
                        : "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p>
              <button type="submit">Save location</button>
            </p>
          </section>
        </form>
      )}

      {connection.selectedLocationName ? (
        <section className="card">
          <h2>Step 3 of 3: Done</h2>
          <p className="muted">Your location is connected.</p>
          <p>Selected: {connection.selectedLocationTitle ?? connection.selectedLocationName}</p>
        </section>
      ) : null}
    </main>
  );
}
