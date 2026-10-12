/**
 * Prompt builders for the weekly GBP post generator (F1-005).
 *
 * The generator calls the Nexus LLM gateway (Claude Sonnet for voice-matched
 * copy). These builders assemble the system + user messages from the trade/
 * season template, the per-location voice profile, a service-area city and the
 * selected owner photo — plus the hard guard rails (no license numbers, prices,
 * guarantees or fabricated jobs) so the model is steered toward compliant copy
 * before the deterministic guards run.
 *
 * No secrets live here; the gateway endpoint + token are read from env by the
 * generator. These functions are pure (string in / string out) so they are
 * trivially unit-testable.
 */

export interface VoiceProfile {
  businessName?: string;
  ownerName?: string;
  tone?: string;
  readingLevel?: string;
  signaturePhrases?: string[];
  avoidPhrases?: string[];
  sampleReplies?: string[];
}

export interface PostPromptInput {
  trade: string;
  season: string;
  serviceCity: string;
  serviceTerm: string;
  photoCategory: string;
  photoCaption?: string | null;
  ctaType: string;
  bodyTemplate: string;
  voice: VoiceProfile;
  /** Short excerpts of the last few posts so the model can diverge from them. */
  recentPostBodies?: string[];
  /** Optional free-form note appended on a regenerate attempt. */
  regenerateHint?: string | null;
}

const CTA_LABELS: Record<string, string> = {
  "call-now": "Call now",
  "book-online": "Book online",
  "request-quote": "Request a quote",
  "learn-more": "Learn more",
};

/** Human-friendly label for a CTA type (falls back to a title-cased slug). */
export function ctaLabel(ctaType: string): string {
  return (
    CTA_LABELS[ctaType] ??
    ctaType
      .split(/[-_\s]+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

/**
 * System prompt — fixes the persona (the owner, not a marketing agency) and the
 * non-negotiable compliance rails that mirror the claims guard.
 */
export function buildSystemPrompt(voice: VoiceProfile): string {
  const business = voice.businessName?.trim() || "a local home-services business";
  const tone = voice.tone?.trim() || "warm, plain-spoken, confident";
  const reading = voice.readingLevel?.trim() || "6th–8th grade";

  const lines = [
    `You write weekly Google Business Profile posts as the owner of ${business}.`,
    `Write in the first person ("we"/"our team"). Tone: ${tone}. Reading level: ${reading}.`,
    "The post must read as genuinely owner-written, never like ad copy or SEO filler.",
    "",
    "HARD RULES — a post that breaks any of these is rejected:",
    "- Never invent a specific customer, job, address or testimonial that didn't happen.",
    "- Never include license or certificate numbers.",
    "- Never state prices, dollar amounts, discounts or percentages.",
    "- Never make guarantees or absolute promises (no 'guaranteed', 'best', '#1', '100%', 'always', 'never fails').",
    "- Mention the real service-area city naturally, exactly once or twice.",
    "- Keep it to 2–4 short sentences (roughly 40–90 words). No hashtags. No emoji spam (at most one).",
  ];

  if (voice.signaturePhrases?.length) {
    lines.push(`Signature phrases you may use sparingly: ${voice.signaturePhrases.join("; ")}.`);
  }
  if (voice.avoidPhrases?.length) {
    lines.push(`Avoid these phrases: ${voice.avoidPhrases.join("; ")}.`);
  }
  if (voice.sampleReplies?.length) {
    lines.push("");
    lines.push("Here are real samples of the owner's writing to match voice:");
    for (const sample of voice.sampleReplies.slice(0, 3)) {
      lines.push(`- "${sample.trim()}"`);
    }
  }

  return lines.join("\n");
}

/**
 * User prompt — the concrete brief for this week's post, built from the chosen
 * template and the rotation inputs.
 */
export function buildUserPrompt(input: PostPromptInput): string {
  const lines = [
    `Write this week's post for ${input.serviceCity}.`,
    `Trade / service line: ${input.trade}.`,
    `Season / theme: ${input.season}.`,
    `Service to highlight: ${input.serviceTerm}.`,
    `Call-to-action to end on: ${ctaLabel(input.ctaType)}.`,
    "",
    "Start from this template skeleton, but rewrite it in the owner's voice so it",
    "does not read templated. Fill the slots; keep the structure loose:",
    "----",
    input.bodyTemplate,
    "----",
  ];

  if (input.photoCaption) {
    lines.push("");
    lines.push(
      `The attached photo shows: ${input.photoCaption}. You may reference it lightly (e.g. "here's a recent job").`,
    );
  } else {
    lines.push("");
    lines.push(
      `A ${input.photoCategory} photo from the owner's own uploads will be attached; you may reference it lightly.`,
    );
  }

  if (input.recentPostBodies?.length) {
    lines.push("");
    lines.push("Do NOT repeat wording from these recent posts — say something clearly different:");
    for (const body of input.recentPostBodies.slice(0, 6)) {
      lines.push(`- ${body.replace(/\s+/g, " ").trim().slice(0, 140)}`);
    }
  }

  if (input.regenerateHint) {
    lines.push("");
    lines.push(`A previous draft was rejected. Fix this: ${input.regenerateHint}`);
  }

  lines.push("");
  lines.push("Return ONLY the post body text — no title, no quotes, no markdown.");

  return lines.join("\n");
}

/**
 * Deterministic fallback copy used when the LLM gateway is unavailable (no
 * NEXUS_GATEWAY_URL / token in preview). Keeps the weekly loop functional and
 * still passes the guards: it is plainly worded, city-specific and claim-free.
 */
export function buildFallbackBody(input: PostPromptInput): string {
  const business = input.voice.businessName?.trim() || "our team";
  const city = input.serviceCity.trim() || "the area";
  const term = input.serviceTerm.trim() || input.trade;
  const seasonHints: Record<string, string> = {
    cooling: "With the warm months here,",
    heating: "As the cold sets in,",
    shoulder: "This time of year,",
    "storm-freeze": "Ahead of the next cold snap,",
  };
  const opener = seasonHints[input.season] ?? "This week,";
  return [
    `${opener} ${business} has been busy with ${term} around ${city}.`,
    `If something at home isn't working the way it should, we're glad to take a look and talk through your options.`,
    `${ctaLabel(input.ctaType)} to reach us — we're local and happy to help neighbors in ${city}.`,
  ].join(" ");
}
