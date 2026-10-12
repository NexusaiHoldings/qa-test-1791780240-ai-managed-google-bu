/**
 * Review sensitivity classifier (F1-006).
 *
 * Implements the liability boundary from `liability_assessor.human_in_loop_
 * required_for`: a review is routed to the owner queue whenever answering it in
 * the owner's voice could create legal/liability exposure. Categories:
 *
 *   HIGH      — injury, property damage, explicit litigation language.
 *   ELEVATED  — 1-star factual disputes over quality or pricing, customer PII in
 *               the comment, or a direct credential/licensing question.
 *   LOW       — everything else (~90% of reviews): a thank-you, a rating with no
 *               comment, a generic positive note → eligible for an auto-reply.
 *
 * The deterministic keyword classifier below is the source of truth (it must run
 * with no network and never under-classify). When the Nexus gateway (Claude
 * Haiku) is configured it is consulted as a SECOND opinion that can only RAISE
 * the level, never lower it — so a missing/offline gateway can never weaken the
 * gate. Operates on the ALREADY-PII-REDACTED comment only.
 */

import type { PiiFinding } from "@/lib/gbp/pii-redact";
import { containsCustomerPii } from "@/lib/gbp/pii-redact";

export type SensitivityLevel = "low" | "elevated" | "high";

export type SensitivityCategory =
  | "injury"
  | "property_damage"
  | "litigation"
  | "quality_dispute"
  | "pricing_dispute"
  | "customer_pii"
  | "credential_question";

export interface SensitivityReason {
  category: SensitivityCategory;
  /** One plain sentence for the "why it was flagged" line in the queue. */
  label: string;
  /** The matched phrase (from redacted text) that triggered the flag, if any. */
  evidence: string | null;
}

export interface SensitivityResult {
  level: SensitivityLevel;
  reasons: SensitivityReason[];
  /** Diagnostic detail persisted to gbp_reviews.sensitivity_detail. */
  detail: {
    starRating: number;
    hadComment: boolean;
    usedGateway: boolean;
    deterministicLevel: SensitivityLevel;
    gatewayLevel: SensitivityLevel | null;
  };
}

export interface ClassifyInput {
  /** The PII-REDACTED comment text (may be empty for rating-only reviews). */
  redactedComment: string;
  starRating: number;
  piiFindings: PiiFinding[];
}

interface CategoryRule {
  category: SensitivityCategory;
  level: SensitivityLevel;
  patterns: RegExp[];
  label: string;
  /** When true, only applies to 1-star reviews (factual quality/pricing disputes). */
  oneStarOnly?: boolean;
}

const RULES: CategoryRule[] = [
  {
    category: "injury",
    level: "high",
    label: "Mentions someone being hurt or a safety hazard — a legal matter, not an auto-reply.",
    patterns: [
      /\b(injur(?:y|ed|ies)|hurt|harmed|wounded)\b/i,
      /\b(hospital(?:ized)?|ambulance|emergency\s*room|\ber\b)\b/i,
      /\b(burn(?:ed|t|s)?|electrocut(?:ed|ion)|shocked|gas\s*leak|carbon\s*monoxide|poison(?:ed|ing)?)\b/i,
      /\b(fire|caught\s*fire|explos(?:ion|ded)|fell|slipped|tripped)\b/i,
      /\b(my\s*(?:child|kid|son|daughter|baby|family)|got\s*sick|made\s*us\s*sick)\b/i,
    ],
  },
  {
    category: "property_damage",
    level: "high",
    label: "Describes damage to the customer's property — route to the owner and possibly counsel.",
    patterns: [
      /\b(damag(?:e|ed|es|ing)|destroy(?:ed|s)?|ruin(?:ed|s)?|wreck(?:ed)?)\b/i,
      /\b(flood(?:ed|ing)?|water\s*damage|leak(?:ed|ing)?\s*(?:all\s*over|everywhere|into)|mold)\b/i,
      /\b(broke\s*my|broken\s*(?:pipe|wall|floor|ceiling)|cracked\s*(?:my|the)|busted)\b/i,
      /\b(cost\s*me\s*thousands|had\s*to\s*replace|total\s*loss)\b/i,
    ],
  },
  {
    category: "litigation",
    level: "high",
    label: "Uses legal / litigation language — do not reply without reviewing counsel guidance.",
    patterns: [
      /\b(lawyer|attorney|counsel|legal\s*action|litigat(?:e|ion)|lawsuit|sue(?:d|ing)?|suing)\b/i,
      /\b(small\s*claims|court|subpoena|liable|liabilit(?:y|ies)|negligen(?:t|ce))\b/i,
      /\b(fraud(?:ulent)?|scam(?:med)?|report(?:ing)?\s*(?:to|you)\s*(?:the\s*)?(?:bbb|state|board|licensing)|file\s*a\s*complaint)\b/i,
      /\b(breach\s*of\s*contract|consumer\s*protection|cease\s*and\s*desist)\b/i,
    ],
  },
  {
    category: "quality_dispute",
    level: "elevated",
    oneStarOnly: true,
    label: "A 1-star complaint disputing the quality of the work — answer carefully, owner reviews first.",
    patterns: [
      /\b(botched|shoddy|sloppy|poor\s*(?:quality|work(?:manship)?)|terrible\s*(?:job|work))\b/i,
      /\b(never\s*(?:fixed|finished|showed|came\s*back)|didn'?t\s*(?:fix|finish|do|complete)|incomplete|half[-\s]*(?:done|assed))\b/i,
      /\b(made\s*(?:it|things)\s*worse|still\s*(?:broken|not\s*working)|came\s*back\s*(?:broken|worse))\b/i,
    ],
  },
  {
    category: "pricing_dispute",
    level: "elevated",
    oneStarOnly: true,
    label: "A 1-star complaint disputing pricing or billing — answer carefully, owner reviews first.",
    patterns: [
      /\b(overcharg(?:ed|ing)|rip(?:ped)?[-\s]*off|gouged|price\s*gouging|hidden\s*(?:fees|charges))\b/i,
      /\b(charged\s*me|double[-\s]*charged|wouldn'?t\s*refund|no\s*refund|demand(?:ed|ing)?\s*(?:a\s*)?refund)\b/i,
      /\b(too\s*expensive|way\s*too\s*much|unfair\s*(?:price|bill|charge))\b/i,
    ],
  },
  {
    category: "credential_question",
    level: "elevated",
    label: "Raises a licensing / insurance / certification question — answer with care, owner reviews first.",
    patterns: [
      /\b(licen[cs]ed?|licen[cs]e\s*number|unlicensed)\b/i,
      /\b(insur(?:ed|ance)|uninsured|bonded|not\s*bonded)\b/i,
      /\b(certif(?:ied|ication)|credential(?:s)?|qualif(?:ied|ications)|permit(?:ted|s)?|up\s*to\s*code|code\s*violation)\b/i,
    ],
  },
];

const LEVEL_RANK: Record<SensitivityLevel, number> = { low: 0, elevated: 1, high: 2 };

function higher(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[0]) return m[0].trim();
  }
  return null;
}

/**
 * Deterministic, network-free classification. This is the authoritative gate.
 */
export function classifyDeterministic(input: ClassifyInput): {
  level: SensitivityLevel;
  reasons: SensitivityReason[];
} {
  const text = input.redactedComment ?? "";
  const reasons: SensitivityReason[] = [];
  let level: SensitivityLevel = "low";

  for (const rule of RULES) {
    if (rule.oneStarOnly && input.starRating !== 1) continue;
    const evidence = firstMatch(text, rule.patterns);
    if (evidence) {
      reasons.push({ category: rule.category, label: rule.label, evidence });
      level = higher(level, rule.level);
    }
  }

  // Customer PII in the comment is an ELEVATED trigger on its own.
  if (containsCustomerPii(input.piiFindings)) {
    reasons.push({
      category: "customer_pii",
      label: "Contains personal contact or account details — owner reviews before anything is published.",
      evidence: null,
    });
    level = higher(level, "elevated");
  }

  return { level, reasons };
}

interface GatewayVerdict {
  level: SensitivityLevel;
  reason: string | null;
}

/**
 * Optional Claude Haiku second opinion via the Nexus gateway. Returns null on any
 * missing config / failure so the deterministic verdict stands. Can only RAISE
 * the level (enforced by the caller).
 */
async function classifyWithGateway(input: ClassifyInput): Promise<GatewayVerdict | null> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.RUNTIME_AUTH_TOKEN;
  if (!baseUrl || !token) return null;
  if (!input.redactedComment.trim()) return null;

  const model = process.env.NEXUS_GATEWAY_SENSITIVITY_MODEL ?? "claude-haiku-4-5-20251001";
  const system = [
    "You are a liability triage classifier for a home-services business's Google reviews.",
    "Classify the review's sensitivity for an AUTOMATED owner-voice reply.",
    "Return STRICT JSON only: {\"level\":\"low|elevated|high\",\"reason\":\"short phrase\"}.",
    "high  = injury, property damage, or legal/litigation language.",
    "elevated = a 1-star factual dispute about quality or pricing, a licensing/insurance question, or personal data in the text.",
    "low = anything safe to answer automatically (thanks, generic praise, minor notes).",
    "When unsure between two levels, choose the HIGHER one.",
  ].join("\n");
  const user = `Star rating: ${input.starRating}/5\nReview (PII already redacted): """${input.redactedComment}"""`;

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system,
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: "user", content: user }],
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      text?: string;
    };
    const raw = Array.isArray(data.content)
      ? data.content.map((b) => b.text ?? "").join("")
      : data.text ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { level?: string; reason?: string };
    const level = parsed.level === "high" || parsed.level === "elevated" ? parsed.level : "low";
    return { level, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : null };
  } catch {
    return null;
  }
}

/**
 * Full classification: deterministic gate + optional gateway upgrade. Never
 * throws and never lowers the deterministic level.
 */
export async function classifyReviewSensitivity(input: ClassifyInput): Promise<SensitivityResult> {
  const deterministic = classifyDeterministic(input);
  let level = deterministic.level;
  const reasons = [...deterministic.reasons];

  const gateway = await classifyWithGateway(input);
  let gatewayLevel: SensitivityLevel | null = null;
  if (gateway) {
    gatewayLevel = gateway.level;
    if (LEVEL_RANK[gateway.level] > LEVEL_RANK[level]) {
      // Gateway raised the level beyond the deterministic categories — record why.
      level = gateway.level;
      reasons.push({
        category: level === "high" ? "litigation" : "quality_dispute",
        label:
          gateway.reason ??
          "Flagged by the sensitivity model as needing the owner's eyes before a reply.",
        evidence: null,
      });
    }
  }

  return {
    level,
    reasons,
    detail: {
      starRating: input.starRating,
      hadComment: Boolean(input.redactedComment.trim()),
      usedGateway: gateway !== null,
      deterministicLevel: deterministic.level,
      gatewayLevel,
    },
  };
}
