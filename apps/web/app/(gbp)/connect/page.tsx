import type { JSX } from "react";
import { redirect } from "next/navigation";
import { buildGoogleAuthUrl, createOAuthState } from "@/lib/gbp/oauth";
import { getGbpConnectionStatus, resolveGbpContext } from "@/lib/gbp/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Human-readable copy for the error codes the callback route redirects with.
const ERROR_COPY: Record<string, string> = {
  missing_code_or_state: "Google didn’t return an authorization code. Please try again.",
  invalid_state: "That authorization link expired. Please start again.",
  oauth_failed: "We couldn’t complete the Google authorization. Please try again.",
};

async function startOAuth(): Promise<void> {
  "use server";
  const ctx = await resolveGbpContext();
  if (!ctx) {
    redirect("/login");
  }
  const { state } = await createOAuthState(ctx.orgId, ctx.userId);
  redirect(buildGoogleAuthUrl(state));
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    return (
      <main>
        <h1>Connect Google</h1>
        <p className="muted">
          Please <a href="/login">log in</a> to connect your Google Business
          Profile.
        </p>
      </main>
    );
  }

  // Already connected (active or paused) → skip straight to the picker so the
  // owner can review or change the managed location.
  const status = await getGbpConnectionStatus(ctx.orgId);
  if (status.connected) {
    redirect("/connect/select-location");
  }

  const errorCode = searchParams?.error;
  const errorMessage = errorCode
    ? ERROR_COPY[errorCode] ?? "Something went wrong. Please try again."
    : null;

  return (
    <main>
      <h1>Connect Google</h1>
      <p className="muted">
        We never see your password. Revoke anytime from your Google account.
      </p>

      <ol className="toolbar" aria-label="Connection progress">
        <li>
          <strong>1. Authorize</strong>
        </li>
        <li className="muted">2. Choose location</li>
        <li className="muted">3. Done</li>
      </ol>

      {errorMessage ? (
        <div className="card empty" role="alert">
          <p aria-hidden="true" style={{ fontSize: "2.5rem" }}>
            ⚠️
          </p>
          <p>{errorMessage}</p>
          <form action={startOAuth}>
            <button type="submit">Try again</button>
          </form>
        </div>
      ) : (
        <div className="card">
          <h2>One-click Google authorization</h2>
          <p>
            Authorize read &amp; write access to a single Business Profile
            location. We request only the{" "}
            <code>business.manage</code> scope — nothing else.
          </p>
          <form action={startOAuth}>
            <button type="submit">Continue with Google</button>
          </form>
          <p className="muted">
            You’ll pick which location this subscription manages in the next
            step. We never see your password, and you can revoke access anytime
            from your Google account.
          </p>
        </div>
      )}
    </main>
  );
}
