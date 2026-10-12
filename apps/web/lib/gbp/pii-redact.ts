/**
 * PII redaction for Google Business Profile review text (F1-006).
 *
 * Reviewer comments can contain personal data (emails, phone numbers, street
 * addresses, card/SSN-like numbers, account/order identifiers). Per the liability
 * boundary, the raw comment is NEVER persisted and NEVER sent to the LLM gateway:
 * every review comment flows through `redactPii` FIRST, and only the redacted
 * string is stored in `gbp_reviews.comment_redacted` or forwarded to a model.
 *
 * Pure functions (string in → redacted string + structured findings out) so this
 * is cheap to run inline in the sync pipeline and trivially unit-testable.
 */

export type PiiKind =
  | "email"
  | "phone"
  | "credit_card"
  | "ssn"
  | "street_address"
  | "url"
  | "order_id";

export interface PiiFinding {
  kind: PiiKind;
  /** The redaction token substituted into the text (e.g. "[email]"). */
  token: string;
  /** Number of occurrences of this kind that were replaced. */
  count: number;
}

export interface RedactionResult {
  /** The comment with every PII span replaced by a typed token. */
  redacted: string;
  /** One entry per PII kind that was found, with occurrence counts. */
  findings: PiiFinding[];
  /** True when at least one redaction was applied. */
  hasPii: boolean;
}

interface RedactionRule {
  kind: PiiKind;
  token: string;
  pattern: RegExp;
}

// Order matters: higher-specificity patterns (card/SSN) run before the generic
// phone pattern so a 16-digit card is not partially chewed by the phone rule.
const RULES: RedactionRule[] = [
  {
    kind: "email",
    token: "[email]",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  },
  {
    kind: "url",
    token: "[link]",
    pattern: /\bhttps?:\/\/[^\s<>()]+/gi,
  },
  {
    kind: "credit_card",
    token: "[card-number]",
    // 13–16 digits, optionally grouped by spaces or dashes.
    pattern: /\b(?:\d[ -]?){13,16}\b/g,
  },
  {
    kind: "ssn",
    token: "[id-number]",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    kind: "phone",
    token: "[phone]",
    // US-style: optional +1, area code (with or without parens), separators.
    pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
  {
    kind: "street_address",
    token: "[address]",
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][A-Za-z.]*\s){0,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Dr|Drive|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway)\b\.?/gi,
  },
  {
    kind: "order_id",
    token: "[reference]",
    // Order/invoice/account/ticket references like "order #A12345" or "invoice 2024-9981".
    pattern:
      /\b(?:order|invoice|account|acct|ticket|ref(?:erence)?|confirmation|case)\s*#?\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi,
  },
];

/**
 * Redact every PII span from `text`, returning the cleaned string plus a
 * structured list of what was removed. Never throws; a nullish input yields an
 * empty result.
 */
export function redactPii(text: string | null | undefined): RedactionResult {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return { redacted: source, findings: [], hasPii: false };
  }

  let working = source;
  const findings: PiiFinding[] = [];

  for (const rule of RULES) {
    let count = 0;
    working = working.replace(rule.pattern, () => {
      count += 1;
      return rule.token;
    });
    if (count > 0) {
      findings.push({ kind: rule.kind, token: rule.token, count });
    }
  }

  // Collapse whitespace left behind by multi-token substitutions.
  const redacted = working.replace(/[ \t]{2,}/g, " ").trim();

  return { redacted, findings, hasPii: findings.length > 0 };
}

/**
 * Redact a reviewer's display name for safe UI rendering: keep the first name /
 * initial, drop any surname so the queue never shows a full personal name.
 * Anonymous reviewers collapse to "A Google user".
 */
export function redactReviewerName(
  displayName: string | null | undefined,
  isAnonymous = false,
): string {
  if (isAnonymous) return "A Google user";
  const name = (displayName ?? "").trim();
  if (!name) return "A Google user";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0]?.toUpperCase();
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

/** True when the redaction findings include any customer PII categories. */
export function containsCustomerPii(findings: PiiFinding[]): boolean {
  return findings.some((f) =>
    ["email", "phone", "credit_card", "ssn", "street_address", "order_id"].includes(f.kind),
  );
}
