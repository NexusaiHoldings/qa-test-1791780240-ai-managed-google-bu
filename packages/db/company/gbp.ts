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

CREATE TABLE IF NOT EXISTS gbp_post_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  trade TEXT NOT NULL,
  season TEXT NOT NULL,
  body_template TEXT NOT NULL,
  required_service_term BOOLEAN NOT NULL DEFAULT TRUE,
  required_service_city BOOLEAN NOT NULL DEFAULT TRUE,
  required_photo_category BOOLEAN NOT NULL DEFAULT TRUE,
  required_cta_type BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_post_templates_trade_season_idx
  ON gbp_post_templates (trade, season, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS gbp_keyword_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade TEXT NOT NULL,
  season TEXT NOT NULL,
  contractor_term TEXT NOT NULL,
  customer_term TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trade, season, contractor_term, customer_term)
);

CREATE INDEX IF NOT EXISTS gbp_keyword_seeds_trade_season_idx
  ON gbp_keyword_seeds (trade, season, is_active, updated_at DESC);
`;

/**
 * Voice Profile Builder (F1-004) — the sub-15-minute onboarding questionnaire.
 *
 * One profile per org (UNIQUE org_id). Progress is saved per step via
 * current_step so an owner can finish on a phone in the truck across sessions.
 * Tone sliders are stored as 0–100 integers (0 = formal/brief, 100 =
 * casual/chatty). credential_claims_opt_in defaults FALSE because the liability
 * assessor requires human review of any post claiming specific licensing
 * credentials. The warm-up policy auto_publish_posts / auto_publish_replies both
 * default FALSE and flip on only after the owner's first approvals.
 *
 * No CHECK constraints are placed on the free-form text / text[] columns
 * (sign_off_name, phrases_to_use, phrases_to_avoid, service_lines) per the
 * company SQL constraints.
 */
export const GBP_VOICE_PROFILE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS gbp_voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID,
  trades TEXT[] NOT NULL DEFAULT '{}',
  service_lines TEXT[] NOT NULL DEFAULT '{}',
  customer_terms TEXT[] NOT NULL DEFAULT '{}',
  service_area_cities JSONB NOT NULL DEFAULT '[]'::jsonb,
  tone_formal_casual INTEGER NOT NULL DEFAULT 50,
  tone_brief_chatty INTEGER NOT NULL DEFAULT 50,
  sign_off_name TEXT,
  phrases_to_use TEXT[] NOT NULL DEFAULT '{}',
  phrases_to_avoid TEXT[] NOT NULL DEFAULT '{}',
  credential_claims_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  auto_publish_posts BOOLEAN NOT NULL DEFAULT FALSE,
  auto_publish_replies BOOLEAN NOT NULL DEFAULT FALSE,
  sample_reply_count INTEGER NOT NULL DEFAULT 0,
  current_step INTEGER NOT NULL DEFAULT 1,
  first_draft_post TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id)
);

CREATE INDEX IF NOT EXISTS gbp_voice_profiles_org_idx
  ON gbp_voice_profiles (org_id);

CREATE TABLE IF NOT EXISTS gbp_voice_sample_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  profile_id UUID,
  review_id TEXT NOT NULL,
  reviewer_display_name TEXT,
  review_comment TEXT,
  star_rating TEXT,
  reply_comment TEXT NOT NULL,
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, review_id)
);

CREATE INDEX IF NOT EXISTS gbp_voice_sample_replies_org_idx
  ON gbp_voice_sample_replies (org_id, replied_at DESC);
`;
