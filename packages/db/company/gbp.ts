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
 * Weekly Post Publisher (F1-005) company tables.
 *
 * Owns the per-location publish slot + voice profile (`gbp_publish_slots`), the
 * owner-photo rotation ledger used for LRU photo selection (`gbp_photos`), and
 * the generated/published post timeline with guard scores (`gbp_posts`).
 *
 * `gbp_photos.file_id` references the files-and-media lego's `files` table and
 * `gbp_posts` audit events are written to the admin-console lego's
 * `admin_audit_log` table — both tables are created by their lego schemas, so
 * only the three tables we OWN are declared here.
 */
export const GBP_POSTS_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gbp_publish_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  location_name TEXT NOT NULL,
  day_of_week INTEGER NOT NULL DEFAULT 4,
  hour INTEGER NOT NULL DEFAULT 10,
  minute INTEGER NOT NULL DEFAULT 14,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  trade TEXT NOT NULL DEFAULT 'multi-trade',
  voice_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  service_area_cities JSONB NOT NULL DEFAULT '[]'::jsonb,
  warmup_posts_remaining INTEGER NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, location_name)
);

CREATE INDEX IF NOT EXISTS gbp_publish_slots_active_idx
  ON gbp_publish_slots (is_active, day_of_week, hour, minute);

CREATE TABLE IF NOT EXISTS gbp_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID,
  file_id UUID,
  storage_key TEXT,
  signed_url TEXT,
  filename TEXT,
  category TEXT NOT NULL DEFAULT 'jobsite',
  service_line TEXT NOT NULL DEFAULT 'multi-trade',
  caption TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_photos_rotation_idx
  ON gbp_photos (org_id, service_line, is_active, last_used_at ASC NULLS FIRST, use_count ASC);

CREATE TABLE IF NOT EXISTS gbp_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID,
  location_name TEXT,
  slot_id UUID,
  template_id UUID,
  photo_id UUID,
  photo_file_id UUID,
  photo_url TEXT,
  service_line TEXT NOT NULL DEFAULT 'multi-trade',
  season TEXT NOT NULL DEFAULT 'shoulder',
  service_city TEXT,
  summary TEXT,
  body TEXT NOT NULL,
  cta_type TEXT,
  cta_url TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  week_start DATE,
  google_post_name TEXT,
  variance_score NUMERIC,
  variance_passed BOOLEAN NOT NULL DEFAULT FALSE,
  variance_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  claims_passed BOOLEAN NOT NULL DEFAULT FALSE,
  claims_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  regenerate_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  is_warmup BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_posts_org_created_idx
  ON gbp_posts (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gbp_posts_location_published_idx
  ON gbp_posts (location_name, published_at DESC);

CREATE INDEX IF NOT EXISTS gbp_posts_status_idx
  ON gbp_posts (status, week_start);
`;
