import { getDisclosureText } from "@/lib/gbp/disclosure";
import { getDashboardActivityFeed } from "@/lib/gbp/activity-feed";

export type WeeklyDigestPayload = {
  orgId: string;
  subject: string;
  body: string;
  approveUrl: string;
  reconnectUrl: string;
};

export async function buildWeeklyDigest(orgId: string, baseUrl: string): Promise<WeeklyDigestPayload> {
  const { sql } = await import("@/lib/db");

  const counts = await sql<{ published: string; waiting_reviews: string; warmups: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('published', 'approved') AND created_at >= date_trunc('week', NOW()))::text AS published,
      (SELECT COUNT(*)::text FROM gbp_reviews WHERE org_id = ${orgId} AND reply_status IN ('pending','queued','drafted')) AS waiting_reviews,
      (SELECT COUNT(*)::text FROM gbp_posts WHERE org_id = ${orgId} AND is_warmup = TRUE AND status IN ('scheduled','drafted')) AS warmups
    FROM gbp_posts
    WHERE org_id = ${orgId}
  `;

  const feed = await getDashboardActivityFeed(orgId, 8);
  const disclosure = await getDisclosureText();

  const published = Number(counts[0]?.published ?? 0);
  const waiting = Number(counts[0]?.waiting_reviews ?? 0);
  const warmups = Number(counts[0]?.warmups ?? 0);

  const lines = [
    `This week: ${published} posts sent, ${waiting} reviews waiting.`,
    warmups > 0 ? `Warm-up approvals waiting: ${warmups}.` : "No warm-up approvals waiting.",
    "",
    "Recent activity:",
    ...feed.map((f) => `• ${f.title}: ${f.description} — ${f.timestampLabel}`),
    "",
    disclosure,
  ];

  return {
    orgId,
    subject: "Your GBP weekly summary",
    body: lines.join("\n"),
    approveUrl: `${baseUrl}/approval`,
    reconnectUrl: `${baseUrl}/settings/gbp`,
  };
}
