import { NextResponse } from "next/server";
import { getAdminUser } from "@nexus/admin-console";
import {
  createTemplate,
  listTemplateLibrary,
  updateTemplate,
  upsertKeywordSeed,
  type TemplateCreateInput,
  type TemplateUpdateInput,
} from "@/lib/gbp/templates";

function parseBoolean(value: FormDataEntryValue | null): boolean {
  if (typeof value !== "string") return false;
  return value === "on" || value === "true" || value === "1";
}

export async function GET(request: Request): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const trade = searchParams.get("trade") ?? "";
  const season = searchParams.get("season") ?? "";
  const activeParam = searchParams.get("active");
  const active =
    activeParam === "true" ? true : activeParam === "false" ? false : undefined;

  const templates = await listTemplateLibrary({ q, trade, season, active });
  return NextResponse.json({ templates });
}

export async function POST(request: Request): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.intent === "seed-keyword") {
      await upsertKeywordSeed({
        trade: String(payload.trade ?? "multi-trade"),
        season: String(payload.season ?? "shoulder"),
        contractor_term: String(payload.contractor_term ?? ""),
        customer_term: String(payload.customer_term ?? ""),
        is_active: Boolean(payload.is_active ?? true),
      });
      return NextResponse.json({ ok: true });
    }
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "create");

  if (intent === "update") {
    const id = String(form.get("id") ?? "");
    const input: TemplateUpdateInput = {
      id,
      name: String(form.get("name") ?? "").trim(),
      trade: String(form.get("trade") ?? "").trim(),
      season: String(form.get("season") ?? "").trim(),
      body_template: String(form.get("body_template") ?? "").trim(),
      required_service_term: parseBoolean(form.get("required_service_term")),
      required_service_city: parseBoolean(form.get("required_service_city")),
      required_photo_category: parseBoolean(form.get("required_photo_category")),
      required_cta_type: parseBoolean(form.get("required_cta_type")),
      is_active: parseBoolean(form.get("is_active")),
    };
    await updateTemplate(input);
    return NextResponse.redirect(new URL("/admin/templates", request.url), 303);
  }

  const input: TemplateCreateInput = {
    name: String(form.get("name") ?? "").trim(),
    trade: String(form.get("trade") ?? "").trim(),
    season: String(form.get("season") ?? "").trim(),
    body_template: String(form.get("body_template") ?? "").trim(),
    required_service_term: parseBoolean(form.get("required_service_term")),
    required_service_city: parseBoolean(form.get("required_service_city")),
    required_photo_category: parseBoolean(form.get("required_photo_category")),
    required_cta_type: parseBoolean(form.get("required_cta_type")),
    is_active: parseBoolean(form.get("is_active")),
  };

  await createTemplate(input);
  return NextResponse.redirect(new URL("/admin/templates", request.url), 303);
}
