import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/gbp/google-client";
import { decryptRefreshToken } from "@/lib/gbp/token-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const rows = await sql<{
    org_id: string;
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    refresh_token_tag: string;
  }>(
    `select org_id, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag
     from gbp_connections
     where is_connected = true`
  );

  let refreshed = 0;
  for (const row of rows) {
    const jitter = Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, jitter));

    const refreshToken = decryptRefreshToken({
      ciphertext: row.refresh_token_ciphertext,
      iv: row.refresh_token_iv,
      tag: row.refresh_token_tag,
    });

    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };

    await sql(
      `insert into gbp_api_calls (id, org_id, endpoint, http_method, status_code, error_body, created_at)
       values (gen_random_uuid(), $1, '/token', 'POST', $2, $3, now())`,
      [row.org_id, resp.status, resp.ok ? null : JSON.stringify(json)]
    );

    if (resp.ok && json.access_token) {
      await sql(
        `update gbp_connections
         set access_token = $1,
             access_token_expires_at = now() + (($2 || ' seconds')::interval),
             updated_at = now()
         where org_id = $3`,
        [json.access_token, String(json.expires_in ?? 3600), row.org_id]
      );
      refreshed += 1;
    }
  }

  return NextResponse.json({ ok: true, refreshed });
}
