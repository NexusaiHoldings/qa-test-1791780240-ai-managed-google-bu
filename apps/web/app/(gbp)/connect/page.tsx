import { redirect } from "next/navigation";
import { Pool } from "pg";
import { buildGoogleAuthUrl, createOAuthState } from "@/lib/gbp/oauth";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function getContext(): Promise<{ orgId: string; userId: string }> {
  const orgId = process.env.DEMO_ORG_ID;
  const userId = process.env.DEMO_USER_ID;
  if (!orgId || !userId) throw new Error("Missing DEMO_ORG_ID/DEMO_USER_ID for connect flow");
  return { orgId, userId };
}

async function startOAuth(): Promise<void> {
  "use server";
  const { orgId, userId } = await getContext();
  const { state } = await createOAuthState(orgId, userId);
  const url = buildGoogleAuthUrl(state);
  redirect(url);
}

export default async function ConnectPage(): Promise<JSX.Element> {
  const { orgId } = await getContext();
  const existing = await db.query(
    `SELECT connection_state FROM gbp_connections WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (existing.rowCount > 0 && (existing.rows[0] as { connection_state: string }).connection_state !== "pending") {
    redirect("/connect/select-location");
  }

  return (
    <main>
      <h1>Connect Google</h1>
      <p className="muted">We never see your password. Revoke anytime from your Google account.</p>

      <div className="card">
        <ol>
          <li><strong>Authorize</strong></li>
          <li>Choose location</li>
          <li>Done</li>
        </ol>
        <form action={startOAuth}>
          <button type="submit">Continue with Google</button>
        </form>
      </div>
    </main>
  );
}
