/**
 * Trade & service-line vocabulary (F1-004 Voice Profile Builder).
 *
 * The questionnaire asks the owner which trade(s) and service lines they run,
 * then maps each to the customer-language terms real homeowners search for
 * (e.g. contractor-term "hydro-jetting" → customer-term "clear a clogged
 * drain"). Those customer terms are sourced from gbp_keyword_seeds — the
 * operator-curated seed table (F1-003) — so the weekly post generator and the
 * voice preview speak the homeowner's words, not the trade jargon.
 *
 * DB access uses the substrate's lazy `require("pg")` pool (same pattern as
 * apps/web/lib/gbp/templates.ts and access.ts) so preview builds without a live
 * DATABASE_URL still compile. All queries are parameterized ($1, $2, …).
 */

export type GbpTrade = "plumbing" | "electrical" | "hvac" | "multi-trade";

export interface TradeOption {
  value: GbpTrade;
  label: string;
  /** Common service lines the owner can toggle for this trade. */
  serviceLines: string[];
}

export interface TradeVocab {
  trade: GbpTrade;
  /** Distinct customer-language terms mapped from this trade's seeds. */
  customerTerms: string[];
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

async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(sql, params);
  return result.rows;
}

const TRADE_VALUES: ReadonlySet<string> = new Set([
  "plumbing",
  "electrical",
  "hvac",
  "multi-trade",
]);

/**
 * The trades and their starter service lines shown as large tap targets on
 * step 1. Service lines are suggestions the owner can keep, drop, or extend.
 */
export const TRADE_OPTIONS: readonly TradeOption[] = [
  {
    value: "plumbing",
    label: "Plumbing",
    serviceLines: [
      "Drain cleaning",
      "Water heater repair & install",
      "Leak detection",
      "Repiping",
      "Sewer line service",
      "Emergency plumbing",
    ],
  },
  {
    value: "electrical",
    label: "Electrical",
    serviceLines: [
      "Panel upgrades",
      "EV charger install",
      "Lighting & fixtures",
      "Wiring & rewiring",
      "Generator install",
      "Electrical troubleshooting",
    ],
  },
  {
    value: "hvac",
    label: "Heating & Cooling (HVAC)",
    serviceLines: [
      "AC repair",
      "AC install & replacement",
      "Furnace repair",
      "Heat pump service",
      "Tune-ups & maintenance",
      "Indoor air quality",
    ],
  },
  {
    value: "multi-trade",
    label: "Multi-trade / Home services",
    serviceLines: [
      "Plumbing",
      "Electrical",
      "Heating & cooling",
      "Handyman",
      "Remodeling",
      "Emergency service",
    ],
  },
];

/** Narrow a free string to a known GbpTrade, or null if it is not one. */
export function toTrade(value: string): GbpTrade | null {
  return TRADE_VALUES.has(value) ? (value as GbpTrade) : null;
}

/** The suggested service lines for a trade (empty for an unknown trade). */
export function serviceLinesForTrade(trade: string): string[] {
  const option = TRADE_OPTIONS.find((o) => o.value === trade);
  return option ? [...option.serviceLines] : [];
}

/**
 * Pull the distinct active customer-language terms for a single trade from
 * gbp_keyword_seeds. Ordered by the term so the preview is deterministic.
 */
export async function getCustomerTermsForTrade(
  trade: GbpTrade,
  limit = 40,
): Promise<string[]> {
  const rows = await query(
    `SELECT DISTINCT customer_term
       FROM gbp_keyword_seeds
      WHERE trade = $1 AND is_active = TRUE
      ORDER BY customer_term ASC
      LIMIT $2`,
    [trade, limit],
  );
  return rows
    .map((r) => (r.customer_term == null ? "" : String(r.customer_term).trim()))
    .filter((term) => term.length > 0);
}

/**
 * Resolve customer-language vocabulary for every selected trade. Unknown trade
 * strings are skipped. Returns one TradeVocab per recognized trade.
 */
export async function getTradeVocab(trades: readonly string[]): Promise<TradeVocab[]> {
  const recognized: GbpTrade[] = [];
  for (const t of trades) {
    const trade = toTrade(t);
    if (trade && !recognized.includes(trade)) {
      recognized.push(trade);
    }
  }

  const vocab: TradeVocab[] = [];
  for (const trade of recognized) {
    // eslint-disable-next-line no-await-in-loop
    const customerTerms = await getCustomerTermsForTrade(trade);
    vocab.push({ trade, customerTerms });
  }
  return vocab;
}

/**
 * Flatten the vocab for the selected trades into a single de-duplicated list of
 * customer-language terms, capped at `limit`. This is what gets persisted onto
 * the voice profile (customer_terms) and injected into the preview/post prompt.
 */
export async function resolveCustomerTerms(
  trades: readonly string[],
  limit = 30,
): Promise<string[]> {
  const vocab = await getTradeVocab(trades);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of vocab) {
    for (const term of entry.customerTerms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length >= limit) return terms;
    }
  }
  return terms;
}
