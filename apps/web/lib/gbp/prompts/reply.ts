/**
 * Prompt builders for the GBP review responder (F1-006).
 *
 * Two reply modes:
 *   - voice_matched : used for LOW-sensitivity reviews. Warm, owner-voiced,
 *     personable — must read as genuinely owner-written.
 *   - neutral_safe  : used for ELEVATED/HIGH reviews that wait in the owner
 *     queue. A short, de-escalating, liability-safe acknowledgement the owner
 *     can approve, edit or discard — it admits no fault and makes no promises.
 *
 * All inputs are the ALREADY-PII-REDACTED comment. Pure functions (string in →
 * string out) with deterministic fallbacks so the pipeline works with no gateway.
 */

import type { VoiceProfile } from "@/lib/gbp/prompts/post";

export type ReplyKind = "voice_matched" | "neutral_safe";

export interface ReplyPromptInput {
  /** PII-redacted reviewer comment (may be empty for a rating-only review). */
  redactedComment: string;
  starRating: number;
  reviewerName: string;
  voice: VoiceProfile;
  kind: ReplyKind;
  /** Short note fed back on a regenerate attempt (what the previous draft got wrong). */
  regenerateHint?: string | null;
}

/** Shared compliance rails that mirror the claims/moderation gates. */
const REPLY_RAILS: string[] = [
  "HARD RULES — a reply that breaks any of these is rejected:",
  "- Never admit legal fault, negligence or liability.",
  "- Never make guarantees, promises of compensation, refunds or specific remedies.",
  "- Never state prices, dollar amounts, discounts or percentages.",
  "- Never include license, certificate or policy numbers.",
  "- Never share or ask for personal data (phone, email, address, account numbers) in public.",
  "- Never dispute the customer aggressively or call them a liar.",
  "- Keep it to 1–3 short sentences. No hashtags. At most one emoji.",
];

/** System prompt: fixes the persona as the owner and the compliance rails. */
export function buildReplySystemPrompt(voice: VoiceProfile, kind: ReplyKind): string {
  const business = voice.businessName?.trim() || "a local home-services business";
  const tone = voice.tone?.trim() || "warm, plain-spoken, gracious";
  const reading = voice.readingLevel?.trim() || "6th–8th grade";

  const lines = [
    `You reply to Google reviews as the owner of ${business}.`,
    `Write in the first person ("we"/"our team"). Tone: ${tone}. Reading level: ${reading}.`,
    "The reply must read as genuinely owner-written, never like a template or a bot.",
    "",
  ];

  if (kind === "neutral_safe") {
    lines.push(
      "This review is SENSITIVE (a dispute, a safety/legal concern, or personal data).",
      "Write a SHORT, calm, de-escalating acknowledgement only. Thank them for the feedback,",
      "say you take it seriously, and invite them to continue the conversation privately through",
      "your normal contact channel. Do NOT argue the facts, admit fault, or promise anything.",
      "",
    );
  } else {
    lines.push(
      "This review is LOW-risk. Write a genuine, personable thank-you or acknowledgement that",
      "sounds like the owner. Reference the sentiment of the review lightly; keep it specific enough",
      "to feel real but never invent details that weren't in the review.",
      "",
    );
  }

  lines.push(...REPLY_RAILS);

  if (voice.signaturePhrases?.length) {
    lines.push(`Signature phrases you may use sparingly: ${voice.signaturePhrases.join("; ")}.`);
  }
  if (voice.avoidPhrases?.length) {
    lines.push(`Avoid these phrases: ${voice.avoidPhrases.join("; ")}.`);
  }
  if (voice.sampleReplies?.length) {
    lines.push("", "Real samples of the owner's writing to match voice:");
    for (const sample of voice.sampleReplies.slice(0, 3)) {
      lines.push(`- "${sample.trim()}"`);
    }
  }

  return lines.join("\n");
}

/** User prompt: the concrete review to answer. */
export function buildReplyUserPrompt(input: ReplyPromptInput): string {
  const lines = [
    `Reply to this ${input.starRating}-star review from ${input.reviewerName}.`,
  ];
  if (input.redactedComment.trim()) {
    lines.push("", "Review text (personal details already removed):", "----", input.redactedComment.trim(), "----");
  } else {
    lines.push("", "The reviewer left a star rating with no written comment.");
  }

  if (input.kind === "neutral_safe") {
    lines.push(
      "",
      "Write a short, safe, de-escalating reply the owner can post as-is or lightly edit.",
    );
  } else {
    lines.push("", "Write a warm, concise owner reply thanking them.");
  }

  if (input.regenerateHint) {
    lines.push("", `A previous draft was rejected. Fix this: ${input.regenerateHint}`);
  }

  lines.push("", "Return ONLY the reply text — no title, no quotes, no markdown.");
  return lines.join("\n");
}

/**
 * Deterministic voice-matched fallback for LOW reviews when the gateway is
 * unavailable. Plain, gracious, claim-free.
 */
export function buildVoiceReplyFallback(input: ReplyPromptInput): string {
  const business = input.voice.businessName?.trim() || "our team";
  const name = input.reviewerName && input.reviewerName !== "A Google user" ? input.reviewerName : "";
  const greeting = name ? `Thanks so much, ${name}!` : "Thank you so much for the kind words!";
  if (input.starRating >= 4) {
    return [
      greeting,
      `It genuinely means a lot to everyone at ${business} to hear this.`,
      "We're grateful for your trust and look forward to helping again whenever you need us.",
    ].join(" ");
  }
  return [
    name ? `Thank you for the feedback, ${name}.` : "Thank you for taking the time to share this.",
    `We appreciate you letting ${business} know, and we're always working to do better.`,
    "Please feel free to reach out to us directly so we can help.",
  ].join(" ");
}

/**
 * Deterministic neutral-safe fallback for ELEVATED/HIGH reviews. De-escalating,
 * admits no fault, promises nothing, moves the conversation to a private channel.
 */
export function buildSafeReplyFallback(input: ReplyPromptInput): string {
  const business = input.voice.businessName?.trim() || "our team";
  return [
    "Thank you for taking the time to share your experience — we take this kind of feedback seriously.",
    `We'd like to understand what happened and make things right; please reach out to ${business} directly so we can talk it through.`,
  ].join(" ");
}

/** Pick the right fallback for a reply kind. */
export function buildReplyFallback(input: ReplyPromptInput): string {
  return input.kind === "neutral_safe" ? buildSafeReplyFallback(input) : buildVoiceReplyFallback(input);
}
