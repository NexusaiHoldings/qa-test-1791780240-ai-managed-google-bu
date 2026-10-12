import { randomBytes, createHash } from "crypto";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { sql } from "@/lib/gbp/google-client";
import { encryptRefreshToken } from "@/lib/gbp/token-vault";
import { exchangeCodeForTokens } from "@/lib/gbp/google-client";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function getOAuthStartUrl(orgId: string, userId: string): Promise<string> {
  const state = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  await sql(
    `insert into gbp_oauth_states (id, org_id, user_id, state, code_verifier, expires_at)
     values (gen_random_uuid(), $1, $2, $3, $4, now() + interval '15 minutes')`,
    [orgId, userId, state, codeVerifier]
  );

  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const redirectUri = `${proto}://${host}/connect/callback`;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/business.manage",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function getConnectionByOrgId(orgId: string): Promise<{
  selectedLocationName: string | null;
  selectedLocationTitle: string | null;
} | null> {
  const rows = await sql(
    `select selected_location_name as "selectedLocationName", selected_location_title as "selectedLocationTitle"
     from gbp_connections
     where org_id = $1
     limit 1`,
    [orgId]
  );
  return rows[0] ?? null;
}

export async function completeOAuthCallback(
  request: NextRequest
): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return { ok: false, errorCode: "oauth_denied" };
  if (!state || !code) return { ok: false, errorCode: "oauth_missing_params" };

  const stateRows = await sql(
    `select id, org_id as "orgId", user_id as "userId", code_verifier as "codeVerifier"
     from gbp_oauth_states
     where state = $1 and consumed_at is null and expires_at > now()
     limit 1`,
    [state]
  );
  const found = stateRows[0];
  if (!found) return { ok: false, errorCode: "oauth_state_invalid" };

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const redirectUri = `${proto}://${host}/connect/callback`;

  const tokenSet = await exchangeCodeForTokens(code, found.codeVerifier, redirectUri);
  if (!tokenSet.refresh_token) {
    return { ok: false, errorCode: "oauth_no_refresh_token" };
  }

  const encrypted = encryptRefreshToken(tokenSet.refresh_token);

  await sql(
    `insert into gbp_connections (
      id, org_id, user_id, google_subject, access_token, access_token_expires_at,
      refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, scopes, is_connected, created_at, updated_at
    ) values (
      gen_random_uuid(), $1, $2, $3, $4, now() + (($5 || ' seconds')::interval),
      $6, $7, $8, $9, true, now(), now()
    )
    on conflict (org_id)
    do update set
      user_id = excluded.user_id,
      google_subject = excluded.google_subject,
      access_token = excluded.access_token,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      refresh_token_iv = excluded.refresh_token_iv,
      refresh_token_tag = excluded.refresh_token_tag,
      scopes = excluded.scopes,
      is_connected = true,
      updated_at = now()`,
    [
      found.orgId,
      found.userId,
      tokenSet.id_token ?? null,
      tokenSet.access_token,
      String(tokenSet.expires_in ?? 3600),
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      tokenSet.scope ?? "https://www.googleapis.com/auth/business.manage",
    ]
  );

  await sql(`update gbp_oauth_states set consumed_at = now() where id = $1`, [found.id]);
  return { ok: true };
}
