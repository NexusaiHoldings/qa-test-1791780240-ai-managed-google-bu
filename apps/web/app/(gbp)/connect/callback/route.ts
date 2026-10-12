import { NextRequest, NextResponse } from "next/server";
import { completeOAuthCallback } from "@/lib/gbp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await completeOAuthCallback(request);
  if (!result.ok) {
    const url = new URL("/connect/select-location", request.url);
    url.searchParams.set("error", result.errorCode ?? "oauth_failed");
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL("/connect/select-location", request.url));
}
