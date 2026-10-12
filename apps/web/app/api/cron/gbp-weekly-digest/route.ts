import { NextResponse } from "next/server";
import { buildWeeklyDigest } from "@/lib/gbp/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NotificationClient = {
  sendTransactional: (input: {
    orgId: string;
    channel: "email" | "in_app" | "sms";
    template: string;
    subject: string;
    body: string;
    actionUrl?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
};

async function getNotifier(): Promise<NotificationClient> {
  const mod = await import("@nexus/notifications");
  return mod as unknown as NotificationClient;
}

export async function GET(): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const required = process.env.GBP_WEEKLY_DIGEST_ENABLED ?? "true";
  if (required !== "true") {
    return NextResponse.json({ ok: true, skipped: true, reason: "disabled" });
  }

  try {
    const { sql } = await import("@/lib/db");
    const orgRows = await sql<{ org_id: string }[]>`
      SELECT DISTINCT org_id
      FROM gbp_connections
      WHERE connection_state IS NOT NULL
    `;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const notifier = await getNotifier();
    let sent = 0;

    for (const row of orgRows) {
      const digest = await buildWeeklyDigest(row.org_id, baseUrl);
      await notifier.sendTransactional({
        orgId: digest.orgId,
        channel: "email",
        template: "gbp_weekly_digest",
        subject: digest.subject,
        body: digest.body,
        actionUrl: digest.approveUrl,
        metadata: {
          reconnectUrl: digest.reconnectUrl,
          cronSecretPresent: Boolean(cronSecret),
        },
      });
      sent += 1;
    }

    return NextResponse.json({ ok: true, sent });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "gbp_weekly_digest_failed", error: String(error) }));
    return NextResponse.json({ ok: false, error: "digest_failed" }, { status: 500 });
  }
}
