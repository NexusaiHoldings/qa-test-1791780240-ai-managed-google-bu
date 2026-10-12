"use client";

/**
 * Voice Profile Builder — five-screen onboarding stepper (F1-004).
 *
 * The sub-15-minute questionnaire the COO flagged as the critical bottleneck.
 * One question group per screen, large tap targets for a phone in the truck, a
 * right-rail "voice preview" card that regenerates a sample reply as the tone
 * sliders move, progress saved per step (server-side), and a completion screen
 * showing the first draft post the agent will publish.
 *
 * This is a client component (the stepper, sliders and live preview are
 * interactive). All persistence + LLM work happens in server actions imported
 * from @/lib/gbp/voice-profile — the client never touches the DB or secrets.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  completeVoiceProfile,
  generatePreview,
  loadVoiceState,
  pullSampleReplies,
  saveVoiceStep,
  type SampleReply,
  type VoiceProfile,
  type VoiceStep,
} from "@/lib/gbp/voice-profile";

// Trade options are duplicated client-side (rather than imported from the
// server-only trade-vocab module, which lazy-requires `pg`) so the trade picker
// renders with its suggested service lines before the first save.
interface TradeOption {
  value: string;
  label: string;
  serviceLines: string[];
}

const TRADE_OPTIONS: readonly TradeOption[] = [
  {
    value: "plumbing",
    label: "Plumbing",
    serviceLines: [
      "Drain cleaning",
      "Water heater repair & install",
      "Leak detection",
      "Repiping",
      "Sewer line service",
      "Emergency plumbing",
    ],
  },
  {
    value: "electrical",
    label: "Electrical",
    serviceLines: [
      "Panel upgrades",
      "EV charger install",
      "Lighting & fixtures",
      "Wiring & rewiring",
      "Generator install",
      "Electrical troubleshooting",
    ],
  },
  {
    value: "hvac",
    label: "Heating & Cooling (HVAC)",
    serviceLines: [
      "AC repair",
      "AC install & replacement",
      "Furnace repair",
      "Heat pump service",
      "Tune-ups & maintenance",
      "Indoor air quality",
    ],
  },
  {
    value: "multi-trade",
    label: "Multi-trade / Home services",
    serviceLines: [
      "Plumbing",
      "Electrical",
      "Heating & cooling",
      "Handyman",
      "Remodeling",
      "Emergency service",
    ],
  },
];

const STEP_TITLES: readonly string[] = [
  "Your trade & services",
  "Where you work",
  "Your voice",
  "Credentials",
  "Sample replies & finish",
];

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function VoiceProfilePage(): JSX.Element {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [step, setStep] = useState<number>(1);
  const [done, setDone] = useState<boolean>(false);

  // Step 1 — trade & service lines
  const [trades, setTrades] = useState<string[]>([]);
  const [serviceLines, setServiceLines] = useState<string[]>([]);
  const [customLines, setCustomLines] = useState<string>("");

  // Step 2 — service-area cities
  const [citiesText, setCitiesText] = useState<string>("");

  // Step 3 — voice
  const [formalCasual, setFormalCasual] = useState<number>(50);
  const [briefChatty, setBriefChatty] = useState<number>(50);
  const [signOff, setSignOff] = useState<string>("");
  const [phrasesUse, setPhrasesUse] = useState<string>("");
  const [phrasesAvoid, setPhrasesAvoid] = useState<string>("");

  // Step 4 — credential claims (off by default)
  const [credentialOptIn, setCredentialOptIn] = useState<boolean>(false);

  // Step 5 + shared
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [sampleReplies, setSampleReplies] = useState<SampleReply[]>([]);
  const [hasConnection, setHasConnection] = useState<boolean>(false);
  const [pulling, setPulling] = useState<boolean>(false);
  const [firstDraft, setFirstDraft] = useState<string | null>(null);

  // Right-rail live voice preview
  const [preview, setPreview] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hydrate = useCallback((p: VoiceProfile): void => {
    setProfile(p);
    setTrades(p.trades);
    setServiceLines(p.serviceLines);
    setFormalCasual(p.toneFormalCasual);
    setBriefChatty(p.toneBriefChatty);
    setSignOff(p.signOffName ?? "");
    setPhrasesUse(p.phrasesToUse.join("\n"));
    setPhrasesAvoid(p.phrasesToAvoid.join("\n"));
    setCredentialOptIn(p.credentialClaimsOptIn);
    setCitiesText(p.serviceAreaCities.map((c) => c.city).join("\n"));
    setFirstDraft(p.firstDraftPost);
  }, []);

  useEffect(() => {
    let active = true;
    loadVoiceState()
      .then((state) => {
        if (!active) return;
        hydrate(state.profile);
        setSampleReplies(state.sampleReplies);
        setHasConnection(state.hasConnection);
        if (state.profile.completedAt) {
          setDone(true);
        } else {
          setStep(Math.min(Math.max(state.profile.currentStep, 1), 5));
        }
      })
      .catch(() => {
        if (active) setError("We couldn't load your profile. Please refresh or sign in again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hydrate]);

  // Debounced preview regeneration — fires whenever the voice knobs change.
  useEffect(() => {
    if (loading || done) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      setPreviewLoading(true);
      generatePreview({
        trades,
        customerTerms: profile?.customerTerms ?? [],
        toneFormalCasual: formalCasual,
        toneBriefChatty: briefChatty,
        signOffName: signOff.trim() || null,
        phrasesToUse: parseLines(phrasesUse),
        phrasesToAvoid: parseLines(phrasesAvoid),
        credentialClaimsOptIn: credentialOptIn,
      })
        .then((text) => setPreview(text))
        .catch(() => setPreview(""))
        .finally(() => setPreviewLoading(false));
    }, 600);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formalCasual, briefChatty, signOff, phrasesUse, phrasesAvoid, credentialOptIn, trades, loading, done]);

  const suggestedLines = Array.from(
    new Set(
      TRADE_OPTIONS.filter((o) => trades.includes(o.value)).flatMap((o) => o.serviceLines),
    ),
  );

  function toggleTrade(value: string): void {
    setTrades((prev) => (prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]));
  }

  function toggleServiceLine(value: string): void {
    setServiceLines((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }

  async function saveStep(current: VoiceStep): Promise<VoiceProfile | null> {
    setSaving(true);
    setError(null);
    try {
      const payload =
        current === 1
          ? {
              trades,
              serviceLines: Array.from(new Set([...serviceLines, ...parseLines(customLines)])),
            }
          : current === 2
            ? { serviceAreaCities: parseLines(citiesText) }
            : current === 3
              ? {
                  toneFormalCasual: formalCasual,
                  toneBriefChatty: briefChatty,
                  signOffName: signOff.trim() || null,
                  phrasesToUse: parseLines(phrasesUse),
                  phrasesToAvoid: parseLines(phrasesAvoid),
                }
              : current === 4
                ? { credentialClaimsOptIn: credentialOptIn }
                : {};
      const updated = await saveVoiceStep(current, payload);
      setProfile(updated);
      return updated;
    } catch {
      setError("Saving failed. Your previous steps are still saved — please try again.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleNext(): Promise<void> {
    const saved = await saveStep(step as VoiceStep);
    if (!saved) return;
    if (step === 2 && saved.serviceAreaCities.length > 0) {
      setCitiesText(saved.serviceAreaCities.map((c) => c.city).join("\n"));
    }
    setStep((s) => Math.min(s + 1, 5));
  }

  function handleBack(): void {
    setError(null);
    setStep((s) => Math.max(s - 1, 1));
  }

  async function handlePullReplies(): Promise<void> {
    setPulling(true);
    setError(null);
    try {
      const result = await pullSampleReplies();
      setSampleReplies(result.replies);
      setHasConnection(result.hasConnection);
      if (profile) setProfile({ ...profile, sampleReplyCount: result.count });
    } catch {
      setError("We couldn't pull your review replies. You can finish setup and add them later.");
    } finally {
      setPulling(false);
    }
  }

  async function handleFinish(): Promise<void> {
    const saved = await saveStep(5);
    if (saved === null) return;
    setSaving(true);
    try {
      const result = await completeVoiceProfile();
      setFirstDraft(result.firstDraftPost);
      setDone(true);
    } catch {
      setError("We couldn't generate your first post. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main>
        <h1>Voice Profile</h1>
        <p className="muted">Loading your setup…</p>
      </main>
    );
  }

  if (done) {
    return (
      <main>
        <h1>You&rsquo;re all set 🎉</h1>
        <p className="muted">
          Your voice profile is saved. Here&rsquo;s the first post your assistant will publish for
          you.
        </p>
        <div className="card">
          <h2>First draft post</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{firstDraft ?? "Your first post is being prepared."}</p>
        </div>
        <div className="card">
          <h3>What happens next</h3>
          <ul>
            <li>
              We stored <strong>{profile?.sampleReplyCount ?? 0}</strong> of your past review
              replies to match your voice.
            </li>
            <li>
              Auto-publishing stays <strong>off</strong> until you approve your first post and
              reply. After those first approvals it switches on, so you can stay hands-off.
            </li>
            <li>You can edit any answer anytime from this page.</li>
          </ul>
          <a className="btn" href="/">
            Go to dashboard
          </a>{" "}
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              setDone(false);
              setStep(1);
            }}
          >
            Review my answers
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Voice Profile</h1>
      <p className="muted">
        Takes about 15 minutes. We save each step as you go — finish on your phone between jobs.
      </p>

      <ol className="toolbar" aria-label="Progress">
        {STEP_TITLES.map((title, idx) => {
          const n = idx + 1;
          return (
            <li key={title} className={n === step ? undefined : "muted"}>
              {n < step ? "✓ " : ""}
              <strong>
                {n}. {title}
              </strong>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="card" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}>
        <section style={{ flex: "2 1 20rem", minWidth: "min(100%, 20rem)" }}>
          {step === 1 && (
            <div className="card">
              <h2>What trade are you in?</h2>
              <p className="muted">Pick everything that applies. We&rsquo;ll match your words to what customers search.</p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {TRADE_OPTIONS.map((opt) => (
                  <li key={opt.value} className="card" style={{ marginBottom: "0.5rem" }}>
                    <label style={{ display: "block", padding: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={trades.includes(opt.value)}
                        onChange={() => toggleTrade(opt.value)}
                      />{" "}
                      <strong>{opt.label}</strong>
                    </label>
                  </li>
                ))}
              </ul>

              {suggestedLines.length > 0 && (
                <>
                  <h3>Which services do you offer?</h3>
                  <ul style={{ listStyle: "none", padding: 0 }}>
                    {suggestedLines.map((line) => (
                      <li key={line}>
                        <label style={{ display: "block", padding: "0.35rem 0" }}>
                          <input
                            type="checkbox"
                            checked={serviceLines.includes(line)}
                            onChange={() => toggleServiceLine(line)}
                          />{" "}
                          {line}
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <label htmlFor="customLines">Anything else you do? (one per line)</label>
              <textarea
                id="customLines"
                rows={3}
                value={customLines}
                onChange={(e) => setCustomLines(e.target.value)}
                placeholder={"Tankless water heaters\nBackflow testing"}
              />
            </div>
          )}

          {step === 2 && (
            <div className="card">
              <h2>Where do you work?</h2>
              <p className="muted">
                List the cities and towns you serve, one per line. We map them so we can track where
                you rank.
              </p>
              <label htmlFor="cities">Service-area cities</label>
              <textarea
                id="cities"
                rows={6}
                value={citiesText}
                onChange={(e) => setCitiesText(e.target.value)}
                placeholder={"Phoenix\nMesa\nScottsdale"}
              />
              {profile && profile.serviceAreaCities.length > 0 && (
                <p className="muted">
                  Mapped: {profile.serviceAreaCities.filter((c) => c.lat !== null).length} of{" "}
                  {profile.serviceAreaCities.length} cities located.
                </p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="card">
              <h2>How should you sound?</h2>
              <p className="muted">Slide to match your style. The preview on the right updates live.</p>

              <label htmlFor="formalCasual">
                Formal ↔ Casual: <strong>{formalCasual}</strong>
              </label>
              <input
                id="formalCasual"
                type="range"
                min={0}
                max={100}
                step={1}
                value={formalCasual}
                onChange={(e) => setFormalCasual(Number(e.target.value))}
                style={{ width: "100%" }}
              />

              <label htmlFor="briefChatty">
                Brief ↔ Chatty: <strong>{briefChatty}</strong>
              </label>
              <input
                id="briefChatty"
                type="range"
                min={0}
                max={100}
                step={1}
                value={briefChatty}
                onChange={(e) => setBriefChatty(Number(e.target.value))}
                style={{ width: "100%" }}
              />

              <label htmlFor="signOff">Sign off replies as</label>
              <input
                id="signOff"
                type="text"
                value={signOff}
                onChange={(e) => setSignOff(e.target.value)}
                placeholder="Dave & the team"
              />

              <label htmlFor="phrasesUse">Phrases you like to use (one per line)</label>
              <textarea
                id="phrasesUse"
                rows={3}
                value={phrasesUse}
                onChange={(e) => setPhrasesUse(e.target.value)}
                placeholder={"Thanks for trusting us\nWe’ve got you covered"}
              />

              <label htmlFor="phrasesAvoid">Words to avoid (one per line)</label>
              <textarea
                id="phrasesAvoid"
                rows={3}
                value={phrasesAvoid}
                onChange={(e) => setPhrasesAvoid(e.target.value)}
                placeholder={"cheap\nguarantee"}
              />
            </div>
          )}

          {step === 4 && (
            <div className="card">
              <h2>Mentioning licenses & credentials</h2>
              <p className="muted">
                Posts that claim specific licensing or certifications need a human review before they
                go live, so this is off by default.
              </p>
              <label style={{ display: "block", padding: "0.5rem 0" }}>
                <input
                  type="checkbox"
                  checked={credentialOptIn}
                  onChange={(e) => setCredentialOptIn(e.target.checked)}
                />{" "}
                <strong>Allow my posts to mention specific licenses or certifications</strong>
              </label>
              <p className="muted">
                {credentialOptIn
                  ? "We'll still route any post that names a specific credential for your approval before publishing."
                  : "Recommended. Your posts will highlight experience and quality without naming specific credentials."}
              </p>
            </div>
          )}

          {step === 5 && (
            <div className="card">
              <h2>Match your real voice</h2>
              <p className="muted">
                We can learn from the replies you&rsquo;ve already written on Google. We&rsquo;ll keep up
                to 20 as examples (works best with 10+ reviews).
              </p>
              {hasConnection ? (
                <button type="button" onClick={handlePullReplies} disabled={pulling}>
                  {pulling ? "Pulling your replies…" : "Pull my past review replies"}
                </button>
              ) : (
                <p>
                  Connect your Google Business Profile to import past replies.{" "}
                  <a href="/connect">Connect now</a> — or skip and finish; you can add them later.
                </p>
              )}

              {sampleReplies.length > 0 ? (
                <>
                  <p className="muted">
                    Imported {sampleReplies.length} repl{sampleReplies.length === 1 ? "y" : "ies"} to
                    learn from:
                  </p>
                  <ul>
                    {sampleReplies.slice(0, 5).map((r) => (
                      <li key={r.reviewId}>
                        <em>{r.replyComment.slice(0, 140)}</em>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="empty">
                  <p>No sample replies yet — we&rsquo;ll still write in the voice you set up.</p>
                </div>
              )}
            </div>
          )}

          <div className="toolbar" style={{ marginTop: "1rem" }}>
            {step > 1 && (
              <button type="button" className="btn secondary" onClick={handleBack} disabled={saving}>
                Back
              </button>
            )}
            {step < 5 ? (
              <button type="button" onClick={handleNext} disabled={saving || (step === 1 && trades.length === 0)}>
                {saving ? "Saving…" : "Save & continue"}
              </button>
            ) : (
              <button type="button" onClick={handleFinish} disabled={saving || pulling}>
                {saving ? "Finishing…" : "Finish setup"}
              </button>
            )}
          </div>
        </section>

        <aside className="card" style={{ flex: "1 1 16rem", minWidth: "min(100%, 16rem)", position: "sticky", top: "1rem" }}>
          <h3>Voice preview</h3>
          <p className="muted">A sample reply in your voice:</p>
          {previewLoading ? (
            <p className="muted">Updating…</p>
          ) : (
            <p style={{ whiteSpace: "pre-wrap" }}>
              {preview || "Move the sliders to see a live sample reply."}
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
