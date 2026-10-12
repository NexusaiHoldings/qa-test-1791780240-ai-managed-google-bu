/**
 * Variance guard (F1-005).
 *
 * Ensures each weekly post is meaningfully different from what this location has
 * already posted AND from what every other managed location is posting this same
 * week — the core defence against Google's inauthentic / templated-content
 * enforcement. It checks:
 *
 *   1. n-gram (trigram) overlap vs the last 12 posts for THIS location,
 *   2. n-gram overlap vs ALL platform posts published this week,
 *   3. length rotation (not the same length bucket as the previous post),
 *   4. CTA rotation (not the same CTA as the previous post),
 *   5. the mandatory local slot — the service-area city MUST appear in the body.
 *
 * Pure functions (candidate + comparison corpus in → verdict out) so the
 * generator can run it inline in the regenerate loop.
 */

export interface VarianceContextPost {
  body: string;
  ctaType?: string | null;
}

export interface VarianceInput {
  body: string;
  ctaType: string;
  serviceCity: string;
  /** Last 12 posts for this location, newest first. */
  locationHistory: VarianceContextPost[];
  /** All posts from every location published/generated this week. */
  platformThisWeek: VarianceContextPost[];
}

export interface VarianceCheck {
  code: "local_overlap" | "platform_overlap" | "length_rotation" | "cta_rotation" | "local_slot";
  label: string;
  passed: boolean;
  detail: string;
}

export interface VarianceResult {
  passed: boolean;
  /** 0–100; higher = more distinct / healthier. */
  score: number;
  checks: VarianceCheck[];
  /** Max trigram overlap ratio found against the location history (0–1). */
  maxLocalOverlap: number;
  /** Max trigram overlap ratio found against the platform week (0–1). */
  maxPlatformOverlap: number;
  summary: string;
}

const LOCAL_OVERLAP_LIMIT = 0.45;
const PLATFORM_OVERLAP_LIMIT = 0.35;

function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function trigrams(tokens: string[]): Set<string> {
  const grams = new Set<string>();
  if (tokens.length < 3) {
    // Fall back to bigrams/unigrams for very short bodies so we still compare.
    for (let i = 0; i < tokens.length - 1; i += 1) {
      grams.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    for (const t of tokens) grams.add(t);
    return grams;
  }
  for (let i = 0; i <= tokens.length - 3; i += 1) {
    grams.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return grams;
}

/**
 * Jaccard-style overlap: shared trigrams / candidate trigrams. Measures how much
 * of the NEW post is recycled from an existing one.
 */
export function trigramOverlap(candidate: string, other: string): number {
  const a = trigrams(tokenize(candidate));
  const b = trigrams(tokenize(other));
  if (a.size === 0) return 0;
  let shared = 0;
  for (const g of a) {
    if (b.has(g)) shared += 1;
  }
  return shared / a.size;
}

function lengthBucket(body: string): "short" | "medium" | "long" {
  const words = tokenize(body).length;
  if (words <= 45) return "short";
  if (words <= 75) return "medium";
  return "long";
}

function maxOverlap(candidate: string, corpus: VarianceContextPost[]): number {
  let max = 0;
  for (const post of corpus) {
    const overlap = trigramOverlap(candidate, post.body ?? "");
    if (overlap > max) max = overlap;
  }
  return max;
}

/**
 * Run the full variance guard. Returns a per-check breakdown plus an aggregate
 * pass/fail and a 0–100 score for the plain-language UI.
 */
export function runVarianceGuard(input: VarianceInput): VarianceResult {
  const checks: VarianceCheck[] = [];

  const maxLocalOverlap = maxOverlap(input.body, input.locationHistory);
  const localPassed = maxLocalOverlap <= LOCAL_OVERLAP_LIMIT;
  checks.push({
    code: "local_overlap",
    label: "Different from your recent posts",
    passed: localPassed,
    detail: localPassed
      ? `Only ${(maxLocalOverlap * 100).toFixed(0)}% phrasing overlap with your last ${input.locationHistory.length} posts.`
      : `${(maxLocalOverlap * 100).toFixed(0)}% phrasing overlap with a recent post — too similar.`,
  });

  const maxPlatformOverlap = maxOverlap(input.body, input.platformThisWeek);
  const platformPassed = maxPlatformOverlap <= PLATFORM_OVERLAP_LIMIT;
  checks.push({
    code: "platform_overlap",
    label: "Different from other businesses this week",
    passed: platformPassed,
    detail: platformPassed
      ? `Only ${(maxPlatformOverlap * 100).toFixed(0)}% overlap with other posts going out this week.`
      : `${(maxPlatformOverlap * 100).toFixed(0)}% overlap with another business's post this week — looks templated.`,
  });

  const previous = input.locationHistory[0];
  const candidateBucket = lengthBucket(input.body);
  const lengthPassed = !previous || lengthBucket(previous.body ?? "") !== candidateBucket;
  checks.push({
    code: "length_rotation",
    label: "Varies length from last time",
    passed: lengthPassed,
    detail: lengthPassed
      ? `This post is ${candidateBucket}; last one was a different length.`
      : `Same length bucket (${candidateBucket}) as the previous post.`,
  });

  const prevCta = previous?.ctaType ?? null;
  const ctaPassed = !prevCta || prevCta !== input.ctaType;
  checks.push({
    code: "cta_rotation",
    label: "Rotates the call-to-action",
    passed: ctaPassed,
    detail: ctaPassed
      ? `Uses "${input.ctaType}", different from last week.`
      : `Same call-to-action ("${input.ctaType}") as last week.`,
  });

  const city = input.serviceCity.trim().toLowerCase();
  const slotPassed = city.length > 0 && input.body.toLowerCase().includes(city);
  checks.push({
    code: "local_slot",
    label: "Mentions your service-area city",
    passed: slotPassed,
    detail: slotPassed
      ? `Mentions ${input.serviceCity}.`
      : `Missing the required local mention of ${input.serviceCity || "your city"}.`,
  });

  const passedCount = checks.filter((c) => c.passed).length;
  const passed = passedCount === checks.length;
  const score = Math.round((passedCount / checks.length) * 100);
  const failed = checks.filter((c) => !c.passed);
  const summary = passed
    ? "Fresh, locally specific and rotated — not templated."
    : `Needs work: ${failed.map((c) => c.label.toLowerCase()).join(", ")}.`;

  return {
    passed,
    score,
    checks,
    maxLocalOverlap,
    maxPlatformOverlap,
    summary,
  };
}
