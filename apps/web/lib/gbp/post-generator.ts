/**
 * Weekly post generator (F1-005).
 *
 * Turns a template + voice profile + service-area city + selected owner photo
 * into a published-ready post body, then runs the variance + claims guards. A
 * failing draft is regenerated up to 3 times (4 attempts total); if it still
 * fails it is handed back for the owner queue. Voice-matched copy comes from the
 * Nexus LLM gateway (Claude Sonnet); when the gateway is unavailable (preview /
 * no env) a deterministic, compliant fallback keeps the loop working.
 *
 * This module is DB-free and side-effect-free apart from the outbound gateway
 * call — persistence + publishing live in post-publisher.ts. That keeps the
 * guard loop pure and unit-testable.
 */

import {
  buildFallbackBody,
  buildSystemPrompt,
  buildUserPrompt,
  type PostPromptInput,
  type VoiceProfile,
} from "@/lib/gbp/prompts/post";
import { runVarianceGuard, type VarianceContextPost, type VarianceResult } from "@/lib/gbp/variance-guard";
import { runClaimsGuard, type ClaimsPolicy, type ClaimsResult } from "@/lib/gbp/claims-guard";

export const MAX_REGENERATIONS = 3;

export type GbpSeason = "cooling" | "heating" | "shoulder" | "storm-freeze";

/** CTA rotation order — the guard rejects reusing the previous week's CTA. */
export const CTA_ROTATION: readonly string[] = [
  "call-now",
  "book-online",
  "request-quote",
  "learn-more",
];

export interface GenerateInput {
  trade: string;
  season: GbpSeason;
  serviceTerm: string;
  serviceCity: string;
  photoCategory: string;
  photoCaption?: string | null;
  bodyTemplate: string;
  voice: VoiceProfile;
  /** Rotate off the previous CTA; the guard enforces it too. */
  previousCtaType?: string | null;
  claimsPolicy?: ClaimsPolicy;
  locationHistory: VarianceContextPost[];
  platformThisWeek: VarianceContextPost[];
}

export interface GenerateAttempt {
  attempt: number;
  body: string;
  ctaType: string;
  variance: VarianceResult;
  claims: ClaimsResult;
  usedGateway: boolean;
  passed: boolean;
}

export interface GenerateResult {
  /** True when a compliant draft was produced within the attempt budget. */
  ok: boolean;
  body: string;
  ctaType: string;
  variance: VarianceResult;
  claims: ClaimsResult;
  attempts: GenerateAttempt[];
  regenerateCount: number;
  usedGateway: boolean;
  /** Plain-language reason for the owner queue when ok === false. */
  queueReason: string | null;
}

/** Map calendar month (0–11) to the trade season used for template selection. */
export function seasonForMonth(month: number): GbpSeason {
  // Northern-hemisphere home-services cadence.
  if (month >= 5 && month <= 8) return "cooling"; // Jun–Sep
  if (month === 11 || month === 0 || month === 1) return "storm-freeze"; // Dec–Feb
  if (month >= 2 && month <= 4) return "shoulder"; // Mar–May
  return "heating"; // Oct–Nov
}

/**
 * Choose the next CTA, rotating away from the previous week's. Deterministic
 * (no RNG) so a given (previous, attempt) pair is reproducible.
 */
export function pickCtaType(previousCtaType: string | null | undefined, attempt: number): string {
  const prevIndex = previousCtaType ? CTA_ROTATION.indexOf(previousCtaType) : -1;
  const start = prevIndex >= 0 ? prevIndex + 1 : 0;
  const index = (start + attempt) % CTA_ROTATION.length;
  const candidate = CTA_ROTATION[index];
  if (candidate === previousCtaType) {
    return CTA_ROTATION[(index + 1) % CTA_ROTATION.length];
  }
  return candidate;
}

interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Call the Nexus LLM gateway for voice-matched copy (Claude Sonnet). Returns the
 * trimmed body on success, or null on any failure / missing config so the caller
 * can fall back to deterministic copy. Never throws.
 */
export async function callGateway(system: string, user: string): Promise<string | null> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.RUNTIME_AUTH_TOKEN;
  if (!baseUrl || !token) {
    return null;
  }
  const model = process.env.NEXUS_GATEWAY_POST_MODEL ?? "claude-sonnet-5";
  const messages: GatewayMessage[] = [{ role: "user", content: user }];
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        system,
        max_tokens: 400,
        temperature: 0.7,
        messages,
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      text?: string;
    };
    if (Array.isArray(data.content)) {
      const text = data.content
        .filter((block) => block && block.type !== "tool_use")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      return text || null;
    }
    if (typeof data.text === "string" && data.text.trim()) {
      return data.text.trim();
    }
    return null;
  } catch {
    // Gateway unreachable — caller uses the deterministic fallback.
    return null;
  }
}

function sanitizeBody(raw: string): string {
  return raw
    .replace(/^["'`\s]+/, "")
    .replace(/["'`\s]+$/, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPromptInput(input: GenerateInput, ctaType: string, regenerateHint: string | null): PostPromptInput {
  return {
    trade: input.trade,
    season: input.season,
    serviceCity: input.serviceCity,
    serviceTerm: input.serviceTerm,
    photoCategory: input.photoCategory,
    photoCaption: input.photoCaption ?? null,
    ctaType,
    bodyTemplate: input.bodyTemplate,
    voice: input.voice,
    recentPostBodies: input.locationHistory.map((p) => p.body),
    regenerateHint,
  };
}

/**
 * Produce a compliant post, regenerating up to MAX_REGENERATIONS times. Each
 * attempt rotates the CTA and feeds the previous attempt's failures back into
 * the prompt as a hint so the model can self-correct.
 */
export async function generateCompliantPost(input: GenerateInput): Promise<GenerateResult> {
  const attempts: GenerateAttempt[] = [];
  const system = buildSystemPrompt(input.voice);
  let regenerateHint: string | null = null;

  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt += 1) {
    const ctaType = pickCtaType(input.previousCtaType, attempt);
    const promptInput = buildPromptInput(input, ctaType, regenerateHint);
    const userPrompt = buildUserPrompt(promptInput);

    let usedGateway = true;
    let generated = await callGateway(system, userPrompt);
    if (!generated) {
      usedGateway = false;
      generated = buildFallbackBody(promptInput);
    }
    const body = sanitizeBody(generated);

    const variance = runVarianceGuard({
      body,
      ctaType,
      serviceCity: input.serviceCity,
      locationHistory: input.locationHistory,
      platformThisWeek: input.platformThisWeek,
    });
    const claims = runClaimsGuard(body, input.claimsPolicy ?? {});
    const passed = variance.passed && claims.passed;

    attempts.push({ attempt, body, ctaType, variance, claims, usedGateway, passed });

    if (passed) {
      return {
        ok: true,
        body,
        ctaType,
        variance,
        claims,
        attempts,
        regenerateCount: attempt,
        usedGateway,
        queueReason: null,
      };
    }

    // Feed the specific failures back into the next attempt's prompt.
    const problems: string[] = [];
    for (const check of variance.checks) {
      if (!check.passed) problems.push(check.detail);
    }
    for (const violation of claims.violations) {
      problems.push(violation.message);
    }
    regenerateHint = problems.join(" ");
  }

  // Exhausted the regenerate budget — hand the best (last) attempt to the owner.
  const last = attempts[attempts.length - 1];
  const reasons: string[] = [];
  if (!last.variance.passed) reasons.push(last.variance.summary);
  if (!last.claims.passed) reasons.push(last.claims.summary);
  return {
    ok: false,
    body: last.body,
    ctaType: last.ctaType,
    variance: last.variance,
    claims: last.claims,
    attempts,
    regenerateCount: MAX_REGENERATIONS,
    usedGateway: last.usedGateway,
    queueReason: reasons.join(" ") || "Couldn't pass the content guards after several tries.",
  };
}
