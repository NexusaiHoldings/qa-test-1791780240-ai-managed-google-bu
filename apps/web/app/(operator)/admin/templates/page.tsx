import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";
import { listTemplateLibrary } from "@/lib/gbp/templates";

type SearchParams = {
  q?: string;
  trade?: string;
  season?: string;
  active?: string;
};

const TRADE_OPTIONS = ["plumbing", "electrical", "hvac", "multi-trade"] as const;
const SEASON_OPTIONS = ["cooling", "heating", "shoulder", "storm/freeze"] as const;

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPreview(bodyTemplate: string): string {
  return bodyTemplate
    .replaceAll("{{service_term}}", "furnace tune-up")
    .replaceAll("{{service_city}}", "Grand Rapids")
    .replaceAll("{{photo_category}}", "team-at-work")
    .replaceAll("{{cta_type}}", "Call now for a same-week appointment");
}

export default async function AdminTemplatesPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const filters = {
    q: searchParams?.q?.trim() ?? "",
    trade: searchParams?.trade?.trim() ?? "",
    season: searchParams?.season?.trim() ?? "",
    active:
      searchParams?.active === "true"
        ? true
        : searchParams?.active === "false"
          ? false
          : undefined,
  };

  const templates = await listTemplateLibrary(filters);
  const selected = templates[0];

  return (
    <main>
      <h1>Template Library</h1>
      <p className="muted">
        Operator-managed post skeletons and keyword seeds by trade and season.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 16 }}>
        <section>
          <form className="toolbar" method="get">
            <input
              type="text"
              name="q"
              defaultValue={filters.q}
              placeholder="Search title, body, CTA, terms"
              aria-label="Search templates"
            />
            <select name="trade" defaultValue={filters.trade}>
              <option value="">All trades</option>
              {TRADE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select name="season" defaultValue={filters.season}>
              <option value="">All seasons</option>
              {SEASON_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select name="active" defaultValue={searchParams?.active ?? ""}>
              <option value="">Any status</option>
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
            </select>
            <button type="submit">Search</button>
          </form>

          {templates.length === 0 ? (
            <div className="empty">
              <p>🧰</p>
              <h2>No templates match this filter</h2>
              <p className="muted">
                Add the first HVAC heating-season template to start your library.
              </p>
              <a className="btn" href="/admin/templates">
                Clear filters
              </a>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {templates.map((template) => (
                <li key={template.id} className="card" style={{ marginBottom: 12 }}>
                  <h3 style={{ marginTop: 0 }}>{template.name}</h3>
                  <p className="muted">
                    <strong>{template.trade}</strong> · <strong>{template.season}</strong> ·{" "}
                    {template.is_active ? "Active" : "Inactive"}
                  </p>
                  <p>
                    Slots: {template.required_service_term ? "service term" : ""}{" "}
                    {template.required_service_city ? "service city" : ""}{" "}
                    {template.required_photo_category ? "photo category" : ""}{" "}
                    {template.required_cta_type ? "CTA type" : ""}
                  </p>
                  <details>
                    <summary>Body template</summary>
                    <pre>{template.body_template}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>{selected ? "Template editor" : "Create a template"}</h2>
          <p className="muted">
            Save updates through the operator API. Required slots keep posts locally specific.
          </p>

          <form action="/admin/api/templates" method="post">
            <input type="hidden" name="intent" value={selected ? "update" : "create"} />
            {selected ? <input type="hidden" name="id" value={selected.id} /> : null}

            <label htmlFor="name">Name</label>
            <input id="name" name="name" required defaultValue={selected?.name ?? ""} />

            <label htmlFor="trade">Trade</label>
            <select id="trade" name="trade" required defaultValue={selected?.trade ?? "hvac"}>
              {TRADE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <label htmlFor="season">Season</label>
            <select id="season" name="season" required defaultValue={selected?.season ?? "heating"}>
              {SEASON_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <label htmlFor="body_template">Body template</label>
            <textarea
              id="body_template"
              name="body_template"
              rows={8}
              required
              defaultValue={
                selected?.body_template ??
                "Serving {{service_city}} this week with dependable {{service_term}}. Photo: {{photo_category}}. {{cta_type}}."
              }
            />

            <fieldset>
              <legend>Required slots</legend>
              <label>
                <input
                  type="checkbox"
                  name="required_service_term"
                  defaultChecked={selected?.required_service_term ?? true}
                />
                service_term
              </label>
              <label>
                <input
                  type="checkbox"
                  name="required_service_city"
                  defaultChecked={selected?.required_service_city ?? true}
                />
                service_city
              </label>
              <label>
                <input
                  type="checkbox"
                  name="required_photo_category"
                  defaultChecked={selected?.required_photo_category ?? true}
                />
                photo_category
              </label>
              <label>
                <input
                  type="checkbox"
                  name="required_cta_type"
                  defaultChecked={selected?.required_cta_type ?? true}
                />
                cta_type
              </label>
            </fieldset>

            <label>
              <input type="checkbox" name="is_active" defaultChecked={selected?.is_active ?? true} />
              Active
            </label>

            <button type="submit">{selected ? "Save template" : "Create template"}</button>
          </form>

          <h3>Live preview</h3>
          <article className="card">
            <p
              dangerouslySetInnerHTML={{
                __html: esc(
                  renderPreview(
                    selected?.body_template ??
                      "Serving {{service_city}} this week with dependable {{service_term}}. Photo: {{photo_category}}. {{cta_type}}.",
                  ),
                ).replaceAll("\n", "<br />"),
              }}
            />
          </article>
        </section>
      </div>
    </main>
  );
}
