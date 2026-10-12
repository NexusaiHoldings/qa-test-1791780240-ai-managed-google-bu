import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@nexus/identity-and-access";
import { getCurrentOrgContext } from "@nexus/organizations-and-teams";
import { getOAuthStartUrl, getConnectionByOrgId } from "@/lib/gbp/oauth";

export default async function ConnectGooglePage(): Promise<JSX.Element> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const org = await getCurrentOrgContext();
  if (!org?.orgId) {
    return (
      <main>
        <h1>Connect Google Business Profile</h1>
        <p>We need an organization context before you can connect Google.</p>
        <div className="empty">
          <p className="muted">Open this page from within your organization workspace.</p>
        </div>
      </main>
    );
  }

  const connection = await getConnectionByOrgId(org.orgId);
  if (connection?.selectedLocationName) {
    redirect("/connect/select-location");
  }

  const oauthUrl = await getOAuthStartUrl(org.orgId, session.user.id);

  return (
    <main>
      <h1>Connect Google Business Profile</h1>
      <p>Authorize → Choose location → Done</p>

      <section className="card">
        <h2>Step 1 of 3: Authorize Google</h2>
        <p className="muted">
          We never see your password. Revoke anytime from your Google account.
        </p>
        <p>
          <a className="btn" href={oauthUrl}>
            Connect Google
          </a>
        </p>
      </section>

      <section className="card">
        <h3>What happens next</h3>
        <ol>
          <li>Authorize your Google account with business.manage scope.</li>
          <li>Choose one Business Profile location for this subscription.</li>
          <li>We keep the token refreshed daily so posting/review workflows stay active.</li>
        </ol>
      </section>

      <section className="empty">
        <p className="muted">
          If your location is currently suspended or unverified, we’ll keep it paused and start publishing
          once Google reinstates or verifies it.
        </p>
        <p>
          Need help first? <Link href="/help">Visit support</Link>.
        </p>
      </section>
    </main>
  );
}
