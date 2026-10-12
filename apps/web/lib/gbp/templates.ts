import { sql } from "@vercel/postgres";
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

function normalizeTrade(value: string): GbpTrade {
  if (value === "plumbing" || value === "electrical" || value === "hvac" || value === "multi-trade") {
    return value;
  }
  throw new Error("invalid trade");
}

function normalizeSeason(value: string): GbpSeason {
  if (value === "cooling" || value === "heating" || value === "shoulder" || value === "storm-freeze") {
    return value;
  }
  throw new Error("invalid season");
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listTemplates(filters: TemplateFilters): Promise<GbpTemplateRecord[]> {
  const trade = filters.trade ?? "all";
  const season = filters.season ?? "all";
  const active = filters.active ?? "all";
  const query = (filters.query ?? "").trim();

  const result = await sql`
    SELECT
      id, name, trade, season, body_template,
      required_service_term, required_service_city, required_photo_category, required_cta_type,
      is_active, created_at, updated_at
    FROM gbp_post_templates
    WHERE (${trade} = 'all' OR trade = ${trade})
      AND (${season} = 'all' OR season = ${season})
      AND (
        ${active} = 'all'
        OR (${active} = 'active' AND is_active = TRUE)
        OR (${active} = 'inactive' AND is_active = FALSE)
      )
      AND (
        ${query} = ''
        OR name ILIKE ${`%${query}%`}
        OR body_template ILIKE ${`%${query}%`}
      )
    ORDER BY is_active DESC, updated_at DESC, name ASC
  `;
  return result.rows.map((row) => mapTemplateRow(row));
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

  if (input.id) {
    const updateResult = await sql`
      UPDATE gbp_post_templates
      SET
        name = ${trimmedName},
        trade = ${input.trade},
        season = ${input.season},
        body_template = ${trimmedBody},
        required_service_term = ${input.requiredServiceTerm},
        required_service_city = ${input.requiredServiceCity},
        required_photo_category = ${input.requiredPhotoCategory},
        required_cta_type = ${input.requiredCtaType},
        is_active = ${input.isActive},
        updated_at = NOW()
      WHERE id = ${input.id}
      RETURNING
        id, name, trade, season, body_template,
        required_service_term, required_service_city, required_photo_category, required_cta_type,
        is_active, created_at, updated_at
    `;
    if (updateResult.rows.length === 0) {
      throw new Error("template not found");
    }
    return mapTemplateRow(updateResult.rows[0]);
  }

  const insertResult = await sql`
    INSERT INTO gbp_post_templates (
      name, trade, season, body_template,
      required_service_term, required_service_city, required_photo_category, required_cta_type,
      is_active
    ) VALUES (
      ${trimmedName}, ${input.trade}, ${input.season}, ${trimmedBody},
      ${input.requiredServiceTerm}, ${input.requiredServiceCity}, ${input.requiredPhotoCategory}, ${input.requiredCtaType},
      ${input.isActive}
    )
    RETURNING
      id, name, trade, season, body_template,
      required_service_term, required_service_city, required_photo_category, required_cta_type,
      is_active, created_at, updated_at
  `;
  return mapTemplateRow(insertResult.rows[0]);
}

export async function toggleTemplateActive(id: string, isActive: boolean): Promise<void> {
  await sql`
    UPDATE gbp_post_templates
    SET is_active = ${isActive}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function ensureTemplateAndKeywordSeeds(): Promise<{ templates: number; keywords: number }> {
  const templates = buildTemplateSeeds();
  const keywords = buildKeywordSeeds();

  for (const template of templates) {
    await sql`
      INSERT INTO gbp_post_templates (
        name, trade, season, body_template,
        required_service_term, required_service_city, required_photo_category, required_cta_type,
        is_active
      ) VALUES (
        ${template.name}, ${template.trade}, ${template.season}, ${template.bodyTemplate},
        ${template.requiredServiceTerm}, ${template.requiredServiceCity}, ${template.requiredPhotoCategory}, ${template.requiredCtaType},
        ${template.isActive}
      )
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
    `;
  }

  for (const seed of keywords) {
    await sql`
      INSERT INTO gbp_keyword_seeds (trade, season, contractor_term, customer_term, is_active)
      VALUES (${seed.trade}, ${seed.season}, ${seed.contractorTerm}, ${seed.customerTerm}, ${seed.isActive})
      ON CONFLICT (trade, season, contractor_term, customer_term) DO UPDATE SET
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
    `;
  }

  return { templates: templates.length, keywords: keywords.length };
}

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
