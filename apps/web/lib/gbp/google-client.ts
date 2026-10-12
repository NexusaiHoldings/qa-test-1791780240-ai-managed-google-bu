import { Pool } from "pg";
import { decryptRefreshToken } from "@/lib/gbp/token-vault";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

async function logApi(orgId: string | null, endpoint: string, method: string, status: number, errorBody?: string): Promise<void> {
  await sql(
    `insert into gbp_api_calls (id, org_id, endpoint, http_method, status_code, error_body, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
    [orgId, endpoint, method, status, errorBody ?? null]
  );
}

async function getOrgAccessToken(orgId: string): Promise<string> {
  const rows = await sql<{
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    refresh_token_tag: string;
    access_token: string | null;
    access_token_expires_at: string | null;
  }>(
    `select refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, access_token, access_token_expires_at
     from gbp_connections where org_id = $1 limit 1`,
    [orgId]
  );
  const row = rows[0];
  if (!row) throw new Error("No GBP connection");

  if (row.access_token && row.access_token_expires_at && new Date(row.access_token_expires_at).getTime() > Date.now() + 60_000) {
    return row.access_token;
  }

  const refresh = decryptRefreshToken({
    ciphertext: row.refresh_token_ciphertext,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  });

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: refresh,
  });

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await tokenResp.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!tokenResp.ok || !json.access_token) {
    await logApi(orgId, "/token", "POST", tokenResp.status, JSON.stringify(json));
    throw new Error(`Google token refresh failed: ${json.error ?? tokenResp.status}`);
  }

  await sql(
    `update gbp_connections
     set access_token = $1,
         access_token_expires_at = now() + (($2 || ' seconds')::interval),
         updated_at = now()
     where org_id = $3`,
    [json.access_token, String(json.expires_in ?? 3600), orgId]
  );

  await logApi(orgId, "/token", "POST", tokenResp.status);
  return json.access_token;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
  };

  if (!resp.ok || !json.access_token) {
    throw new Error(`OAuth exchange failed: ${json.error ?? resp.status}`);
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    scope: json.scope,
    id_token: json.id_token,
  };
}

export async function googleGet(orgId: string, endpoint: string): Promise<unknown> {
  const token = await getOrgAccessToken(orgId);
  const resp = await fetch(`https://mybusinessbusinessinformation.googleapis.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  await logApi(orgId, endpoint, "GET", resp.status, resp.ok ? undefined : text);
  if (!resp.ok) throw new Error(`Google API failed ${resp.status}`);
  return JSON.parse(text);
}
