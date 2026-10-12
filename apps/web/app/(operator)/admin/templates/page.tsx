import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";
import { listTemplates, renderTemplatePreview } from "@/lib/gbp/templates";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export default async function AdminTemplatesPage({ searchParams }: PageProps): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const trade = firstValue(searchParams?.trade) || "all";
  const season = firstValue(searchParams?.season) || "all";
  const active = firstValue(searchParams?.active) || "all";
  const query = firstValue(searchParams?.query);

  const templates = await listTemplates({
    trade: trade as "all" | "plumbing" | "electrical" | "hvac" | "multi-trade",
    season: season as "all" | "cooling" | "heating" | "shoulder" | "storm-freeze",
    active: active as "all" | "active" | "inactive",
    query,
  });

  const selected = templates[0];
  const preview = selected
    ? renderTemplatePreview(selected.bodyTemplate, {
        serviceTerm: "AC repair",
        serviceCity: "Springfield",
        photoCategory: "team at work",
        ctaType: "Call now",
      })
    : "";

  return (
    <main>
      <h1>Template Library</h1>
      <p>Operator-managed GBP post skeletons and keyword language seeds by trade and season.</p>

      <div className="toolbar">
        <form method="get">
          <label htmlFor="trade">Trade</label>
          <select id="trade" name="trade" defaultValue={trade}>
            <option value="all">All trades</option>
            <option value="plumbing">Plumbing</option>
            <option value="electrical">Electrical</option>
            <option value="hvac">HVAC</option>
            <option value="multi-trade">Multi-trade</option>
          </select>

          <label htmlFor="season">Season</label>
          <select id="season" name="season" defaultValue={season}>
            <option value="all">All seasons</option>
            <option value="cooling">Cooling</option>
            <option value="heating">Heating</option>
            <option value="shoulder">Shoulder</option>
            <option value="storm-freeze">Storm/Freeze</option>
          </select>

          <label htmlFor="active">Status</label>
          <select id="active" name="active" defaultValue={active}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

          <label htmlFor="query">Search</label>
          <input id="query" name="query" type="text" defaultValue={query} placeholder="Search templates" />
          <button type="submit">Search</button>
        </form>
      </div>

      {templates.length === 0 ? (
        <section className="empty">
          <p role="img" aria-label="illustration">
            🧰
          </p>
          <p>No templates match this filter.</p>
          <p className="muted">Add the first HVAC heating-season template.</p>
        </section>
      ) : (
        <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            {templates.map((template) => (
              <article key={template.id} className="card" style={{ marginBottom: 12 }}>
                <h3>{template.name}</h3>
                <p className="muted">
                  <strong>{template.trade}</strong> · <strong>{template.season}</strong> ·{" "}
                  {template.isActive ? "Active" : "Inactive"}
                </p>
                <p className="muted">Requires: service term, city, photo category, CTA</p>
              </article>
            ))}
          </div>

          <div className="card">
            <h2>Template Editor</h2>
            <p className="muted">Save to /admin/api/templates (operator only).</p>
            <form action="/admin/api/templates" method="post">
              <input type="hidden" name="action" value="upsert" />
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" defaultValue={selected?.name ?? ""} required />
              <label htmlFor="trade-edit">Trade</label>
              <select id="trade-edit" name="trade" defaultValue={selected?.trade ?? "hvac"}>
                <option value="plumbing">Plumbing</option>
                <option value="electrical">Electrical</option>
                <option value="hvac">HVAC</option>
                <option value="multi-trade">Multi-trade</option>
              </select>
              <label htmlFor="season-edit">Season</label>
              <select id="season-edit" name="season" defaultValue={selected?.season ?? "heating"}>
                <option value="cooling">Cooling</option>
                <option value="heating">Heating</option>
                <option value="shoulder">Shoulder</option>
                <option value="storm-freeze">Storm/Freeze</option>
              </select>
              <label htmlFor="bodyTemplate">Body Template</label>
              <textarea id="bodyTemplate" name="bodyTemplate" rows={10} defaultValue={selected?.bodyTemplate ?? ""} />
              <button type="submit">Save Template</button>
            </form>

            <h3>Live Preview</h3>
            <pre>{preview}</pre>
          </div>
        </section>
      )}
    </main>
  );
}
