export const GBP_SCHEMA_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gbp_connections (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  google_subject text,
  access_token text,
  access_token_expires_at timestamptz,
  refresh_token_ciphertext text NOT NULL,
  refresh_token_iv text NOT NULL,
  refresh_token_tag text NOT NULL,
  scopes text,
  is_connected boolean NOT NULL DEFAULT false,
  selected_location_name text,
  selected_location_title text,
  selected_primary_category text,
  selected_star_rating numeric,
  verification_state text,
  publishing_paused boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gbp_oauth_states (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gbp_api_calls (
  id uuid PRIMARY KEY,
  org_id uuid,
  endpoint text NOT NULL,
  http_method text NOT NULL,
  status_code integer NOT NULL,
  error_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gbp_location_cache (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
