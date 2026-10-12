import { NextRequest, NextResponse } from "next/server";
import { handleSendNotification } from "@nexus/notifications";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import {
  getWeeklyDigestSummaryForOrg,
  currentWeekStart,
  type WeeklyDigestSummary,
} from "@/lib/gbp/digest";
import { getDisclosureHtml, getDisclosureText } from "@/lib/gbp/disclosure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PoolLike;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

type TargetRow = { org_id: string };

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ""
  ).replace(/\/+$/, "");
}

function absolute(path: string): string {
  const base = baseUrl();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Render the weekly snapshot as an email-safe HTML body. */
function renderDigestHtml(summary: WeeklyDigestSummary): string {
  const parts: string[] = ['<h2>Your week on Google</h2>'];

  const post = summary.thisWeekPost;
  if (post) {
    parts.push("<h3>This week&apos;s post</h3>");
    if (post.summary) parts.push(`<p><strong>${escapeHtml(post.summary)}</strong></p>`);
    parts.push(`<p>${escapeHtml(post.body)}</p>`);
    if (post.needsApproval) {
      parts.push(
        `<p><a href="${absolute(post.approveUrl)}">Review &amp; approve this post</a></p>`,
      );
    } else {
      parts.push(`<p><a href="${absolute(post.approveUrl)}">View this post</a></p>`);
    }
  } else {
    parts.push("<p>Your first post goes out Thursday — nothing you need to do.</p>");
  }

  parts.push(
    `<h3>Reviews</h3><p>${summary.reviews.answered} answered` +
      (summary.reviews.waiting > 0
        ? `, ${summary.reviews.waiting} waiting for a reply.</p>`
        : `, nothing waiting.</p>`),
  );

  if (summary.keywords.tracked > 0) {
    parts.push(
      `<h3>Keyword movement</h3><p>${summary.keywords.up} up, ${summary.keywords.down} down, ` +
        `${summary.keywords.flat} steady — visibility score ${summary.keywords.score}%.</p>`,
    );
  }

  parts.push(`<h3>Connection</h3><p>${escapeHtml(summary.connection.label)}.`);
  if (summary.connection.needsReconnect || summary.connection.suspended) {
    parts.push(` <a href="${absolute("/connect")}">Reconnect Google</a>.`);
  }
  parts.push("</p>");

  parts.push(getDisclosureHtml());
  return parts.join("");
}

/** Plain-text variables the notifications lego can use in non-HTML channels. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Monday weekly-digest cron.
 *
 * For every org with a GBP connection that hasn't already been sent this ISO
 * week, builds the same snapshot the dashboard shows and pushes it through
 * @nexus/notifications (in-app + email, so no owner login is required to see it)
 * with a one-tap link to approve any warm-up post that's waiting. Each delivery
 * is recorded in gbp_digest_deliveries; the UNIQUE (org_id, week_start) key makes
 * re-runs idempotent. One org failing never aborts the batch.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET` when configured.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  const db = getPool();
  const weekStart = currentWeekStart();

  const targets = await db.query(
    `SELECT DISTINCT c.org_id::text AS org_id
       FROM gbp_connections c
      WHERE c.connection_state <> 'disconnected'
      ORDER BY c.org_id`,
    [],
  );

  let sent = 0;
  let skipped = 0;
  const errors: Array<{ orgId: string; message: string }> = [];

  for (const { org_id: orgId } of targets.rows as TargetRow[]) {
    try {
      // Idempotency: skip an org already delivered this week.
      const already = await db.query(
        `SELECT 1
           FROM gbp_digest_deliveries
          WHERE org_id = $1 AND week_start = $2::date AND status = 'sent'
          LIMIT 1`,
        [orgId, weekStart],
      );
      if ((already.rowCount ?? 0) > 0) {
        skipped += 1;
        continue;
      }

      const summary = await getWeeklyDigestSummaryForOrg(orgId);
      if (!summary.owner.userId) {
        skipped += 1;
        continue;
      }

      const html = renderDigestHtml(summary);
      const result = await handleSendNotification({
        body: {
          user_id: summary.owner.userId,
          template_name: "gbp_weekly_digest",
          category: "transactional",
          html_template: html,
          to_email: summary.owner.email ?? undefined,
          variables: {
            answered: String(summary.reviews.answered),
            waiting: String(summary.reviews.waiting),
            connection: summary.connection.label,
            disclosure: getDisclosureText(),
          },
        },
        config: {
          default_channels: ["in_app", "email"],
          resend_from_email:
            process.env.EMAIL_FROM ||
            `${process.env.COMPANY_SLUG || "no-reply"}@nexusaiholdings.com`,
        },
        ctx: { db: buildDb(), events: buildEventBus() },
      });

      const delivered = result.status >= 200 && result.status < 300;

      await db.query(
        `INSERT INTO gbp_digest_deliveries
           (org_id, user_id, email, week_start, delivery_surface, status,
            post_id, post_needs_approval, reviews_waiting, error_message)
         VALUES ($1, $2, $3, $4::date, 'email', $5, $6, $7, $8, $9)
         ON CONFLICT (org_id, week_start)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           email = EXCLUDED.email,
           status = EXCLUDED.status,
           post_id = EXCLUDED.post_id,
           post_needs_approval = EXCLUDED.post_needs_approval,
           reviews_waiting = EXCLUDED.reviews_waiting,
           error_message = EXCLUDED.error_message,
           updated_at = NOW()`,
        [
          orgId,
          summary.owner.userId,
          summary.owner.email,
          weekStart,
          delivered ? "sent" : "failed",
          summary.thisWeekPost?.id ?? null,
          summary.thisWeekPost?.needsApproval ?? false,
          summary.reviews.waiting,
          delivered
            ? null
            : typeof result.body === "string"
            ? result.body
            : "notification_failed",
        ],
      );

      if (delivered) {
        sent += 1;
      } else {
        errors.push({
          orgId,
          message:
            typeof result.body === "string" ? result.body : "notification_failed",
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown_error";
      errors.push({ orgId, message });
      console.error(
        JSON.stringify({
          level: "error",
          msg: "gbp_weekly_digest_failed",
          orgId,
          weekStart,
          error: message,
        }),
      );
    }
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    scanned: targets.rowCount ?? 0,
    sent,
    skipped,
    failed: errors.length,
    errors,
  });
}
