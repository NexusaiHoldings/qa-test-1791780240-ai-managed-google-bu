/**
 * Operator Template Library — /admin/templates (F1-003).
 *
 * Two-pane editor: a filterable list of post-skeleton templates (left) with
 * trade/season chips and an active toggle, and an editor form (right) with a
 * live preview that renders a sample post from the four required slots. Keyword
 * seeds for the active filter are shown beneath so operators can see the
 * contractor-term → customer-language pairing the Local Search Forum evidence
 * insists on.
 *
 * Operator-only: the page resolves getAdminUser() and redirects non-admins to
 * "/". All mutations go through server actions that re-authorize on every call.
 */
import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAdminUser } from "@/lib/admin-auth";
import {
  ensureTemplateAndKeywordSeeds,
  listKeywordSeeds,
  listTemplates,
  normalizeSeason,
  normalizeTrade,
  renderTemplatePreview,
  toggleTemplateActive,
  upsertTemplate,
  type GbpSeason,
  type GbpTrade,
  type TemplateFilters,
} from "@/lib/gbp/templates";

export const dynamic = "force-dynamic";

const PAGE_PATH = "/admin/templates";

const TRADE_OPTIONS: { value: GbpTrade; label: string }[] = [
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "HVAC" },
  { value: "multi-trade", label: "Multi-trade" },
];

const SEASON_OPTIONS: { value: GbpSeason; label: string }[] = [
  { value: "cooling", label: "Cooling" },
  { value: "heating", label: "Heating" },
  { value: "shoulder", label: "Shoulder" },
  { value: "storm-freeze", label: "Storm/Freeze" },
];

// Example slot values used for the live preview — a locally specific sample post.
const PREVIEW_SLOTS = {
  serviceTerm: "AC repair",
  serviceCity: "Springfield",
  photoCategory: "team on the jobsite",
  ctaType: "Call now",
};

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function requireChecked(form: FormData, field: string): boolean {
  const value = form.get(field);
  return value === "on" || value === "true" || value === "1";
}

async function assertAdmin(): Promise<void> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }
}

// ── server actions ───────────────────────────────────────────────────────────

async function saveTemplateAction(formData: FormData): Promise<void> {
  "use server";
  await assertAdmin();

  const rawId = String(formData.get("id") ?? "").trim();
  await upsertTemplate({
    id: rawId.length > 0 ? rawId : undefined,
    name: String(formData.get("name") ?? ""),
    trade: normalizeTrade(String(formData.get("trade") ?? "hvac")),
    season: normalizeSeason(String(formData.get("season") ?? "heating")),
    bodyTemplate: String(formData.get("bodyTemplate") ?? ""),
    requiredServiceTerm: requireChecked(formData, "requiredServiceTerm"),
    requiredServiceCity: requireChecked(formData, "requiredServiceCity"),
    requiredPhotoCategory: requireChecked(formData, "requiredPhotoCategory"),
    requiredCtaType: requireChecked(formData, "requiredCtaType"),
    isActive: requireChecked(formData, "isActive"),
  });

  revalidatePath(PAGE_PATH);
  redirect(PAGE_PATH);
}

async function toggleTemplateAction(formData: FormData): Promise<void> {
  "use server";
  await assertAdmin();

  const id = String(formData.get("id") ?? "").trim();
  const nextActive = String(formData.get("nextActive") ?? "true") === "true";
  if (id) {
    await toggleTemplateActive(id, nextActive);
    revalidatePath(PAGE_PATH);
  }
}

async function seedLibraryAction(): Promise<void> {
  "use server";
  await assertAdmin();
  await ensureTemplateAndKeywordSeeds();
  revalidatePath(PAGE_PATH);
}

// ── rendering ─────────────────────────────────────────────────────────────────

const CHIP_STYLE: CSSProperties = {
  display: "inline-block",
  padding: "0.1rem 0.5rem",
  marginRight: "0.4rem",
  borderRadius: "999px",
  border: "1px solid currentColor",
  fontSize: "0.75rem",
  opacity: 0.85,
};

function selectHref(base: TemplateFilters, selected: string): string {
  const params = new URLSearchParams();
  if (base.trade && base.trade !== "all") params.set("trade", base.trade);
  if (base.season && base.season !== "all") params.set("season", base.season);
  if (base.active && base.active !== "all") params.set("active", base.active);
  if (base.query) params.set("query", base.query);
  params.set("selected", selected);
  return `${PAGE_PATH}?${params.toString()}`;
}

export default async function AdminTemplatesPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await assertAdmin();

  const tradeParam = firstValue(searchParams?.trade) || "all";
  const seasonParam = firstValue(searchParams?.season) || "all";
  const activeParam = firstValue(searchParams?.active) || "all";
  const query = firstValue(searchParams?.query);
  const selectedId = firstValue(searchParams?.selected);

  const filters: TemplateFilters = {
    trade: tradeParam as GbpTrade | "all",
    season: seasonParam as GbpSeason | "all",
    active: activeParam as "all" | "active" | "inactive",
    query,
  };

  const [templates, keywordSeeds] = await Promise.all([
    listTemplates(filters),
    listKeywordSeeds({ trade: filters.trade, season: filters.season }),
  ]);

  const selected =
    templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;

  const editorDefaults = selected ?? {
    id: "",
    name: "",
    trade: (tradeParam !== "all" ? tradeParam : "hvac") as GbpTrade,
    season: (seasonParam !== "all" ? seasonParam : "heating") as GbpSeason,
    bodyTemplate:
      "Serving {{service_city}} with reliable {{service_term}} this season.\n\n" +
      "Our local technicians bring the right tools and clear communication.\n\n" +
      "Photo idea: {{photo_category}}.\nAction: {{cta_type}}.",
    requiredServiceTerm: true,
    requiredServiceCity: true,
    requiredPhotoCategory: true,
    requiredCtaType: true,
    isActive: true,
  };

  const preview = renderTemplatePreview(editorDefaults.bodyTemplate, PREVIEW_SLOTS);

  return (
    <main>
      <h1>Template Library</h1>
      <p>
        Operator-managed library of post skeletons and keyword seeds by trade and season. The weekly
        post generator and keyword planner draw from these so every generated post stays locally
        specific.
      </p>

      <div className="toolbar">
        <form method="get">
          <label htmlFor="trade">Trade</label>
          <select id="trade" name="trade" defaultValue={tradeParam}>
            <option value="all">All trades</option>
            {TRADE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="season">Season</label>
          <select id="season" name="season" defaultValue={seasonParam}>
            <option value="all">All seasons</option>
            {SEASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="active">Status</label>
          <select id="active" name="active" defaultValue={activeParam}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

          <label htmlFor="query">Search</label>
          <input id="query" name="query" type="text" defaultValue={query} placeholder="Search templates" />
          <button type="submit">Search</button>
        </form>
      </div>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 24 }}>
        <div>
          <h2>Templates ({templates.length})</h2>
          {templates.length === 0 ? (
            <div className="empty">
              <p role="img" aria-label="Empty template library" style={{ fontSize: "2.5rem" }}>
                🧰
              </p>
              <p>No templates match this filter yet.</p>
              <a className="btn" href={selectHref(filters, "new")}>
                Add the first HVAC heating-season template
              </a>
              <form action={seedLibraryAction} style={{ marginTop: "1rem" }}>
                <button type="submit" className="secondary">
                  Seed starter library (trade × season templates + keyword seeds)
                </button>
              </form>
            </div>
          ) : (
            <>
              {templates.map((template) => (
                <article
                  key={template.id}
                  className="card"
                  style={{
                    marginBottom: 12,
                    outline: selected && selected.id === template.id ? "2px solid currentColor" : "none",
                  }}
                >
                  <h3 style={{ marginBottom: 4 }}>
                    <a href={selectHref(filters, template.id)}>{template.name}</a>
                  </h3>
                  <p style={{ margin: "0 0 0.5rem" }}>
                    <span style={CHIP_STYLE}>{template.trade}</span>
                    <span style={CHIP_STYLE}>{template.season}</span>
                    <span style={CHIP_STYLE}>{template.isActive ? "active" : "inactive"}</span>
                  </p>
                  <p className="muted" style={{ margin: "0 0 0.5rem" }}>
                    Requires:{" "}
                    {[
                      template.requiredServiceTerm ? "service term" : null,
                      template.requiredServiceCity ? "service-area city" : null,
                      template.requiredPhotoCategory ? "photo category" : null,
                      template.requiredCtaType ? "CTA type" : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "no required slots"}
                  </p>
                  <form action={toggleTemplateAction}>
                    <input type="hidden" name="id" value={template.id} />
                    <input type="hidden" name="nextActive" value={template.isActive ? "false" : "true"} />
                    <button type="submit" className="secondary">
                      {template.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </form>
                </article>
              ))}
              <p style={{ marginTop: "0.5rem" }}>
                <a className="btn secondary" href={selectHref(filters, "new")}>
                  + New template
                </a>
              </p>
            </>
          )}
        </div>

        <div className="card">
          <h2>{selected ? "Edit template" : "New template"}</h2>
          <p className="muted">Saved to the library (operator only). Slots keep posts locally specific.</p>
          <form action={saveTemplateAction}>
            {selected ? <input type="hidden" name="id" value={selected.id} /> : null}

            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" required defaultValue={editorDefaults.name} />

            <label htmlFor="trade-edit">Trade</label>
            <select id="trade-edit" name="trade" defaultValue={editorDefaults.trade}>
              {TRADE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor="season-edit">Season</label>
            <select id="season-edit" name="season" defaultValue={editorDefaults.season}>
              {SEASON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor="bodyTemplate">Body template</label>
            <textarea
              id="bodyTemplate"
              name="bodyTemplate"
              rows={10}
              required
              defaultValue={editorDefaults.bodyTemplate}
            />
            <p className="muted">
              Slots: <code>{"{{service_term}}"}</code>, <code>{"{{service_city}}"}</code>,{" "}
              <code>{"{{photo_category}}"}</code>, <code>{"{{cta_type}}"}</code>
            </p>

            <fieldset style={{ border: "1px solid currentColor", borderRadius: 8, padding: "0.75rem", margin: "0.5rem 0" }}>
              <legend>Required slots</legend>
              <label>
                <input type="checkbox" name="requiredServiceTerm" defaultChecked={editorDefaults.requiredServiceTerm} />{" "}
                Service term
              </label>
              <label>
                <input type="checkbox" name="requiredServiceCity" defaultChecked={editorDefaults.requiredServiceCity} />{" "}
                Service-area city
              </label>
              <label>
                <input type="checkbox" name="requiredPhotoCategory" defaultChecked={editorDefaults.requiredPhotoCategory} />{" "}
                Photo category
              </label>
              <label>
                <input type="checkbox" name="requiredCtaType" defaultChecked={editorDefaults.requiredCtaType} /> CTA type
              </label>
            </fieldset>

            <label>
              <input type="checkbox" name="isActive" defaultChecked={editorDefaults.isActive} /> Active
            </label>

            <div style={{ marginTop: "0.75rem" }}>
              <button type="submit">{selected ? "Save changes" : "Create template"}</button>
            </div>
          </form>

          <h3>Live preview</h3>
          <p className="muted">
            Sample post using example slots — service term “{PREVIEW_SLOTS.serviceTerm}”, city “
            {PREVIEW_SLOTS.serviceCity}”.
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{preview}</pre>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Keyword seeds ({keywordSeeds.length})</h2>
        <p className="muted">
          Each seed pairs a contractor term with the customer-language term — “use words like AC or
          heating system or boiler service” because not everyone knows what HVAC means.
        </p>
        {keywordSeeds.length === 0 ? (
          <div className="empty">
            <p>No keyword seeds for this filter yet.</p>
            <form action={seedLibraryAction}>
              <button type="submit" className="secondary">
                Seed starter keyword library
              </button>
            </form>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Trade</th>
                <th>Season</th>
                <th>Contractor term</th>
                <th>Customer language</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {keywordSeeds.slice(0, 60).map((seed) => (
                <tr key={seed.id}>
                  <td>{seed.trade}</td>
                  <td>{seed.season}</td>
                  <td>{seed.contractorTerm}</td>
                  <td>{seed.customerTerm}</td>
                  <td>{seed.isActive ? "active" : "inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
