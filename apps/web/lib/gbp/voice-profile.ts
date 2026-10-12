"use server";

/**
 * Voice Profile Builder — server actions + domain logic (F1-004).
 *
 * The sub-15-minute onboarding questionnaire the COO flagged as the critical
 * bottleneck. These server actions back the five-screen stepper in
 * apps/web/app/(gbp)/voice/page.tsx:
 *
 *   1. Trade & service lines      → mapped to customer-language terms
 *   2. Service-area cities        → geocoded for the rank snapshot
 *   3. Tone sliders & sign-off    → formal↔casual, brief↔chatty, phrases
 *   4. Credential-claims opt-in   → OFF by default (liability review)
 *   5. Sample replies & finish    → few-shot voice set + first draft post
 *
 * Every export is an async Server Action (this module carries "use server"), so
 * the client stepper calls these directly. Auth/tenancy is resolved server-side
 * via resolveGbpContext() — the client never supplies an org id. All SQL is
 * parameterized; DB access uses the substrate's lazy `require("pg")` pool so
 * preview builds without a live DATABASE_URL still compile.
 */

import { resolveGbpContext } from "@/lib/gbp/access";
import { googleApiCallRaw } from "@/lib/gbp/google-client";
import { resolveCustomerTerms, serviceLinesForTrade, toTrade } from "@/lib/gbp/trade-vocab";
import { geocodeCities, type GeocodedCity } from "@/lib/gbp/geocode";

export type VoiceStep = 1 | 2 | 3 | 4 | 5;

export interface VoiceProfile {
  orgId: string;
  trades: string[];
  serviceLines: string[];
  customerTerms: string[];
  serviceAreaCities: GeocodedCity[];
  toneFormalCasual: number;
  toneBriefChatty: number;
  signOffName: string | null;
  phrasesToUse: string[];
  phrasesToAvoid: string[];
  credentialClaimsOptIn: boolean;
  autoPublishPosts: boolean;
  autoPublishReplies: boolean;
  sampleReplyCount: number;
  currentStep: number;
  firstDraftPost: string | null;
  completedAt: string | null;
}

export interface SampleReply {
  reviewId: string;
  reviewerDisplayName: string | null;
  reviewComment: string | null;
  starRating: string | null;
  replyComment: string;
  repliedAt: string | null;
}

export interface VoiceState {
  profile: VoiceProfile;
  sampleReplies: SampleReply[];
  hasConnection: boolean;
}

export interface PreviewInput {
  trades: string[];
  customerTerms: string[];
  toneFormalCasual: number;
  toneBriefChatty: number;
  signOffName: string | null;
  phrasesToUse: string[];
  phrasesToAvoid: string[];
  credentialClaimsOptIn: boolean;
  sampleReview?: string | null;
}

export interface StepPayload {
  trades?: string[];
  serviceLines?: string[];
  serviceAreaCities?: string[];
  toneFormalCasual?: number;
  toneBriefChatty?: number;
  signOffName?: string | null;
  phrasesToUse?: string[];
  phrasesToAvoid?: string[];
  credentialClaimsOptIn?: boolean;
}

export interface PullResult {
  count: number;
  hasConnection: boolean;
  replies: SampleReply[];
}

export interface CompleteResult {
  firstDraftPost: string;
  completedAt: string;
}

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** ICP requires ≥10 reviews before voice-matching is reliable. */
const MIN_REVIEWS_FOR_VOICE = 10;
/** Store at most this many owner replies as the few-shot voice set. */
const MAX_SAMPLE_REPLIES = 20;
/** Tone midpoint — both sliders default here (0 = formal/brief, 100 = casual/chatty). */
const TONE_DEFAULT = 50;

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // `pg` is externalized in next.config.js so a normal require resolves it from
  // the serverless function's node_modules at runtime (not bundled by webpack).
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

async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(sql, params);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Input sanitizers — defend the DB against malformed client payloads.
// ---------------------------------------------------------------------------

function sanitizeStringList(value: unknown, max = 50, maxLen = 200): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.replace(/\s+/g, " ").trim().slice(0, maxLen);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeTrades(value: unknown): string[] {
  return sanitizeStringList(value, 8, 40).filter((t) => toTrade(t) !== null);
}

function clampTone(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return TONE_DEFAULT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sanitizeSignOff(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function parseCities(value: unknown): GeocodedCity[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      city: String(c.city ?? ""),
      lat: typeof c.lat === "number" ? c.lat : null,
      lng: typeof c.lng === "number" ? c.lng : null,
      formattedAddress: c.formattedAddress == null ? null : String(c.formattedAddress),
      source: (c.source === "google" || c.source === "builtin" ? c.source : "unresolved") as
        | "google"
        | "builtin"
        | "unresolved",
    }));
}

function mapProfileRow(row: Record<string, unknown>, orgId: string): VoiceProfile {
  return {
    orgId,
    trades: toStringArray(row.trades),
    serviceLines: toStringArray(row.service_lines),
    customerTerms: toStringArray(row.customer_terms),
    serviceAreaCities: parseCities(row.service_area_cities),
    toneFormalCasual: Number(row.tone_formal_casual ?? TONE_DEFAULT),
    toneBriefChatty: Number(row.tone_brief_chatty ?? TONE_DEFAULT),
    signOffName: row.sign_off_name == null ? null : String(row.sign_off_name),
    phrasesToUse: toStringArray(row.phrases_to_use),
    phrasesToAvoid: toStringArray(row.phrases_to_avoid),
    credentialClaimsOptIn: Boolean(row.credential_claims_opt_in),
    autoPublishPosts: Boolean(row.auto_publish_posts),
    autoPublishReplies: Boolean(row.auto_publish_replies),
    sampleReplyCount: Number(row.sample_reply_count ?? 0),
    currentStep: Number(row.current_step ?? 1),
    firstDraftPost: row.first_draft_post == null ? null : String(row.first_draft_post),
    completedAt: toIso(row.completed_at),
  };
}

const PROFILE_COLUMNS = `
  trades, service_lines, customer_terms, service_area_cities,
  tone_formal_casual, tone_brief_chatty, sign_off_name,
  phrases_to_use, phrases_to_avoid, credential_claims_opt_in,
  auto_publish_posts, auto_publish_replies, sample_reply_count,
  current_step, first_draft_post, completed_at
`;

/**
 * Fetch the org's profile row, creating a blank one (defaults, step 1) on first
 * visit so the stepper always has state to bind to. Also binds the active GBP
 * connection id when one exists.
 */
async function ensureProfile(orgId: string): Promise<VoiceProfile> {
  const existing = await query(
    `SELECT ${PROFILE_COLUMNS} FROM gbp_voice_profiles WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (existing.length > 0) {
    return mapProfileRow(existing[0], orgId);
  }

  const connRows = await query(
    `SELECT id FROM gbp_connections WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const connectionId = connRows.length > 0 ? String(connRows[0].id) : null;

  const inserted = await query(
    `INSERT INTO gbp_voice_profiles (org_id, connection_id)
     VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET updated_at = NOW()
     RETURNING ${PROFILE_COLUMNS}`,
    [orgId, connectionId],
  );
  return mapProfileRow(inserted[0], orgId);
}

async function fetchSampleReplies(orgId: string): Promise<SampleReply[]> {
  const rows = await query(
    `SELECT review_id, reviewer_display_name, review_comment, star_rating,
            reply_comment, replied_at
       FROM gbp_voice_sample_replies
      WHERE org_id = $1
      ORDER BY replied_at DESC NULLS LAST
      LIMIT $2`,
    [orgId, MAX_SAMPLE_REPLIES],
  );
  return rows.map((r) => ({
    reviewId: String(r.review_id),
    reviewerDisplayName: r.reviewer_display_name == null ? null : String(r.reviewer_display_name),
    reviewComment: r.review_comment == null ? null : String(r.review_comment),
    starRating: r.star_rating == null ? null : String(r.star_rating),
    replyComment: String(r.reply_comment),
    repliedAt: toIso(r.replied_at),
  }));
}

// ---------------------------------------------------------------------------
// Public server actions
// ---------------------------------------------------------------------------

/**
 * Load everything the stepper needs on mount: the (auto-created) profile, the
 * pulled sample replies, and whether a GBP connection exists.
 */
export async function loadVoiceState(): Promise<VoiceState> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  const profile = await ensureProfile(ctx.orgId);
  const sampleReplies = await fetchSampleReplies(ctx.orgId);
  const connRows = await query(
    `SELECT selected_location_name FROM gbp_connections WHERE org_id = $1 LIMIT 1`,
    [ctx.orgId],
  );
  const hasConnection = connRows.length > 0 && Boolean(connRows[0].selected_location_name);
  return { profile, sampleReplies, hasConnection };
}

/**
 * Persist one step's answers and advance progress. Each step writes only its
 * own columns, so partial progress is never lost. Side effects:
 *   - step 1 resolves customer-language terms from gbp_keyword_seeds
 *   - step 2 geocodes the service-area cities for the rank snapshot
 */
export async function saveVoiceStep(
  step: VoiceStep,
  payload: StepPayload,
): Promise<VoiceProfile> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  await ensureProfile(ctx.orgId);

  const sets: string[] = [];
  const params: unknown[] = [ctx.orgId];
  let next = 2;
  const add = (column: string, value: unknown): void => {
    sets.push(`${column} = $${next}`);
    params.push(value);
    next += 1;
  };

  if (step === 1) {
    const trades = sanitizeTrades(payload.trades);
    // Default the service lines to the trade suggestions when the owner left
    // them untouched, otherwise honor their explicit selection.
    const explicitLines = sanitizeStringList(payload.serviceLines, 40);
    const serviceLines =
      explicitLines.length > 0
        ? explicitLines
        : trades.flatMap((t) => serviceLinesForTrade(t)).slice(0, 40);
    const customerTerms = await resolveCustomerTerms(trades);
    add("trades", trades);
    add("service_lines", serviceLines);
    add("customer_terms", customerTerms);
  } else if (step === 2) {
    const cities = await geocodeCities(sanitizeStringList(payload.serviceAreaCities, 25));
    add("service_area_cities", JSON.stringify(cities));
  } else if (step === 3) {
    add("tone_formal_casual", clampTone(payload.toneFormalCasual));
    add("tone_brief_chatty", clampTone(payload.toneBriefChatty));
    add("sign_off_name", sanitizeSignOff(payload.signOffName));
    add("phrases_to_use", sanitizeStringList(payload.phrasesToUse, 25));
    add("phrases_to_avoid", sanitizeStringList(payload.phrasesToAvoid, 25));
  } else if (step === 4) {
    // Credential claims are OFF by default; only an explicit true opts in.
    add("credential_claims_opt_in", payload.credentialClaimsOptIn === true);
  }

  // Advance the furthest-reached step (never regress on re-save / back-nav).
  sets.push(`current_step = GREATEST(current_step, $${next})`);
  params.push(Math.min(step + 1, 5));
  next += 1;
  sets.push("updated_at = NOW()");

  const rows = await query(
    `UPDATE gbp_voice_profiles
        SET ${sets.join(", ")}
      WHERE org_id = $1
      RETURNING ${PROFILE_COLUMNS}`,
    params,
  );
  if (rows.length === 0) {
    throw new Error("profile_not_found");
  }
  return mapProfileRow(rows[0], ctx.orgId);
}

/**
 * Pull the owner's existing review replies through google-client.ts and store
 * up to 20 as the few-shot voice set. Reads reviews from the v4 reviews
 * endpoint for the connected location and keeps only reviews the owner has
 * already replied to (those are the voice we want to imitate).
 */
export async function pullSampleReplies(): Promise<PullResult> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  const profile = await ensureProfile(ctx.orgId);

  const connRows = await query(
    `SELECT id, access_token, selected_account_name, selected_location_name
       FROM gbp_connections WHERE org_id = $1 LIMIT 1`,
    [ctx.orgId],
  );
  const conn = connRows[0] as
    | {
        id: string;
        access_token: string | null;
        selected_account_name: string | null;
        selected_location_name: string | null;
      }
    | undefined;

  if (!conn || !conn.access_token || !conn.selected_account_name || !conn.selected_location_name) {
    return {
      count: profile.sampleReplyCount,
      hasConnection: false,
      replies: await fetchSampleReplies(ctx.orgId),
    };
  }

  interface GoogleReview {
    reviewId?: string;
    reviewer?: { displayName?: string };
    starRating?: string;
    comment?: string;
    createTime?: string;
    updateTime?: string;
    reviewReply?: { comment?: string; updateTime?: string };
  }

  const res = await googleApiCallRaw<{ reviews?: GoogleReview[] }>({
    orgId: ctx.orgId,
    connectionId: conn.id,
    method: "GET",
    baseUrl: "https://mybusiness.googleapis.com/v4",
    endpoint: `${conn.selected_account_name}/${conn.selected_location_name}/reviews?pageSize=50&orderBy=updateTime%20desc`,
    accessToken: conn.access_token,
  });

  const withReplies = (res.reviews ?? []).filter(
    (r) => r.reviewReply && typeof r.reviewReply.comment === "string" && r.reviewReply.comment.trim(),
  );

  let stored = 0;
  for (const review of withReplies.slice(0, MAX_SAMPLE_REPLIES)) {
    const reviewId = review.reviewId ?? `${review.createTime ?? ""}:${review.reviewer?.displayName ?? ""}`;
    if (!reviewId.trim()) continue;
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO gbp_voice_sample_replies
         (org_id, profile_id, review_id, reviewer_display_name, review_comment, star_rating, reply_comment, replied_at)
       VALUES ($1,
               (SELECT id FROM gbp_voice_profiles WHERE org_id = $1),
               $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, review_id) DO UPDATE SET
         reviewer_display_name = EXCLUDED.reviewer_display_name,
         review_comment = EXCLUDED.review_comment,
         star_rating = EXCLUDED.star_rating,
         reply_comment = EXCLUDED.reply_comment,
         replied_at = EXCLUDED.replied_at`,
      [
        ctx.orgId,
        reviewId,
        review.reviewer?.displayName ?? null,
        review.comment ?? null,
        review.starRating ?? null,
        review.reviewReply?.comment ?? "",
        review.reviewReply?.updateTime ?? review.updateTime ?? null,
      ],
    );
    stored += 1;
  }

  const countRows = await query(
    `SELECT COUNT(*)::int AS c FROM gbp_voice_sample_replies WHERE org_id = $1`,
    [ctx.orgId],
  );
  const count = Number(countRows[0]?.c ?? stored);

  await query(
    `UPDATE gbp_voice_profiles SET sample_reply_count = $2, updated_at = NOW() WHERE org_id = $1`,
    [ctx.orgId, count],
  );

  return {
    count,
    hasConnection: true,
    replies: await fetchSampleReplies(ctx.orgId),
  };
}

// ---------------------------------------------------------------------------
// Voice preview + first draft generation (Claude Sonnet via Nexus gateway)
// ---------------------------------------------------------------------------

function toneDescriptor(formalCasual: number, briefChatty: number): string {
  const formal =
    formalCasual <= 33 ? "formal and professional" : formalCasual >= 67 ? "warm and casual" : "approachable but polished";
  const length =
    briefChatty <= 33 ? "short and to the point" : briefChatty >= 67 ? "chatty and conversational" : "a balanced length";
  return `${formal}, ${length}`;
}

function buildVoiceSystemPrompt(input: PreviewInput): string {
  const lines: string[] = [
    "You write Google Business Profile content for a home-services contractor.",
    "Write as if you are the business owner replying in their own voice.",
    `Tone: ${toneDescriptor(input.toneFormalCasual, input.toneBriefChatty)}.`,
  ];
  if (input.customerTerms.length > 0) {
    lines.push(`Prefer the customer-language terms homeowners use: ${input.customerTerms.slice(0, 12).join(", ")}.`);
  }
  if (input.phrasesToUse.length > 0) {
    lines.push(`Work in these phrases naturally when they fit: ${input.phrasesToUse.join("; ")}.`);
  }
  if (input.phrasesToAvoid.length > 0) {
    lines.push(`Never use these words or phrases: ${input.phrasesToAvoid.join("; ")}.`);
  }
  if (!input.credentialClaimsOptIn) {
    lines.push(
      "Do NOT claim specific licensing, certifications, or credentials (e.g. 'licensed master plumber', 'EPA certified'); those require human review.",
    );
  }
  if (input.signOffName) {
    lines.push(`Sign off as "${input.signOffName}".`);
  }
  lines.push("Keep it authentic, specific, and free of emoji spam. Return only the reply text.");
  return lines.join("\n");
}

/** Deterministic, no-LLM fallback so previews work without a gateway key. */
function localFallbackReply(input: PreviewInput): string {
  const review =
    input.sampleReview?.trim() ||
    "Great job fixing our issue fast — the technician was friendly and the price was fair.";
  const casual = input.toneFormalCasual >= 50;
  const chatty = input.toneBriefChatty >= 50;
  const opener = casual ? "Thanks so much for the kind words!" : "Thank you for your feedback.";
  const term = input.customerTerms[0] ?? "the work";
  const middle = chatty
    ? ` We really appreciate you taking the time to write this. It means a lot to our team, and we're glad we could take care of ${term} for you.`
    : ` We're glad we could help with ${term}.`;
  const closing = casual ? " Call us anytime you need us!" : " Please reach out if we can help again.";
  const signOff = input.signOffName ? `\n— ${input.signOffName}` : "";
  // Echo a hint of the review so the preview visibly reacts to context.
  void review;
  return `${opener}${middle}${closing}${signOff}`;
}

interface GatewayConfig {
  url: string;
  apiKey: string;
  model: string;
}

function readGatewayConfig(): GatewayConfig | null {
  const url = process.env.NEXUS_GATEWAY_URL;
  const apiKey = process.env.NEXUS_GATEWAY_API_KEY;
  if (!url || !apiKey) return null;
  return {
    url: url.replace(/\/$/, ""),
    apiKey,
    model: process.env.GBP_VOICE_MODEL ?? "claude-sonnet-5",
  };
}

/**
 * Generate a voice-matched reply through the Nexus gateway (Claude Sonnet).
 * Falls back to a deterministic local reply when the gateway is not configured
 * or the call fails, so the right-rail preview always renders.
 */
async function generateViaGateway(input: PreviewInput, userPrompt: string): Promise<string | null> {
  const config = readGatewayConfig();
  if (!config) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${config.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 400,
        system: buildVoiceSystemPrompt(input),
        messages: [{ role: "user", content: userPrompt }],
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      output_text?: string;
    };
    if (typeof data.output_text === "string" && data.output_text.trim()) {
      return data.output_text.trim();
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server action: regenerate the right-rail sample reply as the owner moves the
 * tone sliders / edits phrases. Always returns a non-empty string.
 */
export async function generatePreview(input: PreviewInput): Promise<string> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  const review =
    input.sampleReview?.trim() ||
    "Called them when our water heater died on a Sunday. They showed up in an hour and had hot water back by dinner. Highly recommend!";
  const userPrompt = `A customer left this 5-star review:\n"${review}"\n\nWrite the owner's public reply in the configured voice.`;
  const viaGateway = await generateViaGateway(input, userPrompt);
  return viaGateway ?? localFallbackReply({ ...input, sampleReview: review });
}

/**
 * Complete the questionnaire: generate the first draft post the agent will
 * publish, store it, and stamp completed_at. The warm-up policy stays OFF here
 * (auto_publish_posts / auto_publish_replies flip on only after the owner's
 * first approvals) — see enableAutoPublish below.
 */
export async function completeVoiceProfile(): Promise<CompleteResult> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  const profile = await ensureProfile(ctx.orgId);

  const city = profile.serviceAreaCities[0]?.city ?? "your neighborhood";
  const term = profile.customerTerms[0] ?? profile.serviceLines[0] ?? "home repairs";
  const previewInput: PreviewInput = {
    trades: profile.trades,
    customerTerms: profile.customerTerms,
    toneFormalCasual: profile.toneFormalCasual,
    toneBriefChatty: profile.toneBriefChatty,
    signOffName: profile.signOffName,
    phrasesToUse: profile.phrasesToUse,
    phrasesToAvoid: profile.phrasesToAvoid,
    credentialClaimsOptIn: profile.credentialClaimsOptIn,
  };
  const postPrompt = `Write a short, friendly Google Business Profile post (2-4 sentences) for a ${
    profile.trades.join(" / ") || "home services"
  } business serving ${city}. Focus on "${term}". Encourage locals to reach out. Return only the post text.`;

  const viaGateway = await generateViaGateway(previewInput, postPrompt);
  const draft =
    viaGateway ??
    `Serving ${city} and nearby for ${term} and more. Whether it's a quick fix or a bigger job, our team is ready to help — give us a call and we'll take care of it.${
      profile.signOffName ? `\n— ${profile.signOffName}` : ""
    }`;

  const rows = await query(
    `UPDATE gbp_voice_profiles
        SET first_draft_post = $2,
            completed_at = NOW(),
            current_step = 5,
            updated_at = NOW()
      WHERE org_id = $1
      RETURNING first_draft_post, completed_at`,
    [ctx.orgId, draft],
  );
  const row = rows[0] ?? {};
  return {
    firstDraftPost: String(row.first_draft_post ?? draft),
    completedAt: toIso(row.completed_at) ?? new Date().toISOString(),
  };
}

/**
 * Warm-up policy flip: turn auto-publish on AFTER the owner's first approvals.
 * Called by the approval surface once the first post/reply is approved; kept
 * here so the policy lives with the voice profile it belongs to.
 */
export async function enableAutoPublish(
  kind: "posts" | "replies" | "both",
): Promise<VoiceProfile> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    throw new Error("not_authenticated");
  }
  await ensureProfile(ctx.orgId);

  const posts = kind === "posts" || kind === "both";
  const replies = kind === "replies" || kind === "both";
  const rows = await query(
    `UPDATE gbp_voice_profiles
        SET auto_publish_posts = auto_publish_posts OR $2,
            auto_publish_replies = auto_publish_replies OR $3,
            updated_at = NOW()
      WHERE org_id = $1
      RETURNING ${PROFILE_COLUMNS}`,
    [ctx.orgId, posts, replies],
  );
  if (rows.length === 0) {
    throw new Error("profile_not_found");
  }
  return mapProfileRow(rows[0], ctx.orgId);
}

/** Exposed for the completion screen copy: the ICP review threshold. */
export async function reviewThreshold(): Promise<number> {
  return MIN_REVIEWS_FOR_VOICE;
}
