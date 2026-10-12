import type { Pool } from "pg";

const trades = ["plumbing", "electrical", "hvac", "multi-trade"];
const seasons = ["cooling", "heating", "shoulder", "storm/freeze"];

function buildTemplates(): Array<{
  name: string;
  trade: string;
  season: string;
  body_template: string;
}> {
  const rows: Array<{ name: string; trade: string; season: string; body_template: string }> = [];
  for (const trade of trades) {
    for (const season of seasons) {
      for (let i = 1; i <= 4; i += 1) {
        rows.push({
          name: `${trade} ${season} template ${i}`,
          trade,
          season,
          body_template:
            "Serving {{service_city}} with {{service_term}} this week. " +
            "Photo focus: {{photo_category}}. {{cta_type}}.",
        });
      }
    }
  }
  return rows;
}

function buildKeywordSeeds(): Array<{
  trade: string;
  season: string;
  contractor_term: string;
  customer_term: string;
}> {
  const basePairs: Array<[string, string]> = [
    ["hvac service", "ac service"],
    ["furnace maintenance", "heating system check"],
    ["boiler service", "boiler repair"],
    ["drain line inspection", "slow drain fix"],
    ["panel diagnostics", "breaker keeps tripping"],
    ["heat pump tune-up", "heat pump service"],
    ["water heater flush", "no hot water help"],
    ["duct static pressure", "weak airflow rooms"],
    ["compressor amperage check", "ac not cooling"],
    ["coil cleaning", "dirty ac coil"],
  ];
  const rows: Array<{
    trade: string;
    season: string;
    contractor_term: string;
    customer_term: string;
  }> = [];
  let idx = 0;
  while (rows.length < 150) {
    const [contractor, customer] = basePairs[idx % basePairs.length];
    rows.push({
      trade: trades[idx % trades.length],
      season: seasons[idx % seasons.length],
      contractor_term: `${contractor} ${Math.floor(idx / basePairs.length) + 1}`,
      customer_term: `${customer} ${Math.floor(idx / basePairs.length) + 1}`,
    });
    idx += 1;
  }
  return rows;
}

export async function seedTemplateLibrary(pool: Pool): Promise<void> {
  const templates = buildTemplates();
  const keywords = buildKeywordSeeds();

  for (const t of templates) {
    await pool.query(
      `
      INSERT INTO gbp_post_templates
      (name, trade, season, body_template, required_service_term, required_service_city, required_photo_category, required_cta_type, is_active)
      VALUES ($1,$2,$3,$4,true,true,true,true,true)
      ON CONFLICT (name) DO NOTHING
      `,
      [t.name, t.trade, t.season, t.body_template],
    );
  }

  for (const k of keywords) {
    await pool.query(
      `
      INSERT INTO gbp_keyword_seeds
      (trade, season, contractor_term, customer_term, is_active)
      VALUES ($1,$2,$3,$4,true)
      ON CONFLICT (trade, season, contractor_term, customer_term) DO NOTHING
      `,
      [k.trade, k.season, k.contractor_term, k.customer_term],
    );
  }
}
