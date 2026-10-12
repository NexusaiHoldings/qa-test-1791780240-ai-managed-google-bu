import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { sendTransactionalEmail } from "@nexus/notifications";
import { getWeeklyDigestSummaryForOrg } from "@/lib/gbp/digest";
import { getDisclosureText } from "@/lib/gbp/disclosure";

type TargetRow = {
  org_id: string;
  email: string;
  user_id: string;
};

export async function GET(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const recipients = await sql<TargetRow>`
    SELECT DISTINCT ON (om.org_id)
      om.org_id::text AS org_id,
      u.email AS email,
      om.user_id::text AS user_id
    FROM org_memberships om
    JOIN users u ON u.id = om.user_id
    JOIN gbp_connections c ON c.org_id = om.org_id
    WHERE u.email IS NOT NULL
    ORDER BY om.org_id, om.created_at DESC
  `;

  let sent = 0;
  const errors: Array<{ orgId: string; message: string }> = [];

  for (const row of recipients.rows) {
    try {
      const summary = await getWeeklyDigestSummaryForOrg(row.org_id);
      const subject = "Your weekly Google Business Profile snapshot";
      const approveLink = summary.thisWeekPost?.approveUrl
        ? `${process.env.NEXT_PUBLIC_APP_URL ?? ""}${summary.thisWeekPost.approveUrl}`
        : null;

      const text = [
        "This week",
        summary.thisWeekPost?.body ?? "Your first post goes out Thursday.",
        "",
        `Reviews: ${summary.reviews.answered} answered, ${summary.reviews.waiting} waiting`,
        `Keywords: ${summary.keywords.up} up, ${summary.keywords.down} down, ${summary.keywords.flat} flat`,
        `Connection: ${summary.connection.label}`,
        approveLink ? `Approve: ${approveLink}` : "",
        "",
        getDisclosureText(),
      ]
        .filter(Boolean)
        .join("\n");

      await sendTransactionalEmail({
        to: row.email,
        subject,
        text,
      });

      sent += 1;
    } catch (error: unknown) {
      errors.push({
        orgId: row.org_id,
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    sent,
    failed: errors.length,
    errors,
  });
}
