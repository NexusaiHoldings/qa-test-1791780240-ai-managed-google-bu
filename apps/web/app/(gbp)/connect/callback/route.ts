import { NextRequest, NextResponse } from "next/server";
import { consumeOAuthState, exchangeCodeForToken, fetchAccountsAndLocations, upsertConnectionFromOAuth } from "@/lib/gbp/oauth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/connect?error=missing_code_or_state", request.url));
  }

  const consumed = await consumeOAuthState(state);
  if (!consumed) {
    return NextResponse.redirect(new URL("/connect?error=invalid_state", request.url));
  }

  try {
    const token = await exchangeCodeForToken(code);
    await upsertConnectionFromOAuth({
      orgId: consumed.orgId,
      userId: consumed.userId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      scope: token.scope,
      expiresIn: token.expiresIn,
    });
    await fetchAccountsAndLocations(consumed.orgId);
    return NextResponse.redirect(new URL("/connect/select-location", request.url));
  } catch {
    return NextResponse.redirect(new URL("/connect?error=oauth_failed", request.url));
  }
}
