/**
 * AUTO-RECOVERED table DDL (table-ref-autorecover-001).
 *
 * The integration table-ref gate found these tables queried by apps/web
 * with no creating DDL. Columns are inferred from the SQL the build agents
 * wrote (best-effort, loosely typed) so migrate.ts creates them at deploy
 * and the runtime queries don't 500. Reviewable + replaceable: if a feature
 * later adds a richer hand-written DDL for one of these tables, delete its
 * block here (CREATE TABLE IF NOT EXISTS would otherwise no-op the richer one).
 */

export const RECOVERED_GBP_HEALTH_INCIDENTS_DDL = `
CREATE TABLE IF NOT EXISTS gbp_health_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "gen_random_uuid" text,
  "incident_type" text,
  "location_id" uuid,
  "metadata" jsonb,
  "org_id" uuid,
  "severity" text,
  "status" text,
  "summary" text,
  "title" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_GBP_KEYWORDS_DDL = `
CREATE TABLE IF NOT EXISTS gbp_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,
  "is_active" boolean,
  "keyword" text,
  "location_id" uuid,
  "org_id" uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_GBP_LOCATIONS_DDL = `
CREATE TABLE IF NOT EXISTS gbp_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,
  "location_id" uuid,
  "org_id" uuid,
  "publishing_status" text,
  "service_area_centroid_lat" text,
  "service_area_centroid_lng" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_GBP_RANK_SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS gbp_rank_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,
  "captured_at" timestamptz,
  "centroid_lat" text,
  "centroid_lng" text,
  "keyword" text,
  "location_id" uuid,
  "org_id" uuid,
  "provider_name" text,
  "provider_query_id" uuid,
  "rank_position" text,
  "run_id" uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_NOTIFICATIONS_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS notifications_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel" text,
  "gen_random_uuid" text,
  "org_id" uuid,
  "payload" jsonb,
  "recipient_ref" text,
  "status" text,
  "template_key" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
