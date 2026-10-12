import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import {
  ensureTemplateAndKeywordSeeds,
  listTemplates,
  toggleTemplateActive,
  upsertTemplate,
  type GbpSeason,
  type GbpTrade,
} from "@/lib/gbp/templates";

function forbidden(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0" || normalized === "no" || normalized === "") {
      return false;
    }
  }
  return fallback;
}

/** Parse a POST body as JSON or as form-encoded data into a plain record. */
async function readPayload(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const record: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      record[key] = typeof value === "string" ? value : value.name;
    }
    return record;
  }
  // Best-effort fallback for clients that omit a content-type header.
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return forbidden();
  }

  try {
    const { searchParams } = new URL(request.url);
    const trade = (searchParams.get("trade") ?? "all") as GbpTrade | "all";
    const season = (searchParams.get("season") ?? "all") as GbpSeason | "all";
    const active = (searchParams.get("active") ?? "all") as "all" | "active" | "inactive";
    const query = searchParams.get("query") ?? "";

    const templates = await listTemplates({ trade, season, active, query });
    return NextResponse.json({ templates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Operator-only: authorize BEFORE reading or parsing any body.
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return forbidden();
  }

  try {
    const payload = await readPayload(request);
    const action = String(payload.action ?? "upsert");

    if (action === "seed") {
      const result = await ensureTemplateAndKeywordSeeds();
      return NextResponse.json({ ok: true, seeded: result });
    }

    if (action === "toggle") {
      const id = String(payload.id ?? "");
      const isActive = asBoolean(payload.isActive, true);
      if (!id) {
        return NextResponse.json({ error: "id is required" }, { status: 400 });
      }
      await toggleTemplateActive(id, isActive);
      return NextResponse.json({ ok: true });
    }

    const saved = await upsertTemplate({
      id: typeof payload.id === "string" && payload.id.length > 0 ? payload.id : undefined,
      name: String(payload.name ?? ""),
      trade: String(payload.trade ?? "hvac") as GbpTrade,
      season: String(payload.season ?? "heating") as GbpSeason,
      bodyTemplate: String(payload.bodyTemplate ?? ""),
      requiredServiceTerm: asBoolean(payload.requiredServiceTerm, true),
      requiredServiceCity: asBoolean(payload.requiredServiceCity, true),
      requiredPhotoCategory: asBoolean(payload.requiredPhotoCategory, true),
      requiredCtaType: asBoolean(payload.requiredCtaType, true),
      isActive: asBoolean(payload.isActive, true),
    });

    return NextResponse.json({ ok: true, template: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
