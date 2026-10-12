import crypto from "crypto";
import { Pool } from "pg";
import { decryptRefreshToken, encryptRefreshToken } from "./token-vault";
import { googleApiCallRaw } from "./google-client";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";

export function getGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GBP_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth environment not configured");
  }
  return { clientId, clientSecret, redirectUri };
}

export async function createOAuthState(orgId: string, userId: string): Promise<{ state: string; codeVerifier: string }> {
  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.query(
    `INSERT INTO gbp_oauth_states (org_id, user_id, state, code_verifier, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, userId, state, codeVerifier, expiresAt.toISOString()],
  );
  return { state, codeVerifier };
}

export function buildGoogleAuthUrl(state: string): string {
  const { clientId, redirectUri } = getGoogleOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function consumeOAuthState(state: string): Promise<{ orgId: string; userId: string } | null> {
  const res = await db.query(
    `UPDATE gbp_oauth_states
     SET consumed_at = NOW()
     WHERE state = $1
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING org_id, user_id`,
    [state],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as { org_id: string; user_id: string };
  return { orgId: row.org_id, userId: row.user_id };
}

export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  idToken?: string;
}> {
  const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token || !data.refresh_token || !data.expires_in || !data.scope) {
    throw new Error(data.error ?? "oauth_token_exchange_failed");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token,
  };
}

export async function upsertConnectionFromOAuth(params: {
  orgId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
}): Promise<void> {
  const encrypted = encryptRefreshToken(params.refreshToken);
  const expiresAt = new Date(Date.now() + params.expiresIn * 1000);

  await db.query(
    `INSERT INTO gbp_connections
      (org_id, user_id, google_subject, access_token, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, token_scope, token_expires_at, connection_state, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW())
     ON CONFLICT (org_id) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         access_token = EXCLUDED.access_token,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         refresh_token_iv = EXCLUDED.refresh_token_iv,
         refresh_token_tag = EXCLUDED.refresh_token_tag,
         token_scope = EXCLUDED.token_scope,
         token_expires_at = EXCLUDED.token_expires_at,
         connection_state = 'pending',
         updated_at = NOW()`,
    [
      params.orgId,
      params.userId,
      params.userId,
      params.accessToken,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      params.scope,
      expiresAt.toISOString(),
    ],
  );
}

export async function refreshConnectionToken(connectionId: string): Promise<{ accessToken: string; expiresIn: number }> {
  const rowRes = await db.query(
    `SELECT id, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, org_id
     FROM gbp_connections
     WHERE id = $1
     LIMIT 1`,
    [connectionId],
  );
  if (rowRes.rowCount === 0) {
    throw new Error("connection_not_found");
  }
  const row = rowRes.rows[0] as {
    id: string;
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    refresh_token_tag: string;
    org_id: string;
  };
  const refreshToken = decryptRefreshToken({
    ciphertext: row.refresh_token_ciphertext,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  });

  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token || !data.expires_in) {
    throw new Error(data.error ?? "refresh_failed");
  }
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await db.query(
    `UPDATE gbp_connections
     SET access_token = $2, token_expires_at = $3, last_refreshed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [connectionId, data.access_token, expiresAt.toISOString()],
  );
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function fetchAccountsAndLocations(orgId: string): Promise<void> {
  const connRes = await db.query(
    `SELECT id, access_token FROM gbp_connections WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (connRes.rowCount === 0) throw new Error("connection_missing");
  const conn = connRes.rows[0] as { id: string; access_token: string | null };
  if (!conn.access_token) throw new Error("access_token_missing");

  const accounts = await googleApiCallRaw<{ accounts?: Array<{ name: string }> }>({
    orgId,
    connectionId: conn.id,
    method: "GET",
    baseUrl: "https://mybusinessaccountmanagement.googleapis.com/v1",
    endpoint: "accounts",
    accessToken: conn.access_token,
  });

  await db.query(`DELETE FROM gbp_locations_cache WHERE org_id = $1`, [orgId]);

  for (const account of accounts.accounts ?? []) {
    const locations = await googleApiCallRaw<{
      locations?: Array<{
        name: string;
        title?: string;
        storefrontAddress?: unknown;
        metadata?: { mapsUri?: string };
        profile?: { description?: string };
        primaryCategory?: { displayName?: string };
      }>;
    }>({
      orgId,
      connectionId: conn.id,
      method: "GET",
      baseUrl: "https://mybusinessbusinessinformation.googleapis.com/v1",
      endpoint: `${account.name}/locations`,
      accessToken: conn.access_token,
    });

    for (const loc of locations.locations ?? []) {
      await db.query(
        `INSERT INTO gbp_locations_cache
         (org_id, account_name, location_name, title, metadata, primary_category_display_name, verification_state, average_rating, user_role, is_selectable, selectable_reason, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (org_id, location_name) DO UPDATE
         SET title = EXCLUDED.title,
             metadata = EXCLUDED.metadata,
             primary_category_display_name = EXCLUDED.primary_category_display_name,
             verification_state = EXCLUDED.verification_state,
             average_rating = EXCLUDED.average_rating,
             user_role = EXCLUDED.user_role,
             is_selectable = EXCLUDED.is_selectable,
             selectable_reason = EXCLUDED.selectable_reason,
             updated_at = NOW()`,
        [
          orgId,
          account.name,
          loc.name,
          loc.title ?? loc.name,
          JSON.stringify(loc),
          loc.primaryCategory?.displayName ?? null,
          "VERIFIED",
          null,
          "OWNER",
          true,
          null,
        ],
      );
    }
  }
}
