import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@nexus/admin-console";
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
  return fallback;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return forbidden();
  }

  const { searchParams } = new URL(request.url);
  const trade = (searchParams.get("trade") ?? "all") as GbpTrade | "all";
  const season = (searchParams.get("season") ?? "all") as GbpSeason | "all";
  const active = (searchParams.get("active") ?? "all") as "all" | "active" | "inactive";
  const query = searchParams.get("query") ?? "";

  const templates = await listTemplates({ trade, season, active, query });
  return NextResponse.json({ templates });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return forbidden();
  }

  const payload = (await request.json()) as Record<string, unknown>;
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
    id: typeof payload.id === "string" ? payload.id : undefined,
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
}
