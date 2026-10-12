import { Pool } from "pg";
import { seedTemplateLibrary } from "./template-seed";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type TemplateRecord = {
  id: string;
  name: string;
  trade: string;
  season: string;
  body_template: string;
  required_service_term: boolean;
  required_service_city: boolean;
  required_photo_category: boolean;
  required_cta_type: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TemplateCreateInput = Omit<TemplateRecord, "id" | "created_at" | "updated_at">;
export type TemplateUpdateInput = Partial<TemplateCreateInput> & { id: string };
export type KeywordSeedInput = {
  trade: string;
  season: string;
  contractor_term: string;
  customer_term: string;
  is_active: boolean;
};

let seeded = false;

async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  await seedTemplateLibrary(pool);
  seeded = true;
}

export async function listTemplateLibrary(filters: {
  q?: string;
  trade?: string;
  season?: string;
  active?: boolean;
}): Promise<TemplateRecord[]> {
  await ensureSeeded();
  const values: unknown[] = [];
  const where: string[] = [];

  if (filters.q && filters.q.trim().length > 0) {
    values.push(`%${filters.q.trim()}%`);
    where.push(
      `(name ILIKE $${values.length} OR body_template ILIKE $${values.length})`,
    );
  }
  if (filters.trade && filters.trade.trim().length > 0) {
    values.push(filters.trade.trim());
    where.push(`trade = $${values.length}`);
  }
  if (filters.season && filters.season.trim().length > 0) {
    values.push(filters.season.trim());
    where.push(`season = $${values.length}`);
  }
  if (typeof filters.active === "boolean") {
    values.push(filters.active);
    where.push(`is_active = $${values.length}`);
  }

  const sql = `
    SELECT id, name, trade, season, body_template, required_service_term, required_service_city,
           required_photo_category, required_cta_type, is_active, created_at, updated_at
    FROM gbp_post_templates
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, created_at DESC
  `;
  const result = await pool.query<TemplateRecord>(sql, values);
  return result.rows;
}

export async function createTemplate(input: TemplateCreateInput): Promise<string> {
  await ensureSeeded();
  const result = await pool.query<{ id: string }>(
    `
    INSERT INTO gbp_post_templates (
      name, trade, season, body_template, required_service_term, required_service_city,
      required_photo_category, required_cta_type, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id
    `,
    [
      input.name,
      input.trade,
      input.season,
      input.body_template,
      input.required_service_term,
      input.required_service_city,
      input.required_photo_category,
      input.required_cta_type,
      input.is_active,
    ],
  );
  return result.rows[0].id;
}

export async function updateTemplate(input: TemplateUpdateInput): Promise<void> {
  await ensureSeeded();
  await pool.query(
    `
    UPDATE gbp_post_templates
    SET
      name = COALESCE($2, name),
      trade = COALESCE($3, trade),
      season = COALESCE($4, season),
      body_template = COALESCE($5, body_template),
      required_service_term = COALESCE($6, required_service_term),
      required_service_city = COALESCE($7, required_service_city),
      required_photo_category = COALESCE($8, required_photo_category),
      required_cta_type = COALESCE($9, required_cta_type),
      is_active = COALESCE($10, is_active),
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      input.id,
      input.name ?? null,
      input.trade ?? null,
      input.season ?? null,
      input.body_template ?? null,
      input.required_service_term ?? null,
      input.required_service_city ?? null,
      input.required_photo_category ?? null,
      input.required_cta_type ?? null,
      input.is_active ?? null,
    ],
  );
}

export async function upsertKeywordSeed(input: KeywordSeedInput): Promise<void> {
  await ensureSeeded();
  await pool.query(
    `
    INSERT INTO gbp_keyword_seeds (
      trade, season, contractor_term, customer_term, is_active
    ) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (trade, season, contractor_term, customer_term)
    DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()
    `,
    [input.trade, input.season, input.contractor_term, input.customer_term, input.is_active],
  );
}
