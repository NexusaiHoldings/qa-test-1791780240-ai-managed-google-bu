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

CREATE TABLE IF NOT EXISTS gbp_keyword_rank_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  location_name TEXT,
  keyword TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  previous_rank INTEGER,
  movement INTEGER NOT NULL DEFAULT 0,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'dataforseo',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gbp_keyword_rank_snapshots_org_date_idx
  ON gbp_keyword_rank_snapshots (org_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS gbp_keyword_rank_snapshots_org_keyword_idx
  ON gbp_keyword_rank_snapshots (org_id, keyword, snapshot_date DESC);
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

/**
 * Review Responder & Sensitivity Gate (F1-006) company tables.
 *
 * Owns the per-location review-reply voice/warm-up settings (`gbp_review_settings`)
 * and the mirrored review + draft + reply ledger (`gbp_reviews`).
 *
 * The raw reviewer comment is NEVER stored — only the PII-redacted text lands in
 * `gbp_reviews.comment_redacted` (the raw string is redacted in memory before the
 * first write or any LLM call). `support_ticket_id` references the
 * support-and-help lego's `support_tickets` table and every publish writes an
 * audit event to the admin-console lego's `admin_audit_log` table — both tables
 * are created by their lego schemas, so only the two tables we OWN are declared
 * here.
 */
export const GBP_REVIEWS_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gbp_review_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID,
  location_name TEXT NOT NULL,
  voice_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  warmup_replies_remaining INTEGER NOT NULL DEFAULT 3,
  auto_publish_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  escalate_after_hours INTEGER NOT NULL DEFAULT 72,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, location_name)
);

CREATE INDEX IF NOT EXISTS gbp_review_settings_org_idx
  ON gbp_review_settings (org_id, is_active);

CREATE TABLE IF NOT EXISTS gbp_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  connection_id UUID,
  location_name TEXT,
  google_review_id TEXT NOT NULL,
  google_review_name TEXT,
  reviewer_display_name TEXT,
  reviewer_is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  star_rating INTEGER NOT NULL DEFAULT 0,
  comment_redacted TEXT,
  comment_redactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  had_comment BOOLEAN NOT NULL DEFAULT FALSE,
  review_create_time TIMESTAMPTZ,
  review_update_time TIMESTAMPTZ,
  sensitivity TEXT NOT NULL DEFAULT 'low',
  sensitivity_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_reply TEXT,
  draft_kind TEXT NOT NULL DEFAULT 'voice_matched',
  used_gateway BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_passed BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_status TEXT NOT NULL DEFAULT 'pending',
  published_reply TEXT,
  published_at TIMESTAMPTZ,
  is_warmup BOOLEAN NOT NULL DEFAULT FALSE,
  queued_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  support_ticket_id UUID,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, google_review_id)
);

CREATE INDEX IF NOT EXISTS gbp_reviews_org_created_idx
  ON gbp_reviews (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gbp_reviews_queue_idx
  ON gbp_reviews (org_id, reply_status, sensitivity, queued_at);

CREATE INDEX IF NOT EXISTS gbp_reviews_escalation_idx
  ON gbp_reviews (reply_status, queued_at)
  WHERE escalated_at IS NULL;

CREATE INDEX IF NOT EXISTS gbp_reviews_location_idx
  ON gbp_reviews (location_name, reply_status);
`;

/**
 * Profile Activity Dashboard & Weekly Digest (F1-008) company table.
 *
 * Owns the weekly-digest delivery ledger (`gbp_digest_deliveries`): one row per
 * org per ISO week recording that the Monday snapshot was pushed (and over which
 * surface — `delivery_surface`, honoring the "no required owner logins" product
 * constraint). The UNIQUE (org_id, week_start) key makes the digest cron
 * idempotent: a re-run in the same week finds the row and skips, so owners never
 * get a double email.
 *
 * The dashboard and digest READ from tables owned by other GBP features
 * (`gbp_connections`, `gbp_posts`, `gbp_reviews`, `gbp_keyword_rank_snapshots`,
 * `gbp_publish_slots`) and from the identity/organizations legos (`users`,
 * `organizations`, `org_members`) — all declared by their own schemas — so this
 * ledger is the only NEW table this feature introduces.
 */
export const GBP_DIGEST_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gbp_digest_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID,
  email TEXT,
  week_start DATE NOT NULL,
  delivery_surface TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'sent',
  post_id UUID,
  post_needs_approval BOOLEAN NOT NULL DEFAULT FALSE,
  reviews_waiting INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, week_start)
);

CREATE INDEX IF NOT EXISTS gbp_digest_deliveries_org_week_idx
  ON gbp_digest_deliveries (org_id, week_start DESC);

CREATE INDEX IF NOT EXISTS gbp_digest_deliveries_week_idx
  ON gbp_digest_deliveries (week_start DESC, status);
`;

