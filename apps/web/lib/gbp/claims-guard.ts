/**
 * Claims guard (F1-005).
 *
 * Deterministic compliance gate run on every generated post body BEFORE it can
 * be published. It directly targets Google's inauthentic-content enforcement
 * risk: a published post must NOT contain license/certificate numbers, prices,
 * guarantees/absolute promises, or fabricated specific jobs — unless the policy
 * explicitly allows a given category (e.g. the owner opted into mentioning
 * prices).
 *
 * Pure functions only (string + policy in → verdict out) so this is cheap to
 * run inline in the generator's regenerate loop and trivially unit-testable.
 */

export interface ClaimsPolicy {
  allowPrices?: boolean;
  allowGuarantees?: boolean;
  allowLicenseNumbers?: boolean;
  allowSpecificJobs?: boolean;
  /** Extra phrases the owner has pre-approved (case-insensitive substrings). */
  allowedPhrases?: string[];
}

export interface ClaimsViolation {
  code:
    | "license_number"
    | "price"
    | "guarantee"
    | "fabricated_job"
    | "contact_leak";
  message: string;
  evidence: string;
}

export interface ClaimsResult {
  passed: boolean;
  violations: ClaimsViolation[];
  /** 0–100 plain-language score surfaced on /posts/[id]. 100 = fully clean. */
  score: number;
  summary: string;
}

const LICENSE_PATTERNS: RegExp[] = [
  /\blic(?:ense)?\.?\s*#?\s*[A-Z]{0,3}\d{3,}/i,
  /\b(?:license|lic|cert|certificate|reg|registration|permit)\s*(?:no\.?|number|#)\s*[A-Z0-9-]{3,}/i,
  /\b[A-Z]{1,3}-?\d{5,}\b/,
];

const PRICE_PATTERNS: RegExp[] = [
  /\$\s?\d/,
  /\b\d+\s?(?:dollars|usd)\b/i,
  /\b\d{1,3}\s?%\s?(?:off|discount)?/i,
  /\b(?:only|just|starting at|from)\s+\$?\d/i,
];

const GUARANTEE_PATTERNS: RegExp[] = [
  /\bguarantee(?:d|s)?\b/i,
  /\b100\s?%/,
  /\bmoney[\s-]?back\b/i,
  /\b(?:#\s?1|number one|the best|unbeatable|lowest price)\b/i,
  /\b(?:always|never)\s+(?:works|fails|leaks|breaks)\b/i,
  /\brisk[\s-]?free\b/i,
];

// Patterns that suggest a fabricated specific job: a specific named customer or a
// concrete street address invented in the copy.
const SPECIFIC_JOB_PATTERNS: RegExp[] = [
  /\b\d{1,6}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Ct|Court|Way)\b/,
  /\b(?:for|helped|served)\s+(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-Z][a-z]+/,
];

const CONTACT_PATTERNS: RegExp[] = [
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, // phone numbers should come from the CTA, not the body
];

function isAllowedPhrase(evidence: string, policy: ClaimsPolicy): boolean {
  if (!policy.allowedPhrases?.length) return false;
  const lower = evidence.toLowerCase();
  return policy.allowedPhrases.some((p) => p.trim() && lower.includes(p.toLowerCase().trim()));
}

function firstMatch(body: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = body.match(pattern);
    if (m && m[0]) return m[0].trim();
  }
  return null;
}

/**
 * Run the claims guard against a post body under the given policy.
 */
export function runClaimsGuard(body: string, policy: ClaimsPolicy = {}): ClaimsResult {
  const violations: ClaimsViolation[] = [];
  const text = body ?? "";

  if (!policy.allowLicenseNumbers) {
    const hit = firstMatch(text, LICENSE_PATTERNS);
    if (hit && !isAllowedPhrase(hit, policy)) {
      violations.push({
        code: "license_number",
        message: "Looks like a license or certificate number — Google flags these in posts.",
        evidence: hit,
      });
    }
  }

  if (!policy.allowPrices) {
    const hit = firstMatch(text, PRICE_PATTERNS);
    if (hit && !isAllowedPhrase(hit, policy)) {
      violations.push({
        code: "price",
        message: "Contains a price, dollar amount or discount, which isn't allowed for this account.",
        evidence: hit,
      });
    }
  }

  if (!policy.allowGuarantees) {
    const hit = firstMatch(text, GUARANTEE_PATTERNS);
    if (hit && !isAllowedPhrase(hit, policy)) {
      violations.push({
        code: "guarantee",
        message: "Contains a guarantee or absolute claim (e.g. 'guaranteed', '#1', 'always').",
        evidence: hit,
      });
    }
  }

  if (!policy.allowSpecificJobs) {
    const hit = firstMatch(text, SPECIFIC_JOB_PATTERNS);
    if (hit && !isAllowedPhrase(hit, policy)) {
      violations.push({
        code: "fabricated_job",
        message: "Names a specific customer or address — we never fabricate specific jobs.",
        evidence: hit,
      });
    }
  }

  const contact = firstMatch(text, CONTACT_PATTERNS);
  if (contact && !isAllowedPhrase(contact, policy)) {
    violations.push({
      code: "contact_leak",
      message: "A phone number belongs in the CTA button, not the post body.",
      evidence: contact,
    });
  }

  const passed = violations.length === 0;
  // Each distinct violation costs 25 points, floored at 0.
  const score = Math.max(0, 100 - violations.length * 25);
  const summary = passed
    ? "No prices, guarantees, license numbers or fabricated jobs — safe to publish."
    : `Blocked: ${violations.map((v) => v.message).join(" ")}`;

  return { passed, violations, score, summary };
}
