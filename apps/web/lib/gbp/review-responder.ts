/**
 * Review responder & sensitivity gate — orchestration + persistence (F1-006).
 *
 * Owns everything stateful around a mirrored Google review: inserting the
 * PII-redacted review, drafting a reply (voice-matched for LOW, neutral-safe for
 * ELEVATED/HIGH), running the moderation gate, and then either
 *   - publishing LOW-risk replies via the GBP `reviews.updateReply` endpoint
 *     (after a 3-reply warm-up per location), or
 *   - queuing ELEVATED/HIGH replies for the owner with a notification, escalating
 *     to a support ticket after the configured window (72h).
 * Every publish writes an audit event. Owner actions (approve / edit & post /
 * don't reply) live here too.
 *
 * DB access uses the substrate's lazy `require("pg")` pool so preview builds
 * without DATABASE_URL still compile; all queries are parameterized.
 */

import { googleApiCallRaw } from "@/lib/gbp/google-client";
import { refreshConnectionToken } from "@/lib/gbp/oauth";
import { redactPii } from "@/lib/gbp/pii-redact";
import {
  classifyReviewSensitivity,
  type SensitivityLevel,
  type SensitivityReason,
} from "@/lib/gbp/review-sensitivity";
import {
  buildReplyFallback,
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  type ReplyKind,
  type ReplyPromptInput,
} from "@/lib/gbp/prompts/reply";
import type { VoiceProfile } from "@/lib/gbp/prompts/post";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { handleSendNotification } from "@nexus/notifications";
import { handleCreateTicket } from "@nexus/support-and-help";

const WARMUP_REPLIES = 3;
const AUDIT_SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

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

export type ReviewReplyStatus =
  | "pending"
  | "queued"
  | "auto_published"
  | "published"
  | "skipped"
  | "failed";

export interface GbpReviewRecord {
  id: string;
  orgId: string;
  connectionId: string | null;
  locationName: string | null;
  googleReviewId: string;
  googleReviewName: string | null;
  reviewerDisplayName: string | null;
  reviewerIsAnonymous: boolean;
  starRating: number;
  commentRedacted: string | null;
  commentRedactions: unknown;
  hadComment: boolean;
  reviewCreateTime: string | null;
  reviewUpdateTime: string | null;
  sensitivity: SensitivityLevel;
  sensitivityReasons: SensitivityReason[];
  sensitivityDetail: unknown;
  draftReply: string | null;
  draftKind: ReplyKind;
  usedGateway: boolean;
  moderationPassed: boolean;
  moderationDetail: unknown;
  replyStatus: ReviewReplyStatus;
  publishedReply: string | null;
  publishedAt: string | null;
  isWarmup: boolean;
  queuedAt: string | null;
  notifiedAt: string | null;
  escalatedAt: string | null;
  supportTicketId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
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

const REVIEW_COLUMNS = `
  id, org_id, connection_id, location_name, google_review_id, google_review_name,
  reviewer_display_name, reviewer_is_anonymous, star_rating, comment_redacted,
  comment_redactions, had_comment, review_create_time, review_update_time,
  sensitivity, sensitivity_reasons, sensitivity_detail, draft_reply, draft_kind,
  used_gateway, moderation_passed, moderation_detail, reply_status, published_reply,
  published_at, is_warmup, queued_at, notified_at, escalated_at, support_ticket_id,
  approved_by, approved_at, failure_reason, created_at, updated_at
`;

function mapReview(row: Record<string, unknown>): GbpReviewRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    locationName: row.location_name == null ? null : String(row.location_name),
    googleReviewId: String(row.google_review_id),
    googleReviewName: row.google_review_name == null ? null : String(row.google_review_name),
    reviewerDisplayName: row.reviewer_display_name == null ? null : String(row.reviewer_display_name),
    reviewerIsAnonymous: Boolean(row.reviewer_is_anonymous),
    starRating: Number(row.star_rating ?? 0),
    commentRedacted: row.comment_redacted == null ? null : String(row.comment_redacted),
    commentRedactions: asJson(row.comment_redactions, []),
    hadComment: Boolean(row.had_comment),
    reviewCreateTime: toIso(row.review_create_time),
    reviewUpdateTime: toIso(row.review_update_time),
    sensitivity: String(row.sensitivity ?? "low") as SensitivityLevel,
    sensitivityReasons: asJson<SensitivityReason[]>(row.sensitivity_reasons, []),
    sensitivityDetail: asJson(row.sensitivity_detail, {}),
    draftReply: row.draft_reply == null ? null : String(row.draft_reply),
    draftKind: String(row.draft_kind ?? "voice_matched") as ReplyKind,
    usedGateway: Boolean(row.used_gateway),
    moderationPassed: Boolean(row.moderation_passed),
    moderationDetail: asJson(row.moderation_detail, {}),
    replyStatus: String(row.reply_status ?? "pending") as ReviewReplyStatus,
    publishedReply: row.published_reply == null ? null : String(row.published_reply),
    publishedAt: toIso(row.published_at),
    isWarmup: Boolean(row.is_warmup),
    queuedAt: toIso(row.queued_at),
    notifiedAt: toIso(row.notified_at),
    escalatedAt: toIso(row.escalated_at),
    supportTicketId: row.support_ticket_id == null ? null : String(row.support_ticket_id),
    approvedBy: row.approved_by == null ? null : String(row.approved_by),
    approvedAt: toIso(row.approved_at),
    failureReason: row.failure_reason == null ? null : String(row.failure_reason),
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** All reviews for an org, newest first — the /reviews timeline. */
export async function listReviews(orgId: string, limit = 100): Promise<GbpReviewRecord[]> {
  const rows = await query(
    `SELECT ${REVIEW_COLUMNS} FROM gbp_reviews WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map(mapReview);
}

export async function getReview(id: string): Promise<GbpReviewRecord | null> {
  const rows = await query(`SELECT ${REVIEW_COLUMNS} FROM gbp_reviews WHERE id = $1 LIMIT 1`, [id]);
  return rows.length > 0 ? mapReview(rows[0]) : null;
}

/** Count of replies already published for a location — drives the warm-up gate. */
export async function countPublishedRepliesForLocation(locationName: string | null): Promise<number> {
  if (!locationName) return 0;
  const rows = await query(
    `SELECT COUNT(*)::int AS n FROM gbp_reviews
      WHERE location_name = $1 AND reply_status IN ('published','auto_published')`,
    [locationName],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ReviewCounts {
  total: number;
  answered: number;
  needsOwner: number;
  answeredThisMonth: number;
}

/** Summary counts for the /reviews header + empty-state celebration. */
export async function getReviewCounts(orgId: string): Promise<ReviewCounts> {
  const rows = await query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE reply_status IN ('published','auto_published'))::int AS answered,
        COUNT(*) FILTER (WHERE reply_status = 'queued')::int AS needs_owner,
        COUNT(*) FILTER (
          WHERE reply_status IN ('published','auto_published')
            AND published_at >= date_trunc('month', NOW())
        )::int AS answered_this_month
       FROM gbp_reviews WHERE org_id = $1`,
    [orgId],
  );
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    answered: Number(r.answered ?? 0),
    needsOwner: Number(r.needs_owner ?? 0),
    answeredThisMonth: Number(r.answered_this_month ?? 0),
  };
}

export interface ReviewSettings {
  orgId: string;
  connectionId: string | null;
  locationName: string;
  voice: VoiceProfile;
  warmupRepliesRemaining: number;
  autoPublishEnabled: boolean;
  escalateAfterHours: number;
}

/**
 * Resolve the reply settings for a location. Reads the per-location
 * `gbp_review_settings` row when present; otherwise falls back to the voice
 * profile on the weekly publish slot (shared source of voice), with sensible
 * defaults. Never throws.
 */
export async function getReviewSettings(
  orgId: string,
  locationName: string | null,
): Promise<ReviewSettings> {
  const fallback: ReviewSettings = {
    orgId,
    connectionId: null,
    locationName: locationName ?? "",
    voice: {},
    warmupRepliesRemaining: WARMUP_REPLIES,
    autoPublishEnabled: true,
    escalateAfterHours: 72,
  };
  if (!locationName) return fallback;

  const rows = await query(
    `SELECT org_id, connection_id, location_name, voice_profile,
            warmup_replies_remaining, auto_publish_enabled, escalate_after_hours
       FROM gbp_review_settings
      WHERE org_id = $1 AND location_name = $2 AND is_active = TRUE
      LIMIT 1`,
    [orgId, locationName],
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      orgId,
      connectionId: r.connection_id == null ? null : String(r.connection_id),
      locationName,
      voice: asJson<VoiceProfile>(r.voice_profile, {}),
      warmupRepliesRemaining: Number(r.warmup_replies_remaining ?? WARMUP_REPLIES),
      autoPublishEnabled: Boolean(r.auto_publish_enabled),
      escalateAfterHours: Number(r.escalate_after_hours ?? 72),
    };
  }

  // Fall back to the weekly-post slot's voice profile for the same location.
  const slot = await query(
    `SELECT connection_id, voice_profile FROM gbp_publish_slots
      WHERE org_id = $1 AND location_name = $2 ORDER BY created_at ASC LIMIT 1`,
    [orgId, locationName],
  );
  if (slot.length > 0) {
    return {
      ...fallback,
      connectionId: slot[0].connection_id == null ? null : String(slot[0].connection_id),
      voice: asJson<VoiceProfile>(slot[0].voice_profile, {}),
    };
  }
  return fallback;
}

// ── Audit (admin-console) ────────────────────────────────────────────────────

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
      [adminUserId || AUDIT_SYSTEM_USER, action, "gbp_review", targetId, JSON.stringify(payload)],
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_audit_write_failed",
        action,
        targetId,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }
}

// ── Moderation gate (@nexus/social-and-engagement:moderate_comment) ───────────

export interface ModerationResult {
  passed: boolean;
  /** Reasons the draft was rejected (empty when passed). */
  issues: string[];
  score: number;
}

const PROFANITY_PATTERNS: RegExp[] = [
  /\bf[\W_]*u[\W_]*c[\W_]*k/i,
  /\bs[\W_]*h[\W_]*i[\W_]*t\b/i,
  /\bb[\W_]*i[\W_]*t[\W_]*c[\W_]*h\b/i,
  /\ba[\W_]*s[\W_]*s[\W_]*h[\W_]*o[\W_]*l[\W_]*e\b/i,
  /\bidiot|moron|stupid|liar\b/i,
];

const SPAM_PATTERNS: RegExp[] = [
  /\b(?:buy\s*now|click\s*here|visit\s*our\s*site|limited\s*time\s*offer|promo\s*code)\b/i,
  /\b(?:https?:\/\/|www\.)\S+/i,
];

/**
 * Local equivalent of the social lego's `moderate_comment` verdict: a reply we are
 * about to publish must not be toxic, spammy, or leak PII. Returns a structured
 * verdict so the pipeline can block publishing and route to the owner instead.
 */
export function moderateReplyDraft(text: string): ModerationResult {
  const issues: string[] = [];
  const body = (text ?? "").trim();

  if (!body) {
    issues.push("empty_reply");
  }
  if (body.length > 1500) {
    issues.push("too_long");
  }
  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(body)) {
      issues.push("toxic_language");
      break;
    }
  }
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(body)) {
      issues.push("spam_or_link");
      break;
    }
  }
  // A published reply must never itself contain customer PII.
  const redaction = redactPii(body);
  if (redaction.hasPii) {
    issues.push("contains_pii");
  }
  // Shouting / all-caps heuristic.
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length > 20 && letters === letters.toUpperCase()) {
    issues.push("all_caps");
  }

  const passed = issues.length === 0;
  const score = Math.max(0, 100 - issues.length * 25);
  return { passed, issues, score };
}

// ── Reply generation ─────────────────────────────────────────────────────────

interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Call the Nexus LLM gateway for a voice-matched reply (Claude Sonnet). Returns
 * the trimmed reply on success, or null on any failure / missing config so the
 * caller falls back to deterministic copy. Never throws.
 */
export async function callReplyGateway(system: string, user: string): Promise<string | null> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.RUNTIME_AUTH_TOKEN;
  if (!baseUrl || !token) return null;

  const model = process.env.NEXUS_GATEWAY_REPLY_MODEL ?? "claude-sonnet-5";
  const messages: GatewayMessage[] = [{ role: "user", content: user }];
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, system, max_tokens: 300, temperature: 0.6, messages }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      text?: string;
    };
    if (Array.isArray(data.content)) {
      const text = data.content
        .filter((block) => block && block.type !== "tool_use")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      return text || null;
    }
    if (typeof data.text === "string" && data.text.trim()) return data.text.trim();
    return null;
  } catch {
    return null;
  }
}

function sanitizeReply(raw: string): string {
  return raw
    .replace(/^["'`\s]+/, "")
    .replace(/["'`\s]+$/, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface GeneratedReply {
  body: string;
  kind: ReplyKind;
  usedGateway: boolean;
  moderation: ModerationResult;
}

/**
 * Generate a moderated reply draft. LOW reviews get a voice-matched draft;
 * ELEVATED/HIGH reviews get a neutral-safe draft. The draft is moderated, and on
 * a moderation failure we fall back to the deterministic safe copy (which always
 * passes) so a draft always exists for the owner. Never throws.
 */
export async function generateReplyDraft(input: {
  redactedComment: string;
  starRating: number;
  reviewerName: string;
  voice: VoiceProfile;
  sensitivity: SensitivityLevel;
}): Promise<GeneratedReply> {
  const kind: ReplyKind = input.sensitivity === "low" ? "voice_matched" : "neutral_safe";
  const promptInput: ReplyPromptInput = {
    redactedComment: input.redactedComment,
    starRating: input.starRating,
    reviewerName: input.reviewerName,
    voice: input.voice,
    kind,
    regenerateHint: null,
  };

  const system = buildReplySystemPrompt(input.voice, kind);
  const userPrompt = buildReplyUserPrompt(promptInput);

  let usedGateway = true;
  let generated = await callReplyGateway(system, userPrompt);
  if (!generated) {
    usedGateway = false;
    generated = buildReplyFallback(promptInput);
  }
  let body = sanitizeReply(generated);
  let moderation = moderateReplyDraft(body);

  if (!moderation.passed) {
    // The model produced something unsafe — drop to the deterministic fallback.
    body = sanitizeReply(buildReplyFallback(promptInput));
    usedGateway = false;
    moderation = moderateReplyDraft(body);
  }

  return { body, kind, usedGateway, moderation };
}

// ── Upsert from Google ───────────────────────────────────────────────────────

export interface IngestReviewInput {
  orgId: string;
  connectionId: string | null;
  locationName: string | null;
  googleReviewId: string;
  googleReviewName: string | null;
  reviewerDisplayName: string | null;
  reviewerIsAnonymous: boolean;
  starRating: number;
  /** RAW comment from Google — redacted here before any storage. */
  rawComment: string | null;
  reviewCreateTime: string | null;
  reviewUpdateTime: string | null;
}

export interface IngestResult {
  review: GbpReviewRecord;
  isNew: boolean;
}

/**
 * Insert a newly-seen review (PII-redacted + classified) or return the existing
 * row unchanged. The RAW comment is redacted in memory and never persisted.
 */
export async function ingestReview(input: IngestReviewInput): Promise<IngestResult> {
  const existing = await query(
    `SELECT ${REVIEW_COLUMNS} FROM gbp_reviews WHERE org_id = $1 AND google_review_id = $2 LIMIT 1`,
    [input.orgId, input.googleReviewId],
  );
  if (existing.length > 0) {
    return { review: mapReview(existing[0]), isNew: false };
  }

  const redaction = redactPii(input.rawComment);
  const hadComment = Boolean((input.rawComment ?? "").trim());
  const sensitivity = await classifyReviewSensitivity({
    redactedComment: redaction.redacted,
    starRating: input.starRating,
    piiFindings: redaction.findings,
  });

  const rows = await query(
    `INSERT INTO gbp_reviews (
        org_id, connection_id, location_name, google_review_id, google_review_name,
        reviewer_display_name, reviewer_is_anonymous, star_rating, comment_redacted,
        comment_redactions, had_comment, review_create_time, review_update_time,
        sensitivity, sensitivity_reasons, sensitivity_detail, reply_status
     ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::jsonb, $11, $12, $13,
        $14, $15::jsonb, $16::jsonb, 'pending'
     )
     ON CONFLICT (org_id, google_review_id) DO NOTHING
     RETURNING ${REVIEW_COLUMNS}`,
    [
      input.orgId,
      input.connectionId,
      input.locationName,
      input.googleReviewId,
      input.googleReviewName,
      input.reviewerDisplayName,
      input.reviewerIsAnonymous,
      input.starRating,
      redaction.redacted || null,
      JSON.stringify(redaction.findings),
      hadComment,
      input.reviewCreateTime,
      input.reviewUpdateTime,
      sensitivity.level,
      JSON.stringify(sensitivity.reasons),
      JSON.stringify(sensitivity.detail),
    ],
  );
  if (rows.length === 0) {
    // Lost an insert race — read the existing row.
    const raced = await query(
      `SELECT ${REVIEW_COLUMNS} FROM gbp_reviews WHERE org_id = $1 AND google_review_id = $2 LIMIT 1`,
      [input.orgId, input.googleReviewId],
    );
    return { review: mapReview(raced[0]), isNew: false };
  }
  return { review: mapReview(rows[0]), isNew: true };
}

// ── Publish (reviews.updateReply) ─────────────────────────────────────────────

/** Build the `accounts/.../locations/.../reviews/...` resource for a review. */
function buildReviewResource(
  accountName: string | null,
  locationName: string | null,
  reviewName: string | null,
  googleReviewId: string,
): string | null {
  if (reviewName && reviewName.startsWith("accounts/")) return reviewName;
  if (locationName && locationName.startsWith("accounts/")) {
    return `${locationName.replace(/\/$/, "")}/reviews/${googleReviewId}`;
  }
  if (accountName && locationName) {
    return `${accountName.replace(/\/$/, "")}/${locationName.replace(/^\//, "")}/reviews/${googleReviewId}`;
  }
  return null;
}

/**
 * Publish (or update) a review reply via the GBP `reviews.updateReply` endpoint,
 * mark the review answered and write the audit event. On any failure the review
 * is flagged `failed` with the reason and the error is re-thrown.
 */
export async function publishReply(
  reviewId: string,
  replyText: string,
  options: { auto?: boolean; adminUserId?: string | null } = {},
): Promise<GbpReviewRecord> {
  const review = await getReview(reviewId);
  if (!review) throw new Error("review_not_found");
  if (!review.connectionId) throw new Error("review_has_no_connection");

  const moderation = moderateReplyDraft(replyText);
  if (!moderation.passed) {
    await query(
      `UPDATE gbp_reviews SET reply_status = 'failed', failure_reason = $2,
              moderation_passed = FALSE, moderation_detail = $3::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [reviewId, `moderation_failed:${moderation.issues.join(",")}`, JSON.stringify(moderation)],
    );
    throw new Error(`moderation_failed:${moderation.issues.join(",")}`);
  }

  const connRows = await query(
    `SELECT id, org_id, selected_account_name, selected_location_name
       FROM gbp_connections WHERE id = $1 LIMIT 1`,
    [review.connectionId],
  );
  if (connRows.length === 0) throw new Error("connection_not_found");
  const conn = connRows[0] as {
    org_id: string;
    selected_account_name: string | null;
    selected_location_name: string | null;
  };
  const locationName = review.locationName ?? conn.selected_location_name;
  const resource = buildReviewResource(
    conn.selected_account_name,
    locationName,
    review.googleReviewName,
    review.googleReviewId,
  );
  if (!resource) throw new Error("cannot_build_review_resource");

  const status: ReviewReplyStatus = options.auto ? "auto_published" : "published";
  try {
    const { accessToken } = await refreshConnectionToken(review.connectionId);
    await googleApiCallRaw<{ comment?: string; updateTime?: string }>({
      baseUrl: "https://mybusiness.googleapis.com",
      endpoint: `v4/${resource}/reply`,
      method: "PUT",
      accessToken,
      orgId: conn.org_id,
      connectionId: review.connectionId,
      body: { comment: replyText },
    });

    const rows = await query(
      `UPDATE gbp_reviews
          SET reply_status = $2, published_reply = $3, published_at = NOW(),
              draft_reply = $3, moderation_passed = TRUE, moderation_detail = $4::jsonb,
              failure_reason = NULL, updated_at = NOW()
        WHERE id = $1
      RETURNING ${REVIEW_COLUMNS}`,
      [reviewId, status, replyText, JSON.stringify(moderation)],
    );
    await writeAuditEvent(
      "gbp.review.replied",
      reviewId,
      {
        status,
        auto: Boolean(options.auto),
        sensitivity: review.sensitivity,
        locationName: resource,
        starRating: review.starRating,
      },
      options.adminUserId,
    );
    return mapReview(rows[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    await query(
      `UPDATE gbp_reviews SET reply_status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
      [reviewId, reason],
    );
    await writeAuditEvent("gbp.review.reply_failed", reviewId, { reason }, options.adminUserId);
    throw error;
  }
}

// ── Owner notification (@nexus/notifications) ─────────────────────────────────

/** Resolve the owner user for an org (the connection's authorizing user). */
async function resolveOwner(orgId: string): Promise<{ userId: string | null; email: string | null }> {
  const rows = await query(
    `SELECT c.user_id, u.email
       FROM gbp_connections c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.org_id = $1
      ORDER BY c.created_at ASC
      LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return { userId: null, email: null };
  return {
    userId: rows[0].user_id == null ? null : String(rows[0].user_id),
    email: rows[0].email == null ? null : String(rows[0].email),
  };
}

/**
 * Notify the owner that a review is waiting in their queue, via the notifications
 * lego (in-app + email). Best-effort: a notification failure never aborts the
 * pipeline. Stamps `notified_at` on success.
 */
export async function notifyOwnerOfQueuedReview(review: GbpReviewRecord): Promise<boolean> {
  try {
    const owner = await resolveOwner(review.orgId);
    if (!owner.userId) return false;

    const reasonLine = review.sensitivityReasons[0]?.label ?? "This review needs your review before a reply.";
    const htmlTemplate = [
      "<h2>A review needs your reply</h2>",
      "<p>{{reason}}</p>",
      "<p>A safe draft is ready — approve it, edit it, or decide not to reply.</p>",
      '<p><a href="{{link}}">Open the review</a></p>',
    ].join("");
    const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const link = base ? `${base}/reviews/${review.id}` : `/reviews/${review.id}`;

    const result = await handleSendNotification({
      body: {
        user_id: owner.userId,
        template_name: "gbp_review_needs_owner",
        category: "transactional",
        html_template: htmlTemplate,
        to_email: owner.email ?? undefined,
        variables: {
          reason: reasonLine,
          link,
          stars: String(review.starRating),
        },
      },
      config: {
        default_channels: ["in_app", "email"],
        resend_from_email: process.env.EMAIL_FROM || `${process.env.COMPANY_SLUG || "no-reply"}@nexusaiholdings.com`,
      },
      ctx: { db: buildDb(), events: buildEventBus() },
    });

    if (result.status >= 200 && result.status < 300) {
      await query(`UPDATE gbp_reviews SET notified_at = NOW(), updated_at = NOW() WHERE id = $1`, [review.id]);
      await writeAuditEvent("gbp.review.owner_notified", review.id, { userId: owner.userId });
      return true;
    }
    return false;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_notify_failed",
        reviewId: review.id,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return false;
  }
}

// ── Escalation (@nexus/support-and-help) ──────────────────────────────────────

/**
 * Open a support ticket for a queued review the owner hasn't acted on within the
 * escalation window. Best-effort; stamps `escalated_at` + `support_ticket_id` on
 * success so a review is only escalated once.
 */
export async function escalateReviewToSupport(review: GbpReviewRecord): Promise<boolean> {
  try {
    const owner = await resolveOwner(review.orgId);
    const subject = `Unanswered ${review.starRating}-star review needs attention`;
    const reasonLine = review.sensitivityReasons.map((r) => r.label).join(" ") || "Flagged for owner review.";
    const message = [
      `A ${review.sensitivity}-sensitivity review has been waiting in the owner queue for over the review window and still has no reply.`,
      `Why it was flagged: ${reasonLine}`,
      review.commentRedacted ? `Review (PII redacted): "${review.commentRedacted}"` : "The reviewer left a rating with no comment.",
      `A safe draft is ready in the dashboard for the owner to approve or edit.`,
    ].join("\n\n");

    const result = await handleCreateTicket(
      { db: buildDb(), events: buildEventBus() },
      {
        user_id: owner.userId ?? undefined,
        subject,
        message,
        priority: review.sensitivity === "high" ? "high" : "normal",
        email: owner.email ?? undefined,
      },
    );

    let ticketId: string | null = null;
    if (result.status >= 200 && result.status < 300 && typeof result.body === "object") {
      ticketId = String((result.body as Record<string, unknown>).ticket_id ?? "") || null;
    }

    await query(
      `UPDATE gbp_reviews SET escalated_at = NOW(), support_ticket_id = $2, updated_at = NOW() WHERE id = $1`,
      [review.id, ticketId],
    );
    await writeAuditEvent("gbp.review.escalated", review.id, {
      ticketId,
      sensitivity: review.sensitivity,
    });
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "gbp_review_escalate_failed",
        reviewId: review.id,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return false;
  }
}

/**
 * Find queued reviews past their escalation window (default 72h) that have not
 * yet been escalated, and open a support ticket for each. Returns the number
 * escalated. Called by the review-poll cron.
 */
export async function escalateStaleReviews(): Promise<number> {
  const rows = await query(
    `SELECT ${REVIEW_COLUMNS} FROM gbp_reviews r
      WHERE r.reply_status = 'queued'
        AND r.escalated_at IS NULL
        AND r.queued_at IS NOT NULL
        AND r.queued_at <= NOW() - (
          COALESCE(
            (SELECT s.escalate_after_hours FROM gbp_review_settings s
              WHERE s.org_id = r.org_id AND s.location_name = r.location_name LIMIT 1),
            72
          ) * INTERVAL '1 hour'
        )
      ORDER BY r.queued_at ASC
      LIMIT 100`,
  );
  let escalated = 0;
  for (const row of rows) {
    const ok = await escalateReviewToSupport(mapReview(row));
    if (ok) escalated += 1;
  }
  return escalated;
}

// ── Pipeline ───────────────────────────────────────────────────────────────

export interface ProcessResult {
  reviewId: string;
  sensitivity: SensitivityLevel;
  action: "auto_published" | "queued" | "failed" | "skipped";
  reason: string | null;
}

/**
 * Run the responder for a single pending review: draft + moderate a reply, then
 *   - LOW + moderation-passed + warm-up over + auto-publish on → publish now;
 *   - otherwise → queue for the owner (warm-up, elevated/high, or moderation fail)
 *     with a notification.
 * Never throws — a per-review error is captured in the result.
 */
export async function processReview(reviewId: string): Promise<ProcessResult> {
  const base: ProcessResult = { reviewId, sensitivity: "low", action: "failed", reason: null };
  try {
    const review = await getReview(reviewId);
    if (!review) return { ...base, reason: "review_not_found" };
    if (review.replyStatus !== "pending") {
      return { ...base, sensitivity: review.sensitivity, action: "skipped", reason: "already_processed" };
    }

    const settings = await getReviewSettings(review.orgId, review.locationName);
    const reviewerName = review.reviewerDisplayName ?? "A Google user";

    const draft = await generateReplyDraft({
      redactedComment: review.commentRedacted ?? "",
      starRating: review.starRating,
      reviewerName,
      voice: settings.voice,
      sensitivity: review.sensitivity,
    });

    // Warm-up: the first 3 replies per location wait for a one-tap owner OK
    // before publishing, so the owner can confirm the voice before it goes live.
    const publishedSoFar = await countPublishedRepliesForLocation(review.locationName);
    const warmupActive = publishedSoFar < WARMUP_REPLIES;

    const canAutoPublish =
      review.sensitivity === "low" &&
      draft.kind === "voice_matched" &&
      draft.moderation.passed &&
      settings.autoPublishEnabled &&
      !warmupActive;

    // Persist the draft + moderation first so the owner always sees it.
    await query(
      `UPDATE gbp_reviews
          SET draft_reply = $2, draft_kind = $3, used_gateway = $4,
              moderation_passed = $5, moderation_detail = $6::jsonb,
              is_warmup = $7, updated_at = NOW()
        WHERE id = $1`,
      [
        reviewId,
        draft.body,
        draft.kind,
        draft.usedGateway,
        draft.moderation.passed,
        JSON.stringify(draft.moderation),
        warmupActive,
      ],
    );

    await writeAuditEvent("gbp.review.drafted", reviewId, {
      sensitivity: review.sensitivity,
      draftKind: draft.kind,
      usedGateway: draft.usedGateway,
      moderationPassed: draft.moderation.passed,
      warmup: warmupActive,
      autoPublish: canAutoPublish,
    });

    if (canAutoPublish) {
      try {
        await publishReply(reviewId, draft.body, { auto: true });
        return { ...base, sensitivity: review.sensitivity, action: "auto_published", reason: null };
      } catch (publishError) {
        return {
          ...base,
          sensitivity: review.sensitivity,
          action: "failed",
          reason: publishError instanceof Error ? publishError.message : "publish_failed",
        };
      }
    }

    // Queue for the owner.
    const queueReason = warmupActive
      ? "warmup"
      : review.sensitivity !== "low"
        ? review.sensitivity
        : !draft.moderation.passed
          ? "moderation"
          : "auto_publish_disabled";
    await query(
      `UPDATE gbp_reviews SET reply_status = 'queued', queued_at = NOW(), failure_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [reviewId, queueReason],
    );
    await writeAuditEvent("gbp.review.queued", reviewId, {
      sensitivity: review.sensitivity,
      reason: queueReason,
    });

    const queued = await getReview(reviewId);
    if (queued) {
      await notifyOwnerOfQueuedReview(queued);
    }

    return { ...base, sensitivity: review.sensitivity, action: "queued", reason: queueReason };
  } catch (error) {
    return { ...base, reason: error instanceof Error ? error.message : "unknown_error" };
  }
}

// ── Owner actions ────────────────────────────────────────────────────────────

/** Owner approves the pending draft as-is → publish it to Google. */
export async function approveReply(reviewId: string, adminUserId?: string | null): Promise<GbpReviewRecord> {
  const review = await getReview(reviewId);
  if (!review) throw new Error("review_not_found");
  if (!review.draftReply) throw new Error("no_draft_to_approve");
  await query(
    `UPDATE gbp_reviews SET approved_by = $2::uuid, approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [reviewId, adminUserId || AUDIT_SYSTEM_USER],
  );
  await writeAuditEvent("gbp.review.approved", reviewId, {}, adminUserId);
  return publishReply(reviewId, review.draftReply, { auto: false, adminUserId });
}

/** Owner edits the draft and posts their own text. */
export async function editAndPostReply(
  reviewId: string,
  editedText: string,
  adminUserId?: string | null,
): Promise<GbpReviewRecord> {
  const text = (editedText ?? "").trim();
  if (!text) throw new Error("empty_reply");
  await query(
    `UPDATE gbp_reviews SET draft_reply = $2, approved_by = $3::uuid, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [reviewId, text, adminUserId || AUDIT_SYSTEM_USER],
  );
  await writeAuditEvent("gbp.review.edited", reviewId, { length: text.length }, adminUserId);
  return publishReply(reviewId, text, { auto: false, adminUserId });
}

/** Owner decides not to reply — the review is retired without a reply. */
export async function dontReply(reviewId: string, adminUserId?: string | null): Promise<GbpReviewRecord> {
  const rows = await query(
    `UPDATE gbp_reviews SET reply_status = 'skipped', updated_at = NOW() WHERE id = $1 RETURNING ${REVIEW_COLUMNS}`,
    [reviewId],
  );
  if (rows.length === 0) throw new Error("review_not_found");
  await writeAuditEvent("gbp.review.skipped", reviewId, {}, adminUserId);
  return mapReview(rows[0]);
}
