/**
 * Trade Content Template Library — server-side data access (F1-003).
 *
 * Operator-managed library of GBP post skeletons and keyword-language seeds by
 * trade (plumbing / electrical / HVAC / multi-trade) and season (cooling /
 * heating / shoulder / storm-freeze). The weekly post generator and the keyword
 * planner draw from these rows.
 *
 * DB access uses the substrate's lazy `require("pg")` pool (same pattern as
 * apps/web/lib/gbp/access.ts and apps/web/lib/db.ts) so preview builds without a
 * live DATABASE_URL still compile. All queries are parameterized ($1, $2, …) —
 * never string-interpolated.
 */
import { buildKeywordSeeds, buildTemplateSeeds } from "@/lib/gbp/template-seed";

export type GbpTrade = "plumbing" | "electrical" | "hvac" | "multi-trade";
export type GbpSeason = "cooling" | "heating" | "shoulder" | "storm-freeze";
export type GbpPhotoCategory = "team" | "jobsite" | "before-after" | "equipment" | "finished-work";
export type GbpCtaType = "call-now" | "book-online" | "request-quote" | "learn-more";

export interface GbpTemplateRecord {
  id: string;
  name: string;
  trade: GbpTrade;
  season: GbpSeason;
  bodyTemplate: string;
  requiredServiceTerm: boolean;
  requiredServiceCity: boolean;
  requiredPhotoCategory: boolean;
  requiredCtaType: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GbpKeywordSeedRecord {
  id: string;
  trade: GbpTrade;
  season: GbpSeason;
  contractorTerm: string;
  customerTerm: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateFilters {
  trade?: GbpTrade | "all";
  season?: GbpSeason | "all";
  active?: "all" | "active" | "inactive";
  query?: string;
}

export interface UpsertTemplateInput {
  id?: string;
  name: string;
  trade: GbpTrade;
  season: GbpSeason;
  bodyTemplate: string;
  requiredServiceTerm: boolean;
  requiredServiceCity: boolean;
  requiredPhotoCategory: boolean;
  requiredCtaType: boolean;
  isActive: boolean;
}

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // `pg` is externalized by the substrate's next.config.js so a normal require
  // resolves it from the serverless function's node_modules at runtime.
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

const TRADE_VALUES: ReadonlySet<string> = new Set([
  "plumbing",
  "electrical",
  "hvac",
  "multi-trade",
]);
const SEASON_VALUES: ReadonlySet<string> = new Set([
  "cooling",
  "heating",
  "shoulder",
  "storm-freeze",
]);

export function normalizeTrade(value: string): GbpTrade {
  if (TRADE_VALUES.has(value)) {
    return value as GbpTrade;
  }
  throw new Error(`invalid trade: ${value}`);
}

export function normalizeSeason(value: string): GbpSeason {
  if (SEASON_VALUES.has(value)) {
    return value as GbpSeason;
  }
  throw new Error(`invalid season: ${value}`);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value == null ? "" : String(value);
}

function mapTemplateRow(row: Record<string, unknown>): GbpTemplateRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    trade: normalizeTrade(String(row.trade)),
    season: normalizeSeason(String(row.season)),
    bodyTemplate: String(row.body_template),
    requiredServiceTerm: Boolean(row.required_service_term),
    requiredServiceCity: Boolean(row.required_service_city),
    requiredPhotoCategory: Boolean(row.required_photo_category),
    requiredCtaType: Boolean(row.required_cta_type),
    isActive: Boolean(row.is_active),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

const TEMPLATE_COLUMNS = `
  id, name, trade, season, body_template,
  required_service_term, required_service_city, required_photo_category, required_cta_type,
  is_active, created_at, updated_at
`;

export async function listTemplates(filters: TemplateFilters): Promise<GbpTemplateRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let next = 1;

  const trade = filters.trade ?? "all";
  if (trade !== "all") {
    conditions.push(`trade = $${next}`);
    params.push(trade);
    next += 1;
  }

  const season = filters.season ?? "all";
  if (season !== "all") {
    conditions.push(`season = $${next}`);
    params.push(season);
    next += 1;
  }

  const active = filters.active ?? "all";
  if (active === "active") {
    conditions.push("is_active = TRUE");
  } else if (active === "inactive") {
    conditions.push("is_active = FALSE");
  }

  const search = (filters.query ?? "").trim();
  if (search) {
    conditions.push(`(name ILIKE $${next} OR body_template ILIKE $${next})`);
    params.push(`%${search}%`);
    next += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM gbp_post_templates
       ${where}
      ORDER BY is_active DESC, updated_at DESC, name ASC`,
    params,
  );
  return rows.map(mapTemplateRow);
}

export async function getTemplate(id: string): Promise<GbpTemplateRecord | null> {
  const rows = await query(
    `SELECT ${TEMPLATE_COLUMNS} FROM gbp_post_templates WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows.length > 0 ? mapTemplateRow(rows[0]) : null;
}

export async function upsertTemplate(input: UpsertTemplateInput): Promise<GbpTemplateRecord> {
  const trimmedName = input.name.trim();
  const trimmedBody = input.bodyTemplate.trim();
  if (!trimmedName) {
    throw new Error("name is required");
  }
  if (!trimmedBody) {
    throw new Error("bodyTemplate is required");
  }
  const trade = normalizeTrade(input.trade);
  const season = normalizeSeason(input.season);

  if (input.id) {
    const rows = await query(
      `UPDATE gbp_post_templates
          SET name = $1,
              trade = $2,
              season = $3,
              body_template = $4,
              required_service_term = $5,
              required_service_city = $6,
              required_photo_category = $7,
              required_cta_type = $8,
              is_active = $9,
              updated_at = NOW()
        WHERE id = $10
      RETURNING ${TEMPLATE_COLUMNS}`,
      [
        trimmedName,
        trade,
        season,
        trimmedBody,
        input.requiredServiceTerm,
        input.requiredServiceCity,
        input.requiredPhotoCategory,
        input.requiredCtaType,
        input.isActive,
        input.id,
      ],
    );
    if (rows.length === 0) {
      throw new Error("template not found");
    }
    return mapTemplateRow(rows[0]);
  }

  const rows = await query(
    `INSERT INTO gbp_post_templates (
        name, trade, season, body_template,
        required_service_term, required_service_city, required_photo_category, required_cta_type,
        is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (name) DO UPDATE SET
        trade = EXCLUDED.trade,
        season = EXCLUDED.season,
        body_template = EXCLUDED.body_template,
        required_service_term = EXCLUDED.required_service_term,
        required_service_city = EXCLUDED.required_service_city,
        required_photo_category = EXCLUDED.required_photo_category,
        required_cta_type = EXCLUDED.required_cta_type,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      trimmedName,
      trade,
      season,
      trimmedBody,
      input.requiredServiceTerm,
      input.requiredServiceCity,
      input.requiredPhotoCategory,
      input.requiredCtaType,
      input.isActive,
    ],
  );
  return mapTemplateRow(rows[0]);
}

export async function toggleTemplateActive(id: string, isActive: boolean): Promise<void> {
  await query(
    `UPDATE gbp_post_templates SET is_active = $1, updated_at = NOW() WHERE id = $2`,
    [isActive, id],
  );
}

export async function listKeywordSeeds(filters: TemplateFilters): Promise<GbpKeywordSeedRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let next = 1;

  const trade = filters.trade ?? "all";
  if (trade !== "all") {
    conditions.push(`trade = $${next}`);
    params.push(trade);
    next += 1;
  }
  const season = filters.season ?? "all";
  if (season !== "all") {
    conditions.push(`season = $${next}`);
    params.push(season);
    next += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query(
    `SELECT id, trade, season, contractor_term, customer_term, is_active, created_at, updated_at
       FROM gbp_keyword_seeds
       ${where}
      ORDER BY trade ASC, season ASC, contractor_term ASC`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    trade: normalizeTrade(String(row.trade)),
    season: normalizeSeason(String(row.season)),
    contractorTerm: String(row.contractor_term),
    customerTerm: String(row.customer_term),
    isActive: Boolean(row.is_active),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }));
}

/**
 * Idempotently seed the ~60 post templates and ~150 keyword seeds so Phase 2 has
 * a usable library on day one. Safe to re-run: ON CONFLICT keeps the library in
 * sync with the seed definitions without duplicating rows.
 */
export async function ensureTemplateAndKeywordSeeds(): Promise<{ templates: number; keywords: number }> {
  const templates = buildTemplateSeeds();
  const keywords = buildKeywordSeeds();

  for (const template of templates) {
    await query(
      `INSERT INTO gbp_post_templates (
          name, trade, season, body_template,
          required_service_term, required_service_city, required_photo_category, required_cta_type,
          is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name) DO UPDATE SET
          trade = EXCLUDED.trade,
          season = EXCLUDED.season,
          body_template = EXCLUDED.body_template,
          required_service_term = EXCLUDED.required_service_term,
          required_service_city = EXCLUDED.required_service_city,
          required_photo_category = EXCLUDED.required_photo_category,
          required_cta_type = EXCLUDED.required_cta_type,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
      [
        template.name,
        template.trade,
        template.season,
        template.bodyTemplate,
        template.requiredServiceTerm,
        template.requiredServiceCity,
        template.requiredPhotoCategory,
        template.requiredCtaType,
        template.isActive,
      ],
    );
  }

  for (const seed of keywords) {
    await query(
      `INSERT INTO gbp_keyword_seeds (trade, season, contractor_term, customer_term, is_active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trade, season, contractor_term, customer_term) DO UPDATE SET
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
      [seed.trade, seed.season, seed.contractorTerm, seed.customerTerm, seed.isActive],
    );
  }

  return { templates: templates.length, keywords: keywords.length };
}

/**
 * Render a template body into a sample post by substituting the four required
 * slots. Used by the editor's live preview so an operator sees a locally
 * specific post before saving.
 */
export function renderTemplatePreview(
  bodyTemplate: string,
  slots: { serviceTerm: string; serviceCity: string; photoCategory: string; ctaType: string },
): string {
  return bodyTemplate
    .replaceAll("{{service_term}}", slots.serviceTerm)
    .replaceAll("{{service_city}}", slots.serviceCity)
    .replaceAll("{{photo_category}}", slots.photoCategory)
    .replaceAll("{{cta_type}}", slots.ctaType);
}
