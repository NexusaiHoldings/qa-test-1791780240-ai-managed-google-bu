export type DashboardActivityItem = {
  id: string;
  title: string;
  description: string;
  occurredAt: string;
  timestampLabel: string;
};

function formatInTimeZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export async function getDashboardActivityFeed(orgId: string, limit = 20): Promise<DashboardActivityItem[]> {
  const { sql } = await import("@/lib/db");

  const rows = await sql<
    { id: string; kind: string; occurred_at: string; detail: string; status: string | null }[]
  >`
    (
      SELECT id::text AS id, 'post' AS kind, COALESCE(published_at, approved_at, created_at)::text AS occurred_at,
             LEFT(COALESCE(summary, body, ''), 160) AS detail, status
      FROM gbp_posts
      WHERE org_id = ${orgId}
    )
    UNION ALL
    (
      SELECT id::text AS id, 'review' AS kind, COALESCE(published_at, approved_at, created_at)::text AS occurred_at,
             LEFT(COALESCE(draft_reply, published_reply, comment_redacted, ''), 160) AS detail, reply_status AS status
      FROM gbp_reviews
      WHERE org_id = ${orgId}
    )
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => {
    const title = row.kind === "post" ? "Post activity" : "Review reply activity";
    const status = row.status ? ` (${row.status})` : "";
    return {
      id: `${row.kind}-${row.id}`,
      title,
      description: `${row.detail || "Updated"}${status}`,
      occurredAt: row.occurred_at,
      timestampLabel: formatInTimeZone(row.occurred_at, "America/New_York"),
    };
  });
}
