/**
 * FTC-driven AI-content disclosure. Exactly one sentence, shown in the dashboard
 * footer and at the bottom of every weekly digest email so the owner — and their
 * customers — always know posts and replies are machine-drafted and that the
 * owner keeps final editorial control. Kept in one place so the wording never
 * drifts between the screen and the email.
 */
export const GBP_DISCLOSURE_TEXT =
  "Posts and replies are AI-drafted on your behalf; you retain editorial control." as const;

/** The disclosure sentence for inline / footer rendering. */
export function getDisclosureText(): string {
  return GBP_DISCLOSURE_TEXT;
}

/** The disclosure wrapped in a minimal HTML paragraph for digest emails. */
export function getDisclosureHtml(): string {
  return `<p style="color:#6b7280;font-size:12px;margin-top:24px">${GBP_DISCLOSURE_TEXT}</p>`;
}
