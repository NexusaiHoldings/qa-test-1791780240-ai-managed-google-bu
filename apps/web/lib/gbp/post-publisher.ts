/**
 * Weekly post lifecycle + publishing (F1-005).
 *
 * Owns everything stateful around a post: template selection, reading the
 * location/platform history the variance guard needs, persisting the generated
 * draft into `gbp_posts`, publishing to the Google Business Profile `localPosts`
 * endpoint, writing an audit event to the admin-console `admin_audit_log`, and
 * the owner actions (approve / regenerate / skip). The pure generation + guard
 * logic lives in post-generator.ts.
 *
 * DB access uses the substrate's lazy `require("pg")` pool so preview builds
 * without DATABASE_URL still compile; all queries are parameterized.
 */

import { googleApiCallRaw } from "@/lib/gbp/google-client";
import { refreshConnectionToken } from "@/lib/gbp/oauth";
import {
  generateCompliantPost,
  seasonForMonth,
  type GbpSeason,
  type GenerateResult,
} from "@/lib/gbp/post-generator";
import type { VoiceProfile } from "@/lib/gbp/prompts/post";
import type { VarianceContextPost } from "@/lib/gbp/variance-guard";
import type { ClaimsPolicy } from "@/lib/gbp/claims-guard";
import {
  recordPhotoUsage,
  selectPhotoForServiceLine,
  type GbpPhoto,
} from "@/lib/gbp/photo-rotation";

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PoolLike;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export type GbpPostStatus =
  | "scheduled"
  | "published"
  | "needs_approval"
  | "failed"
  | "skipped";

export interface GbpPostRecord {
  id: string;
  orgId: string;
  connectionId: string | null;
  locationName: string | null;
  slotId: string | null;
  templateId: string | null;
  photoId: string | null;
  photoUrl: string | null;
  serviceLine: string;
  season: string;
  serviceCity: string | null;
  summary: string | null;
  body: string;
  ctaType: string | null;
  ctaUrl: string | null;
  status: GbpPostStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  weekStart: string | null;
  googlePostName: string | null;
  varianceScore: number | null;
  variancePassed: boolean;
  varianceDetail: unknown;
  claimsPassed: boolean;
  claimsDetail: unknown;
  regenerateCount: number;
  failureReason: string | null;
  isWarmup: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GbpSlotRecord {
  id: string;
  orgId: string;
  connectionId: string;
  locationName: string;
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
  trade: string;
  voice: VoiceProfile;
  serviceAreaCities: string[];
  warmupPostsRemaining: number;
  isActive: boolean;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

const POST_COLUMNS = `
  id, org_id, connection_id, location_name, slot_id, template_id, photo_id,
  photo_url, service_line, season, service_city, summary, body, cta_type, cta_url,
  status, scheduled_for, published_at, week_start, google_post_name,
  variance_score, variance_passed, variance_detail, claims_passed, claims_detail,
  regenerate_count, failure_reason, is_warmup, approved_by, approved_at,
  created_at, updated_at
`;

function mapPost(row: Record<string, unknown>): GbpPostRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    locationName: row.location_name == null ? null : String(row.location_name),
    slotId: row.slot_id == null ? null : String(row.slot_id),
    templateId: row.template_id == null ? null : String(row.template_id),
    photoId: row.photo_id == null ? null : String(row.photo_id),
    photoUrl: row.photo_url == null ? null : String(row.photo_url),
    serviceLine: String(row.service_line ?? "multi-trade"),
    season: String(row.season ?? "shoulder"),
    serviceCity: row.service_city == null ? null : String(row.service_city),
    summary: row.summary == null ? null : String(row.summary),
    body: String(row.body ?? ""),
    ctaType: row.cta_type == null ? null : String(row.cta_type),
    ctaUrl: row.cta_url == null ? null : String(row.cta_url),
    status: String(row.status ?? "scheduled") as GbpPostStatus,
    scheduledFor: toIso(row.scheduled_for),
    publishedAt: toIso(row.published_at),
    weekStart: toIso(row.week_start),
    googlePostName: row.google_post_name == null ? null : String(row.google_post_name),
    varianceScore: row.variance_score == null ? null : Number(row.variance_score),
    variancePassed: Boolean(row.variance_passed),
    varianceDetail: asJson(row.variance_detail, {}),
    claimsPassed: Boolean(row.claims_passed),
    claimsDetail: asJson(row.claims_detail, {}),
    regenerateCount: Number(row.regenerate_count ?? 0),
    failureReason: row.failure_reason == null ? null : String(row.failure_reason),
    isWarmup: Boolean(row.is_warmup),
    approvedBy: row.approved_by == null ? null : String(row.approved_by),
    approvedAt: toIso(row.approved_at),
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function mapSlot(row: Record<string, unknown>): GbpSlotRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: String(row.connection_id),
    locationName: String(row.location_name),
    dayOfWeek: Number(row.day_of_week ?? 4),
    hour: Number(row.hour ?? 10),
    minute: Number(row.minute ?? 14),
    timezone: String(row.timezone ?? "America/New_York"),
    trade: String(row.trade ?? "multi-trade"),
    voice: asJson<VoiceProfile>(row.voice_profile, {}),
    serviceAreaCities: asJson<string[]>(row.service_area_cities, []),
    warmupPostsRemaining: Number(row.warmup_posts_remaining ?? 0),
    isActive: Boolean(row.is_active),
  };
}

const SLOT_COLUMNS = `
  id, org_id, connection_id, location_name, day_of_week, hour, minute, timezone,
  trade, voice_profile, service_area_cities, warmup_posts_remaining, is_active
`;

// ── Reads ────────────────────────────────────────────────────────────────────

/** All posts for an org, newest first — the /posts timeline. */
export async function listPosts(orgId: string, limit = 60): Promise<GbpPostRecord[]> {
  const rows = await query(
    `SELECT ${POST_COLUMNS} FROM gbp_posts WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map(mapPost);
}

export async function getPost(id: string): Promise<GbpPostRecord | null> {
  const rows = await query(`SELECT ${POST_COLUMNS} FROM gbp_posts WHERE id = $1 LIMIT 1`, [id]);
  return rows.length > 0 ? mapPost(rows[0]) : null;
}

/** Last N posts for a location, newest first — the local variance corpus. */
export async function getLocationHistory(
  locationName: string,
  limit = 12,
): Promise<VarianceContextPost[]> {
  if (!locationName) return [];
  const rows = await query(
    `SELECT body, cta_type FROM gbp_posts
      WHERE location_name = $1 AND status IN ('published','needs_approval','scheduled')
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT $2`,
    [locationName, limit],
  );
  return rows.map((r) => ({ body: String(r.body ?? ""), ctaType: r.cta_type == null ? null : String(r.cta_type) }));
}

/** Every post generated across the platform in the last 7 days — the week corpus. */
export async function getPlatformWeekPosts(excludeLocationName?: string): Promise<VarianceContextPost[]> {
  const rows = await query(
    `SELECT body, cta_type FROM gbp_posts
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND ($1::text IS NULL OR location_name IS DISTINCT FROM $1)
      ORDER BY created_at DESC
      LIMIT 500`,
    [excludeLocationName ?? null],
  );
  return rows.map((r) => ({ body: String(r.body ?? ""), ctaType: r.cta_type == null ? null : String(r.cta_type) }));
}

/** Active publish slots due for the weekly run. */
export async function listActiveSlots(): Promise<GbpSlotRecord[]> {
  const rows = await query(
    `SELECT ${SLOT_COLUMNS} FROM gbp_publish_slots WHERE is_active = TRUE ORDER BY created_at ASC`,
  );
  return rows.map(mapSlot);
}

export async function getSlotForOrg(orgId: string): Promise<GbpSlotRecord | null> {
  const rows = await query(
    `SELECT ${SLOT_COLUMNS} FROM gbp_publish_slots WHERE org_id = $1 AND is_active = TRUE ORDER BY created_at ASC LIMIT 1`,
    [orgId],
  );
  return rows.length > 0 ? mapSlot(rows[0]) : null;
}

export interface TemplatePick {
  id: string;
  name: string;
  trade: string;
  season: string;
  bodyTemplate: string;
}

/**
 * Select an active template for the trade+season, preferring the least-recently
 * -used one for this location so templates rotate too. Falls back to any active
 * template for the trade, then any active template at all.
 */
export async function pickTemplate(
  trade: string,
  season: string,
  locationName: string | null,
): Promise<TemplatePick | null> {
  const rows = await query(
    `SELECT t.id, t.name, t.trade, t.season, t.body_template,
            (SELECT MAX(p.created_at) FROM gbp_posts p
              WHERE p.template_id = t.id AND p.location_name = $3) AS last_used
       FROM gbp_post_templates t
      WHERE t.is_active = TRUE
        AND (t.trade = $1 OR t.trade = 'multi-trade')
        AND (t.season = $2 OR $2 = 'any')
      ORDER BY (t.trade = $1) DESC, (t.season = $2) DESC, last_used ASC NULLS FIRST, t.updated_at DESC
      LIMIT 1`,
    [trade, season, locationName],
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      id: String(r.id),
      name: String(r.name),
      trade: String(r.trade),
      season: String(r.season),
      bodyTemplate: String(r.body_template),
    };
  }
  const any = await query(
    `SELECT id, name, trade, season, body_template FROM gbp_post_templates
      WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
  );
  if (any.length === 0) return null;
  const r = any[0];
  return {
    id: String(r.id),
    name: String(r.name),
    trade: String(r.trade),
    season: String(r.season),
    bodyTemplate: String(r.body_template),
  };
}

// ── Audit (admin-console) ─────────────────────────────────────────────────────

const AUDIT_SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

/**
 * Write an audit event through the admin-console audit trail. Best-effort: an
 * audit failure must never abort a publish, so errors are swallowed after a
 * structured log line.
 */
export async function writeAuditEvent(
  action: string,
  targetId: string,
  payload: Record<string, unknown>,
  adminUserId?: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
      [adminUserId || AUDIT_SYSTEM_USER, action, "gbp_post", targetId, JSON.stringify(payload)],
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_audit_write_failed",
        action,
        targetId,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

export interface CreatePostInput {
  orgId: string;
  connectionId: string | null;
  locationName: string | null;
  slotId: string | null;
  templateId: string | null;
  photo: GbpPhoto | null;
  serviceLine: string;
  season: string;
  serviceCity: string;
  generation: GenerateResult;
  ctaUrl: string | null;
  status: GbpPostStatus;
  scheduledFor: string | null;
  weekStart: string;
  isWarmup: boolean;
  failureReason: string | null;
}

/** Persist a generated draft into gbp_posts and return the stored record. */
export async function createPostRecord(input: CreatePostInput): Promise<GbpPostRecord> {
  const gen = input.generation;
  const rows = await query(
    `INSERT INTO gbp_posts (
        org_id, connection_id, location_name, slot_id, template_id, photo_id,
        photo_file_id, photo_url, service_line, season, service_city, summary, body,
        cta_type, cta_url, status, scheduled_for, week_start, variance_score,
        variance_passed, variance_detail, claims_passed, claims_detail,
        regenerate_count, failure_reason, is_warmup
     ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19,
        $20, $21::jsonb, $22, $23::jsonb,
        $24, $25, $26
     )
     RETURNING ${POST_COLUMNS}`,
    [
      input.orgId,
      input.connectionId,
      input.locationName,
      input.slotId,
      input.templateId,
      input.photo?.id ?? null,
      input.photo?.fileId ?? null,
      input.photo?.signedUrl ?? null,
      input.serviceLine,
      input.season,
      input.serviceCity,
      gen.body.slice(0, 160),
      gen.body,
      gen.ctaType,
      input.ctaUrl,
      input.status,
      input.scheduledFor,
      input.weekStart,
      gen.variance.score,
      gen.variance.passed,
      JSON.stringify(gen.variance),
      gen.claims.passed,
      JSON.stringify(gen.claims),
      gen.regenerateCount,
      input.failureReason,
      input.isWarmup,
    ],
  );
  return mapPost(rows[0]);
}

const CTA_ACTION_TYPES: Record<string, string> = {
  "call-now": "CALL",
  "book-online": "BOOK",
  "request-quote": "SIGN_UP",
  "learn-more": "LEARN_MORE",
};

/** Build the Google `accounts/.../locations/...` resource path for a connection. */
function buildLocationResource(accountName: string | null, locationName: string): string {
  if (locationName.startsWith("accounts/")) return locationName;
  if (accountName) return `${accountName.replace(/\/$/, "")}/${locationName.replace(/^\//, "")}`;
  return locationName;
}

/**
 * Publish a stored post to the GBP localPosts endpoint, mark it published and
 * write the audit event. On any failure the post is flagged `failed` with the
 * reason and the error is re-thrown so the caller can count failures.
 */
export async function publishPost(postId: string, adminUserId?: string | null): Promise<GbpPostRecord> {
  const post = await getPost(postId);
  if (!post) throw new Error("post_not_found");
  if (!post.connectionId) throw new Error("post_has_no_connection");

  const connRows = await query(
    `SELECT id, org_id, selected_account_name, selected_location_name
       FROM gbp_connections WHERE id = $1 LIMIT 1`,
    [post.connectionId],
  );
  if (connRows.length === 0) throw new Error("connection_not_found");
  const conn = connRows[0] as {
    org_id: string;
    selected_account_name: string | null;
    selected_location_name: string | null;
  };
  const locationName = post.locationName ?? conn.selected_location_name;
  if (!locationName) throw new Error("connection_has_no_location");

  try {
    const { accessToken } = await refreshConnectionToken(post.connectionId);
    const resource = buildLocationResource(conn.selected_account_name, locationName);
    const actionType = CTA_ACTION_TYPES[post.ctaType ?? "learn-more"] ?? "LEARN_MORE";
    const callToAction: Record<string, unknown> = { actionType };
    if (actionType !== "CALL" && post.ctaUrl) {
      callToAction.url = post.ctaUrl;
    }
    const body: Record<string, unknown> = {
      languageCode: "en-US",
      summary: post.body,
      topicType: "STANDARD",
      callToAction,
    };
    if (post.photoUrl) {
      body.media = [{ mediaFormat: "PHOTO", sourceUrl: post.photoUrl }];
    }

    const result = await googleApiCallRaw<{ name?: string }>({
      baseUrl: "https://mybusiness.googleapis.com",
      endpoint: `v4/${resource}/localPosts`,
      method: "POST",
      accessToken,
      orgId: conn.org_id,
      connectionId: post.connectionId,
      body,
    });

    const rows = await query(
      `UPDATE gbp_posts
          SET status = 'published', published_at = NOW(), google_post_name = $2,
              failure_reason = NULL, updated_at = NOW()
        WHERE id = $1
      RETURNING ${POST_COLUMNS}`,
      [postId, result?.name ?? null],
    );
    if (post.photoId) {
      await recordPhotoUsage(post.photoId);
    }
    await writeAuditEvent(
      "gbp.post.published",
      postId,
      { googlePostName: result?.name ?? null, locationName: resource, ctaType: post.ctaType },
      adminUserId,
    );
    return mapPost(rows[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    await query(
      `UPDATE gbp_posts SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
      [postId, reason],
    );
    await writeAuditEvent("gbp.post.publish_failed", postId, { reason }, adminUserId);
    throw error;
  }
}

/** One-tap owner approval of a warm-up / queued post → publishes immediately. */
export async function approvePost(postId: string, adminUserId?: string | null): Promise<GbpPostRecord> {
  await query(
    `UPDATE gbp_posts SET approved_by = $2::uuid, approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [postId, adminUserId || AUDIT_SYSTEM_USER],
  );
  await writeAuditEvent("gbp.post.approved", postId, {}, adminUserId);
  return publishPost(postId, adminUserId);
}

/** Owner skips a queued post — it is retired without publishing. */
export async function skipPost(postId: string, adminUserId?: string | null): Promise<GbpPostRecord> {
  const rows = await query(
    `UPDATE gbp_posts SET status = 'skipped', updated_at = NOW() WHERE id = $1 RETURNING ${POST_COLUMNS}`,
    [postId],
  );
  if (rows.length === 0) throw new Error("post_not_found");
  await writeAuditEvent("gbp.post.skipped", postId, {}, adminUserId);
  return mapPost(rows[0]);
}

export interface WeeklyRunResult {
  slotId: string;
  orgId: string;
  locationName: string;
  postId: string | null;
  status: GbpPostStatus | "error";
  published: boolean;
  queued: boolean;
  reason: string | null;
}

/**
 * Run the full weekly loop for ONE publish slot: pick the template + city +
 * photo, generate a guarded post, then either publish it, queue it for owner
 * approval (warm-up or guard-exhausted), or record the failure. Returns a
 * summary row for the cron response. Never throws — a per-slot error is captured
 * so one bad slot never aborts the batch.
 */
export async function runWeeklyPostForSlot(
  slot: GbpSlotRecord,
  options: { force?: boolean } = {},
): Promise<WeeklyRunResult> {
  const base: WeeklyRunResult = {
    slotId: slot.id,
    orgId: slot.orgId,
    locationName: slot.locationName,
    postId: null,
    status: "error",
    published: false,
    queued: false,
    reason: null,
  };
  try {
    const now = new Date();
    const weekStart = startOfWeek(now);

    if (!options.force) {
      const existing = await query(
        `SELECT id FROM gbp_posts
          WHERE slot_id = $1 AND week_start = $2 AND status <> 'skipped' LIMIT 1`,
        [slot.id, weekStart],
      );
      if (existing.length > 0) {
        return { ...base, postId: String(existing[0].id), status: "scheduled", reason: "already_posted_this_week" };
      }
    }

    const season: GbpSeason = seasonForMonth(now.getUTCMonth());
    const template = await pickTemplate(slot.trade, season, slot.locationName);
    if (!template) {
      return { ...base, reason: "no_active_template" };
    }

    const serviceCity = pickServiceCity(slot.serviceAreaCities, weekStart);
    const serviceTerm = deriveServiceTerm(slot.trade, season);
    const photo = await selectPhotoForServiceLine(slot.orgId, slot.trade);

    const locationHistory = await getLocationHistory(slot.locationName, 12);
    const platformThisWeek = await getPlatformWeekPosts(slot.locationName);
    const previousCtaType = locationHistory[0]?.ctaType ?? null;
    const claimsPolicy: ClaimsPolicy = asJson<ClaimsPolicy>((slot.voice as Record<string, unknown>).claimsPolicy, {});

    const generation = await generateCompliantPost({
      trade: slot.trade,
      season,
      serviceTerm,
      serviceCity,
      photoCategory: photo?.category ?? "jobsite",
      photoCaption: photo?.caption ?? null,
      bodyTemplate: template.bodyTemplate,
      voice: slot.voice,
      previousCtaType,
      claimsPolicy,
      locationHistory,
      platformThisWeek,
    });

    const ctaUrl = buildCtaUrl(generation.ctaType, slot);
    const isWarmup = slot.warmupPostsRemaining > 0;
    // Warm-up posts and guard-exhausted posts queue for one-tap owner approval.
    const needsApproval = isWarmup || !generation.ok;
    const status: GbpPostStatus = needsApproval ? "needs_approval" : "scheduled";

    const scheduledFor = nextSlotDate(slot, now).toISOString();
    const record = await createPostRecord({
      orgId: slot.orgId,
      connectionId: slot.connectionId,
      locationName: slot.locationName,
      slotId: slot.id,
      templateId: template.id,
      photo,
      serviceLine: slot.trade,
      season,
      serviceCity,
      generation,
      ctaUrl,
      status,
      scheduledFor,
      weekStart,
      isWarmup,
      failureReason: generation.ok ? null : generation.queueReason,
    });

    await writeAuditEvent("gbp.post.generated", record.id, {
      slotId: slot.id,
      ok: generation.ok,
      regenerateCount: generation.regenerateCount,
      varianceScore: generation.variance.score,
      claimsScore: generation.claims.score,
      usedGateway: generation.usedGateway,
      queued: needsApproval,
    });

    if (needsApproval) {
      if (isWarmup) {
        await query(
          `UPDATE gbp_publish_slots
              SET warmup_posts_remaining = GREATEST(warmup_posts_remaining - 1, 0), updated_at = NOW()
            WHERE id = $1`,
          [slot.id],
        );
      }
      return {
        ...base,
        postId: record.id,
        status: "needs_approval",
        queued: true,
        reason: generation.ok ? (isWarmup ? "warmup_awaiting_approval" : null) : generation.queueReason,
      };
    }

    // Guards passed and warm-up is over → publish now.
    try {
      const published = await publishPost(record.id);
      return {
        ...base,
        postId: published.id,
        status: "published",
        published: true,
        reason: null,
      };
    } catch (publishError) {
      return {
        ...base,
        postId: record.id,
        status: "failed",
        reason: publishError instanceof Error ? publishError.message : "publish_failed",
      };
    }
  } catch (error) {
    return { ...base, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}

/**
 * Regenerate a queued/failed post in place (owner-triggered or auto). Re-runs the
 * generator against fresh history and overwrites the post body + guard scores.
 */
export async function regeneratePost(postId: string, adminUserId?: string | null): Promise<GbpPostRecord> {
  const post = await getPost(postId);
  if (!post) throw new Error("post_not_found");

  const season = post.season as GbpSeason;
  const slot = post.slotId
    ? mapSlot(
        (await query(`SELECT ${SLOT_COLUMNS} FROM gbp_publish_slots WHERE id = $1 LIMIT 1`, [post.slotId]))[0] ?? {},
      )
    : null;

  const voice: VoiceProfile = slot?.voice ?? {};
  const serviceAreaCities = slot?.serviceAreaCities ?? (post.serviceCity ? [post.serviceCity] : []);
  const template = await pickTemplate(post.serviceLine, season, post.locationName);
  const locationHistory = await getLocationHistory(post.locationName ?? "", 12);
  const platformThisWeek = await getPlatformWeekPosts(post.locationName ?? undefined);

  const generation = await generateCompliantPost({
    trade: post.serviceLine,
    season,
    serviceTerm: deriveServiceTerm(post.serviceLine, season),
    serviceCity: post.serviceCity ?? pickServiceCity(serviceAreaCities, post.weekStart ?? startOfWeek(new Date())),
    photoCategory: "jobsite",
    photoCaption: null,
    bodyTemplate: template?.bodyTemplate ?? "Share a quick update about {{service_term}} in {{service_city}}. {{cta_type}}.",
    voice,
    previousCtaType: post.ctaType,
    claimsPolicy: asJson<ClaimsPolicy>((voice as Record<string, unknown>).claimsPolicy, {}),
    locationHistory,
    platformThisWeek,
  });

  const ctaUrl = slot ? buildCtaUrl(generation.ctaType, slot) : post.ctaUrl;
  const rows = await query(
    `UPDATE gbp_posts
        SET body = $2, summary = $3, cta_type = $4, cta_url = $5,
            variance_score = $6, variance_passed = $7, variance_detail = $8::jsonb,
            claims_passed = $9, claims_detail = $10::jsonb,
            regenerate_count = regenerate_count + $11,
            status = $12, failure_reason = $13, updated_at = NOW()
      WHERE id = $1
    RETURNING ${POST_COLUMNS}`,
    [
      postId,
      generation.body,
      generation.body.slice(0, 160),
      generation.ctaType,
      ctaUrl,
      generation.variance.score,
      generation.variance.passed,
      JSON.stringify(generation.variance),
      generation.claims.passed,
      JSON.stringify(generation.claims),
      generation.regenerateCount + 1,
      // A manually regenerated post always returns to the owner for one-tap review.
      "needs_approval",
      generation.ok ? null : generation.queueReason,
    ],
  );
  await writeAuditEvent("gbp.post.regenerated", postId, {
    ok: generation.ok,
    varianceScore: generation.variance.score,
    claimsScore: generation.claims.score,
  }, adminUserId);
  return mapPost(rows[0]);
}

// ── Scheduling helpers ─────────────────────────────────────────────────────────

/** ISO date (YYYY-MM-DD) of the Monday that starts `d`'s week (UTC). */
export function startOfWeek(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0 Sun … 6 Sat
  const diff = (day + 6) % 7; // days since Monday
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}

/** Next occurrence of the slot's day/hour/minute at or after `from`. */
export function nextSlotDate(slot: GbpSlotRecord, from: Date): Date {
  const result = new Date(from.getTime());
  result.setUTCHours(slot.hour, slot.minute, 0, 0);
  const currentDay = result.getUTCDay();
  let delta = (slot.dayOfWeek - currentDay + 7) % 7;
  if (delta === 0 && result.getTime() <= from.getTime()) {
    delta = 7;
  }
  result.setUTCDate(result.getUTCDate() + delta);
  return result;
}

/** Deterministically rotate through the service-area cities by week. */
export function pickServiceCity(cities: string[], weekStart: string): string {
  const list = cities.filter((c) => c && c.trim());
  if (list.length === 0) return "your area";
  // Hash the week-start date to an index so the city rotates weekly, not randomly.
  let hash = 0;
  for (const ch of weekStart) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return list[hash % list.length].trim();
}

const SERVICE_TERMS: Record<string, Record<string, string>> = {
  plumbing: {
    cooling: "drain and water-line service",
    heating: "water heater and pipe-freeze protection",
    shoulder: "leak detection and fixture repair",
    "storm-freeze": "burst-pipe and emergency plumbing",
  },
  electrical: {
    cooling: "panel and AC-circuit checks",
    heating: "heating-circuit and safety inspections",
    shoulder: "lighting and outlet upgrades",
    "storm-freeze": "generator and storm-outage wiring",
  },
  hvac: {
    cooling: "AC tune-ups and cooling service",
    heating: "furnace tune-ups and heating service",
    shoulder: "system maintenance and filter service",
    "storm-freeze": "emergency heat and freeze protection",
  },
  "multi-trade": {
    cooling: "seasonal home service",
    heating: "seasonal home service",
    shoulder: "home maintenance",
    "storm-freeze": "emergency home service",
  },
};

/** A natural service phrase for the trade+season (feeds the prompt's slot). */
export function deriveServiceTerm(trade: string, season: string): string {
  return SERVICE_TERMS[trade]?.[season] ?? SERVICE_TERMS["multi-trade"][season] ?? "home service";
}

/** Build the CTA target URL from the slot's voice profile, where present. */
export function buildCtaUrl(ctaType: string, slot: GbpSlotRecord): string | null {
  const v = slot.voice as Record<string, unknown>;
  const website = typeof v.website === "string" ? v.website : null;
  const bookingUrl = typeof v.bookingUrl === "string" ? v.bookingUrl : null;
  const quoteUrl = typeof v.quoteUrl === "string" ? v.quoteUrl : null;
  switch (ctaType) {
    case "call-now":
      return null; // CALL uses the location's phone, no URL.
    case "book-online":
      return bookingUrl ?? website;
    case "request-quote":
      return quoteUrl ?? website;
    default:
      return website;
  }
}
