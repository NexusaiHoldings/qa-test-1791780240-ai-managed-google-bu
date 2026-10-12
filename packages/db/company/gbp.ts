export const GBP_SCHEMA_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gbp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  google_subject TEXT NOT NULL,
  google_email TEXT,
  access_token TEXT,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  token_scope TEXT,
  token_expires_at TIMESTAMPTZ,
  selected_account_name TEXT,
  selected_location_name TEXT,
  selected_location_store_code TEXT,
  selected_location_title TEXT,
  selected_location_address JSONB,
  selected_location_metadata JSONB,
  primary_category_display_name TEXT,
  verification_state TEXT,
  connection_state TEXT NOT NULL DEFAULT 'pending',
  paused_reason TEXT,
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id)
);

CREATE INDEX IF NOT EXISTS gbp_connections_org_idx
  ON gbp_connections (org_id);

CREATE TABLE IF NOT EXISTS gbp_api_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  connection_id UUID,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_body JSONB,
  response_status INTEGER,
  response_body JSONB,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_api_calls_org_created_idx
  ON gbp_api_calls (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gbp_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  redirect_to TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_oauth_states_state_idx
  ON gbp_oauth_states (state);

CREATE TABLE IF NOT EXISTS gbp_locations_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  account_name TEXT NOT NULL,
  location_name TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata JSONB NOT NULL,
  primary_category_display_name TEXT,
  verification_state TEXT,
  average_rating NUMERIC,
  user_role TEXT,
  is_selectable BOOLEAN NOT NULL DEFAULT TRUE,
  selectable_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, location_name)
);

CREATE INDEX IF NOT EXISTS gbp_locations_cache_org_idx
  ON gbp_locations_cache (org_id, updated_at DESC);
`;
