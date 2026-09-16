"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  formatElapsedSinceMeal,
  formatExactMealTime,
  formatRoundedMealTime,
} from "@/lib/feeding-time";
import { rebalanceMealDrafts, roundPlannedGramVector } from "@/lib/feeding-energy";
import type { FeedItem, FeedKind, FeedingState, MealView } from "@/lib/feeding-types";

type Props = { displayName: string; initialState?: FeedingState | null };
type Editor = { mealId: string } | null;
type MedicationPlanDraft = { targetAmount: string; unit: string; mealNumbers: number[] };

export function FeedingApp({ displayName, initialState = null }: Props) {
  const [selectedDate, setSelectedDate] = useState(() => initialState?.date ?? localDate());
  const [state, setState] = useState<FeedingState | null>(initialState);
  const [loading, setLoading] = useState(!initialState);
  const [refreshing, setRefreshing] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [mutating, setMutating] = useState(false);
  const activeDate = useRef(initialState?.date ?? localDate());
  const cache = useRef(new Map<string, FeedingState>(initialState ? [[initialState.date, initialState]] : []));
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const dirty = useRef(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialState && (!initialState.currentPlan || !initialState.feedItems.length)));
  const [agentAccessOpen, setAgentAccessOpen] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
  const [addingExtra, setAddingExtra] = useState(false);
  const [removingMealId, setRemovingMealId] = useState<string | null>(null);
  const [savingMedicationKey, setSavingMedicationKey] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());

  const load = useCallback(async (date: string) => {
    const id = ++requestId.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/feeding?date=${encodeURIComponent(date)}`, {
        signal: pending.signal, cache: "no-store",
      });
      const data = await response.json() as FeedingState & { error?: string };
      if (!response.ok) throw new Error(data.error || "Der Tag konnte nicht geladen werden.");
      if (id !== requestId.current || date !== activeDate.current) return;
      cache.current.set(date, data);
      if (cache.current.size > 14) cache.current.delete(cache.current.keys().next().value!);
      setState(data);
      setNeedsRefresh(false);
      setError("");
      if (!data.currentPlan || data.feedItems.length === 0) setSettingsOpen(true);
    } catch (loadError) {
      if (id === requestId.current && !pending.signal.aborted) setError(messageOf(loadError));
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!initialState) void load(activeDate.current);
    const refresh = () => {
      if (document.visibilityState === "visible" && !writing.current && !dirty.current) {
        void load(activeDate.current);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.current?.abort();
      // This counter invalidates requests, rather than referencing a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestId.current;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initialState, load]);

  useEffect(() => {
    if (!state?.lastMealAt || state.today !== selectedDate) return;
    const interval = window.setInterval(() => setTimerNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [selectedDate, state?.lastMealAt, state?.today]);

  async function mutate(body: Record<string, unknown>, keepSettings = false) {
    if (writing.current) throw new Error("Bitte warte, bis die laufende Änderung gespeichert ist.");
    writing.current = true;
    setMutating(true);
    setError("");
    controller.current?.abort();
    ++requestId.current;
    setRefreshing(false);
    const date = activeDate.current;
    try {
      const response = await fetch("/api/feeding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, selectedDate: date }),
      });
      const result = await response.json() as { error?: string; refreshError?: string; state?: FeedingState };
      if (!response.ok) throw new Error(result.error || "Die Änderung konnte nicht gespeichert werden.");
      cache.current.clear();
      dirty.current = false;
      if (result.state && activeDate.current === date) {
        cache.current.set(date, result.state);
        setState(result.state);
      } else {
        setError(result.refreshError || "Gespeichert. Bitte aktualisiere die Ansicht.");
        setNeedsRefresh(true);
      }
      setSettingsOpen(keepSettings);
    } finally {
      writing.current = false;
      setMutating(false);
    }
  }

  function moveDay(offset: number) {
    const date = new Date(`${activeDate.current}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    selectDay(date.toISOString().slice(0, 10));
  }

  function selectDay(date: string) {
    if (!date || date === activeDate.current || writing.current) return;
    activeDate.current = date;
    dirty.current = false;
    const cached = cache.current.get(date);
    setNeedsRefresh(false);
    setState(cached ?? null);
    setLoading(!cached);
    setError("");
    setSelectedDate(date);
    setEditor(null);
    void load(date);
  }

  function openMeal(meal: MealView) {
    setEditor({ mealId: meal.id });
  }

  async function submitMeal(
    event: FormEvent,
    meal: MealView,
    values: Record<string, string>,
    completedTime?: string,
  ) {
    event.preventDefault();
    setSavingMealId(meal.id);
    try {
      await mutate({
        action: "save_meal",
        mealId: meal.id,
        actuals: meal.allocations.map((item) => ({
          feedItemId: item.id,
          actualGrams: values[item.id],
        })),
        completedTime,
      });
      setEditor(null);
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSavingMealId(null);
    }
  }

  async function addExtra() {
    setAddingExtra(true);
    try {
      await mutate({ action: "add_extra_meal", date: selectedDate });
    } catch (addError) {
      setError(messageOf(addError));
    } finally {
      setAddingExtra(false);
    }
  }

  async function removeMeal(meal: MealView) {
    setRemovingMealId(meal.id);
    try {
      await mutate({ action: "remove_meal", mealId: meal.id });
    } catch (removeError) {
      setError(messageOf(removeError));
    } finally {
      setRemovingMealId(null);
    }
  }

  async function deleteMealEntry(meal: MealView) {
    const confirmed = window.confirm(
      "Diesen Fütterungseintrag vollständig entfernen? Die eingetragenen Mengen und die Uhrzeit werden gelöscht.",
    );
    if (!confirmed) return;
    setRemovingMealId(meal.id);
    try {
      await mutate({ action: "delete_meal_entry", mealId: meal.id });
      setEditor(null);
    } catch (removeError) {
      setError(messageOf(removeError));
    } finally {
      setRemovingMealId(null);
    }
  }

  async function setMedicationStatus(meal: MealView, medicationId: string, given: boolean) {
    const key = `${meal.id}:${medicationId}`;
    setSavingMedicationKey(key);
    try {
      await mutate({
        action: "set_medication_given",
        mealId: meal.id,
        medicationId,
        given,
      });
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSavingMedicationKey(null);
    }
  }

  const greetingName = displayName.includes("@") ? "Carlos" : displayName.split(" ")[0];
  const selectedLabel = formatLongDate(selectedDate);
  const isToday = state?.today === selectedDate;
  const completed = state?.day?.meals.filter((meal) => meal.completed).length ?? 0;
  const day = state?.day;
  const explicitEnergyPlan = finitePositive(day?.targetKcal);
  const roundedDayKcal = explicitEnergyPlan && day?.balance?.mode === "energy"
    ? (day.balance.actualKcal ?? 0) + day.meals.filter((meal) => !meal.completed)
      .reduce((sum, meal) => sum + meal.allocations.reduce((total, item) => total + item.plannedGrams * (item.kcalPer100g ?? 0) / 100, 0), 0)
    : null;

  return (
    <main className="app-shell" onChangeCapture={() => { dirty.current = true; }}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Rosies Tagebuch</p>
          <h1>Fütterung</h1>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button agent-button" type="button" onClick={() => setAgentAccessOpen(true)}>
            Hermes verbinden
          </button>
          <div className="account-chip" title={`Angemeldet als ${displayName}`}>
            <span className="status-dot" /> Privat für {greetingName}
          </div>
        </div>
      </header>

      <section className="day-heading" aria-labelledby="day-title">
        <div>
          <p className="date-kicker">{isToday ? "Heute" : state?.day?.virtual ? "Vorschau" : "Tagebuch"}</p>
          <h2 id="day-title">{selectedLabel}</h2>

        </div>
        <div className="date-controls" aria-label="Tag auswählen">
          <button className="icon-button" type="button" disabled={mutating} onClick={() => moveDay(-1)} aria-label="Vorheriger Tag">←</button>
          <input
            disabled={mutating}
            className="date-input"
            type="date"
            value={selectedDate}
            onChange={(event) => selectDay(event.target.value)}
            aria-label="Datum"
          />
          <button className="icon-button" type="button" disabled={mutating} onClick={() => moveDay(1)} aria-label="Nächster Tag">→</button>
          {!isToday && <button className="text-button" type="button" onClick={() => selectDay(state?.today ?? localDate())}>Heute</button>}
        </div>
      </section>

      {error && <div className="error-banner" role="alert">{error} <button className="text-button" disabled={mutating || refreshing} onClick={() => void load(activeDate.current)}>Erneut laden</button></div>}
      {refreshing && !loading && <p className="refresh-status" role="status">Wird aktualisiert …</p>}
      {loading && <LoadingDay />}

      {!loading && state && (
        <fieldset className="day-content" disabled={mutating || refreshing || needsRefresh}>
          {state.day ? (
            <>
              <section className="summary-card" aria-label="Tagesübersicht">
                <div>
                  <span className="card-label">Tagesvorgaben</span>
                  <p className="summary-number">{state.day.mealCount} reguläre Mahlzeiten</p>
                  <p className="muted">
                    {state.day.virtual
                      ? `Gilt ab ${formatShortDate(state.day.effectiveDate)} · Noch keine Ist-Mengen möglich`
                      : `${completed} von ${state.day.meals.length} Mahlzeiten eingetragen`}
                  </p>
                  {explicitEnergyPlan && (
                    <p className="summary-kcal"><b>{numberText(state.day.targetKcal!)} kcal</b> Tagesziel</p>
                  )}
                  {isToday && state.lastMealAt && (
                    <div
                      className="meal-timer"
                      aria-label={`Seit letzter Mahlzeit: ${formatElapsedSinceMeal(state.lastMealAt, timerNow)}`}
                    >
                      <span className="meal-timer-icon" aria-hidden="true" />
                      <span>
                        <small>Seit letzter Mahlzeit</small>
                        <strong>{formatElapsedSinceMeal(state.lastMealAt, timerNow)}</strong>
                      </span>
                    </div>
                  )}
                </div>
                <button className="secondary-button" type="button" onClick={() => setSettingsOpen(true)}>
                  Tagesvorgaben ändern
                </button>
              </section>

              <section className="balance-card" aria-label="Flexibler Futterausgleich">
                <h3>{state.day.balance?.mode === "energy"
                  ? explicitEnergyPlan ? "Tagesbudget" : "Energie aus den Tagesmengen"
                  : "Flexibler Futterausgleich"}</h3>
                {state.day.balance?.mode === "energy" ? <>
                  <p className="balance-number">{numberText(state.day.balance.actualKcal ?? 0)} / {state.day.balance.targetKcal == null ? "—" : numberText(state.day.balance.targetKcal)} kcal</p>
                  {state.day.balance.targetKcal == null ? (
                    <p>Kein vollständiges kcal-Budget verfügbar.</p>
                  ) : (
                    <p>{numberText(Math.abs(state.day.balance.targetKcal - (state.day.balance.actualKcal ?? 0)))} kcal {(state.day.balance.actualKcal ?? 0) > state.day.balance.targetKcal ? "über dem Tagesbudget" : "noch offen"}</p>
                  )}
                  <p className="muted">{explicitEnergyPlan
                    ? "Dein festgelegtes Tagesziel. Automatische Vorschläge werden auf 5 g gerundet."
                    : "Aus deinen bisherigen Tagesmengen berechnet. Unter Tagesvorgaben kannst du ein eigenes Kalorienziel festlegen."}</p>
                  {roundedDayKcal !== null && state.day.meals.some((meal) => !meal.completed) && (
                    <p className="muted">Mit den offenen Vorschlägen: {numberText(roundedDayKcal)} kcal insgesamt{Math.abs(roundedDayKcal - state.day.targetKcal!) < 0.05 ? " · Ziel erreicht." : ` · ${numberText(Math.abs(roundedDayKcal - state.day.targetKcal!))} kcal ${roundedDayKcal > state.day.targetKcal! ? "über" : "unter"} dem Ziel.`}</p>
                  )}
                </> : <><p><b>{grams(state.day.totals.filter((item) => item.kind === "dry").reduce((sum, item) => sum + item.actualGrams, 0))}</b> Trockenfutter gefüttert · <b>{grams(state.day.totals.filter((item) => item.kind === "dry").reduce((sum, item) => sum + item.targetGrams, 0))}</b> Standard gesamt</p><p className="muted">Nass- und Trockenfutter mit kcal-Angaben gleichen sich gegenseitig nach Kalorien aus. Sorten ohne kcal-Angabe bleiben außerhalb dieses Energiebudgets; unbekannte Trockenfutter-Sorten gleichen sich untereinander ungefähr 1:1 nach Gramm aus. Für den vollständigen Ausgleich bitte die fehlenden Werte ergänzen.</p></>}
              </section>

              <section className="totals-grid" aria-label="Mengen je Futtersorte">
                {state.day.totals.map((item) => (
                  <article className="total-card" key={item.id}>
                    <div className="total-title-row">
                      <div>
                        <span className={`kind-badge ${item.kind}`}>{kindLabel(item.kind)}</span>
                        <h3>{item.name}</h3>
                      </div>
                      <strong>{grams(item.remainingGrams)} noch vorgeschlagen</strong>
                    </div>
                    <div className="amount-row">
                      <span><b>{grams(item.targetGrams)}</b> Standard</span>
                      <span><b>{grams(item.actualGrams)}</b> gefüttert</span>
                    </div>
                    <div className="progress-track" aria-label={`${grams(item.actualGrams)} von ${grams(item.targetGrams)} gefüttert`}>
                      <span style={{ width: `${Math.min(100, item.targetGrams ? item.actualGrams / item.targetGrams * 100 : 0)}%` }} />
                    </div>
                  </article>
                ))}
              </section>

              <section className="meals-section" aria-labelledby="meals-title">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Mahlzeiten</p>
                    <h2 id="meals-title">Vorschlag für den Tag</h2>
                  </div>
                  <p>Die offene Mahlzeit reagiert sofort auf manuelle Mengen. Restliche Mahlzeiten werden nach dem Speichern angepasst.</p>
                </div>
                <div className="meals-grid">
                  {state.day.meals.map((meal) => (
                    <article className={`meal-card ${meal.completed ? "completed" : ""}`} key={meal.id}>
                      <div className="meal-heading">
                        <div>
                          <span className="meal-number">{String(meal.number).padStart(2, "0")}</span>
                          <h3>Mahlzeit {meal.number}</h3>
                        </div>
                        <div className="meal-status-block">
                          <span className={`meal-status ${meal.completed ? "done" : "open"}`}>
                            {meal.completed ? "Eingetragen" : "Offen"}
                          </span>
                          {meal.completedAt && (
                            <span className="meal-entry-meta">
                              <time className="meal-time" dateTime={meal.completedAt}>{formatRoundedMealTime(meal.completedAt)}</time>
                              {meal.recordedVia === "hermes" && <small className="entry-source">via Hermes</small>}
                            </span>
                          )}
                        </div>
                      </div>

                      {!meal.completed ? (
                        <MealAmountForm
                          key={`${meal.id}-${meal.allocations.map((item) => item.plannedGrams).join("-")}`}
                          meal={withKnownEnergy(meal, state)}
                          disabled={Boolean(state.day?.virtual) || savingMealId === meal.id || removingMealId !== null || addingExtra}
                          saving={savingMealId === meal.id}
                          previewOnly={Boolean(state.day?.virtual)}
                          removing={removingMealId === meal.id}
                          onRemove={() => void removeMeal(meal)}
                          onSubmit={(event, values, completedTime) => void submitMeal(event, meal, values, completedTime)}
                        />
                      ) : editor?.mealId === meal.id ? (
                        <MealAmountForm
                          meal={withKnownEnergy(meal, state)}
                          disabled={savingMealId === meal.id}
                          saving={savingMealId === meal.id}
                          correction
                          onCancel={() => setEditor(null)}
                          onSubmit={(event, values, completedTime) => void submitMeal(event, meal, values, completedTime)}
                        />
                      ) : (
                        <>
                          <dl className="allocation-list">
                            {meal.allocations.map((item) => (
                              <div key={item.id}>
                                <dt>
                                  <span className={`food-dot ${item.kind}`} />
                                  <span>{item.name}<small className="meal-kind-label">{kindLabel(item.kind)}</small></span>
                                </dt>
                                <dd>
                                  {meal.completed
                                    ? <><strong>{grams(item.actualGrams ?? 0)}</strong><small>statt {grams(item.plannedGrams)}</small></>
                                    : <strong>{grams(item.plannedGrams)}</strong>}
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <div className="entry-actions">
                            <button
                              className="text-button edit-entry"
                              type="button"
                              onClick={() => openMeal(meal)}
                              disabled={removingMealId === meal.id}
                            >
                              Eintrag korrigieren
                            </button>
                            <button
                              className="text-button delete-entry"
                              type="button"
                              onClick={() => void deleteMealEntry(meal)}
                              disabled={removingMealId === meal.id}
                            >
                              {removingMealId === meal.id ? "Wird entfernt …" : "Eintrag entfernen"}
                            </button>
                          </div>
                        </>
                      )}
                      {meal.medications.length > 0 && (
                        <MedicationPanel
                          meal={meal}
                          previewOnly={Boolean(state.day?.virtual)}
                          savingKey={savingMedicationKey}
                          onToggle={(medicationId, given) => void setMedicationStatus(meal, medicationId, given)}
                        />
                      )}
                    </article>
                  ))}
                </div>
                {!state.day.virtual && (
                  <div className="extra-meal-panel">
                    <div>
                      <h3>Noch eine Mahlzeit?</h3>
                      <p role={addingExtra ? "status" : undefined} aria-live="polite">
                        {addingExtra
                          ? "Wird gespeichert und die offenen Vorschläge werden neu verteilt …"
                          : "Nur für diesen Tag. Die regulären Tagesvorgaben bleiben unverändert."}
                      </p>
                    </div>
                    <button className="secondary-button" type="button" onClick={() => void addExtra()} disabled={addingExtra || removingMealId !== null}>
                      {addingExtra ? "Wird hinzugefügt …" : "Neue Mahlzeit hinzufügen"}
                    </button>
                  </div>
                )}
              </section>
            </>
          ) : (
            <section className="empty-card">
              <div className="bowl-mark" aria-hidden="true" />
              <div>
                <p className="eyebrow">Startklar machen</p>
                <h3>{state.feedItems.length ? "Noch kein Tagesplan für diesen Tag" : "Noch kein Futterbaustein angelegt"}</h3>
                <p>
                  Lege Nass- und Trockenfutter getrennt an. So bleiben auch Futterumstellungen sauber nachvollziehbar.
                </p>
                <button className="primary-button" type="button" onClick={() => setSettingsOpen(true)}>Fütterung einrichten</button>
              </div>
            </section>
          )}
        </fieldset>
      )}

      {settingsOpen && state && (
        <SettingsDialog
          key={`${state.date}-${state.currentPlan?.id ?? "none"}-${state.feedItems.map((item) => item.id).join("-")}-${state.medications.map((item) => item.id).join("-")}`}
          state={state}
          onClose={() => state.currentPlan && setSettingsOpen(false)}
          onMutate={mutate}
          onError={(value) => setError(value)}
        />
      )}

      {agentAccessOpen && (
        <AgentAccessDialog onClose={() => setAgentAccessOpen(false)} />
      )}
    </main>
  );
}

type AgentAccessResponse = {
  active?: boolean;
  name?: string | null;
  createdAt?: string | null;
  lastUsedAt?: string | null;
  config?: string;
  error?: string;
};

function AgentAccessDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AgentAccessResponse | null>(null);
  const [config, setConfig] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/agent-access", { cache: "no-store" });
      const data = await response.json() as AgentAccessResponse;
      if (!response.ok) throw new Error(data.error || "Der Hermes-Zugang konnte nicht geladen werden.");
      setStatus(data);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, []);

  // Loading the access status is the external synchronization this effect owns.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function changeAccess(action: "create" | "revoke") {
    setWorking(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/agent-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json() as AgentAccessResponse;
      if (!response.ok) throw new Error(data.error || "Der Hermes-Zugang konnte nicht geändert werden.");
      setConfig(data.config ?? "");
      await loadStatus();
    } catch (changeError) {
      setError(messageOf(changeError));
    } finally {
      setWorking(false);
    }
  }

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      setError("Die Konfiguration konnte nicht kopiert werden. Markiere den Text bitte manuell.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-dialog agent-access-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-access-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Agentenzugang</p>
            <h2 id="agent-access-title">Hermes mit Rosies Tagebuch verbinden</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose} aria-label="Schließen">×</button>
        </div>

        <div className="agent-access-content">
          <p>
            Hermes kann den Fütterungstag lesen, Futter eintragen oder korrigieren und geplante Medikamente dokumentieren.
            Tagespläne und Löschungen bleiben gesperrt.
          </p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {!status ? (
            <p className="muted">Zugang wird geprüft …</p>
          ) : (
            <div className={`agent-status ${status.active ? "active" : "inactive"}`}>
              <span className="status-dot" />
              <div>
                <strong>{status.active ? "Hermes-Zugang aktiv" : "Noch kein Hermes-Zugang"}</strong>
                {status.lastUsedAt && <small>Zuletzt verwendet: {formatAgentTimestamp(status.lastUsedAt)}</small>}
              </div>
            </div>
          )}

          {config ? (
            <section className="agent-config" aria-labelledby="agent-config-title">
              <div>
                <h3 id="agent-config-title">Konfiguration – nur jetzt vollständig sichtbar</h3>
                <p className="muted">Diesen Block in die Hermes-Konfiguration übernehmen und geheim halten.</p>
              </div>
              <textarea value={config} readOnly spellCheck={false} aria-label="Hermes MCP-Konfiguration" />
              <button className="primary-button" type="button" onClick={() => void copyConfig()}>
                {copied ? "Kopiert" : "Konfiguration kopieren"}
              </button>
            </section>
          ) : (
            <div className="agent-access-actions">
              <button className="primary-button" type="button" disabled={working} onClick={() => void changeAccess("create")}>
                {working ? "Wird erstellt …" : status?.active ? "Neuen Zugang erstellen" : "Hermes-Zugang erstellen"}
              </button>
              {status?.active && (
                <button className="text-button delete-entry" type="button" disabled={working} onClick={() => void changeAccess("revoke")}>
                  Zugang widerrufen
                </button>
              )}
            </div>
          )}

          <p className="agent-security-note">
            Ein neuer Zugang widerruft automatisch den bisherigen. Fütterungseinträge von Hermes werden im Tagebuch gekennzeichnet und lassen sich dort weiterhin korrigieren oder entfernen.
          </p>
        </div>
      </section>
    </div>
  );
}

function MedicationPanel({
  meal,
  previewOnly,
  savingKey,
  onToggle,
}: {
  meal: MealView;
  previewOnly: boolean;
  savingKey: string | null;
  onToggle: (medicationId: string, given: boolean) => void;
}) {
  return (
    <section className="medication-panel" aria-label={`Medikamente für Mahlzeit ${meal.number}`}>
      <div className="medication-panel-heading">
        <span>Medikament geplant</span>
        <small>Getrennt vom Futter dokumentieren</small>
      </div>
      <div className="medication-dose-list">
        {meal.medications.map((medication) => {
          const key = `${meal.id}:${medication.id}`;
          const saving = savingKey === key;
          return (
            <div className={`medication-dose ${medication.given ? "given" : ""}`} key={medication.id}>
              <div>
                <strong>{medication.name}</strong>
                <span>{medication.targetAmount} {medication.unit}</span>
              </div>
              {previewOnly ? (
                <span className="medication-preview">Geplant</span>
              ) : (
                <button
                  className="medication-check"
                  type="button"
                  aria-pressed={medication.given}
                  aria-label={medication.given
                    ? `${medication.name}: Gabe rückgängig machen`
                    : `${medication.name}: als gegeben markieren`}
                  disabled={saving}
                  onClick={() => onToggle(medication.id, !medication.given)}
                >
                  <span className="check-box" aria-hidden="true">{medication.given ? "✓" : ""}</span>
                  {saving ? "Wird gespeichert …" : medication.given ? "Gegeben" : "Als gegeben markieren"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MealAmountForm({
  meal,
  disabled,
  previewOnly = false,
  correction = false,
  saving = false,
  removing = false,
  onCancel,
  onRemove,
  onSubmit,
}: {
  meal: MealView;
  disabled: boolean;
  previewOnly?: boolean;
  correction?: boolean;
  saving?: boolean;
  removing?: boolean;
  onCancel?: () => void;
  onRemove?: () => void;
  onSubmit: (event: FormEvent, values: Record<string, string>, completedTime?: string) => void;
}) {
  const suggestionValues = Object.fromEntries(
    meal.allocations.map((item) => [item.id, correction
      ? String(item.actualGrams ?? item.plannedGrams)
      : String(item.plannedGrams)]),
  );
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...suggestionValues }));
  const [manualIds, setManualIds] = useState<Set<string>>(() => new Set());
  const [completedTime, setCompletedTime] = useState(() => formatExactMealTime(meal.completedAt));
  const activeSuggestedAllocations = meal.allocations.filter((item) => numericValue(suggestionValues[item.id]) > 0);
  const canBalanceByCalories = !correction && activeSuggestedAllocations.every((item) => finitePositive(item.kcalPer100g));
  const suggestedMealKcal = canBalanceByCalories
    ? activeSuggestedAllocations.reduce((sum, item) => sum + Number(suggestionValues[item.id]) * (item.kcalPer100g ?? 0) / 100, 0)
    : null;

  function recalculate(source: Record<string, string>, nextManualIds: Set<string>, overrides: Record<string, string> = {}) {
    const next = { ...source, ...overrides };
    if (!canBalanceByCalories) return next;
    if (meal.allocations.some((item) => numericValue(next[item.id]) > 0 && !finitePositive(item.kcalPer100g))) return next;
    const balanced = rebalanceMealDrafts(
      meal.allocations.map((item) => ({
        id: item.id,
        grams: numericValue(suggestionValues[item.id]),
        kcalPer100g: item.kcalPer100g,
      })),
      suggestedMealKcal ?? 0,
      next,
      nextManualIds,
    );
    return { ...next, ...balanced };
  }

  function changeManually(id: string, rawValue: string) {
    const nextManualIds = new Set(manualIds);
    nextManualIds.add(id);
    setManualIds(nextManualIds);
    setValues((current) => recalculate(current, nextManualIds, { [id]: rawValue }));
  }

  function adjustManually(id: string, delta: number) {
    const current = numericValue(values[id]);
    changeManually(id, formatManualGrams(Math.max(0, current + delta)));
  }

  function resetToSuggestion(id: string) {
    const nextManualIds = new Set(manualIds);
    nextManualIds.delete(id);
    setManualIds(nextManualIds);
    setValues((current) => recalculate(current, nextManualIds, { [id]: suggestionValues[id] }));
  }

  const currentMealKcal = canBalanceByCalories
    ? meal.allocations.reduce((sum, item) => sum + (finitePositive(item.kcalPer100g) ? Math.max(0, numericValue(values[item.id])) * (item.kcalPer100g ?? 0) / 100 : 0), 0)
    : null;
  const mealKcalDelta = currentMealKcal === null || suggestedMealKcal === null ? null : currentMealKcal - suggestedMealKcal;
  return (
    <form className="meal-form inline-meal-form" onSubmit={(event) => onSubmit(event, values, correction ? completedTime : undefined)}>
      <p>{previewOnly ? "Vorgeschlagene Menge" : correction ? "Mengen und Uhrzeit korrigieren" : "Vorschlag direkt anpassen"}</p>
      {!previewOnly && !correction && (
        <p className="meal-form-note">Manuell geänderte Mengen bleiben fest. Die anderen Vorschläge passen sich an.</p>
      )}
      {meal.allocations.map((item) => (
        <div className={`amount-input-row ${manualIds.has(item.id) ? "manual-amount" : ""}`} key={item.id}>
          <label className="amount-label" htmlFor={`${meal.id}-${item.id}-grams`}>
            <span>
              {item.name}
              <small className="meal-kind-label">{kindLabel(item.kind)}</small>
            </span>
            {manualIds.has(item.id) && <small className="manual-marker">Manuell fixiert</small>}
          </label>
          <span className="amount-controls">
            <span className="input-with-unit">
              <input
                id={`${meal.id}-${item.id}-grams`}
                type="number"
                min="0"
                max="10000"
                step="any"
                value={values[item.id] ?? ""}
                onChange={(event) => changeManually(item.id, event.target.value)}
                aria-label={`${kindLabel(item.kind)} ${item.name}, tatsächliche Menge`}
                disabled={disabled}
                required
              />
              <span>g</span>
            </span>
            {!previewOnly && (
              <span className="amount-adjusters" aria-label={`${item.name} anpassen`}>
                {[-10, -1, 1, 10].map((delta) => (
                  <button
                    className="adjust-button"
                    type="button"
                    key={delta}
                    onClick={() => adjustManually(item.id, delta)}
                    disabled={disabled}
                    aria-label={`${delta > 0 ? "+" : ""}${delta} Gramm ${item.name}`}
                  >{delta > 0 ? `+${delta}` : delta}</button>
                ))}
              </span>
            )}
            {!previewOnly && manualIds.has(item.id) && (
              <button className="reset-suggestion" type="button" onClick={() => resetToSuggestion(item.id)} disabled={disabled}>
                Vorschlag
              </button>
            )}
          </span>
        </div>
      ))}
      {!previewOnly && canBalanceByCalories && currentMealKcal !== null && suggestedMealKcal !== null && (
        <p className={`meal-kcal-status ${Math.abs(mealKcalDelta ?? 0) > 0.05 ? "has-delta" : ""}`} role="status">
          Mahlzeit: {numberText(currentMealKcal)} / {numberText(suggestedMealKcal)} kcal
          {Math.abs(mealKcalDelta ?? 0) <= 0.05
            ? " · im Budget"
            : ` · ${mealKcalDelta! > 0 ? "+" : ""}${numberText(mealKcalDelta!)} kcal gegenüber dem Vorschlag`}
        </p>
      )}
      {!previewOnly && !correction && !canBalanceByCalories && (
        <p className="meal-form-note">Für den Kalorienausgleich bitte bei allen Sorten einen kcal-Wert hinterlegen. Deine manuellen Gramm bleiben unverändert.</p>
      )}
      {correction && (
        <label className="correction-time-row">
          <span>Uhrzeit</span>
          <input
            type="time"
            step="1"
            value={completedTime}
            onChange={(event) => setCompletedTime(event.target.value)}
            aria-label="Tatsächliche Fütterungszeit"
            disabled={disabled}
            required
          />
        </label>
      )}
      {!previewOnly && (
        <>
          <div className="form-actions">
            {correction && <button className="text-button" type="button" onClick={onCancel}>Abbrechen</button>}
            <button className="primary-button meal-action" type="submit" disabled={disabled}>
              {saving ? "Wird gespeichert …" : correction ? "Korrektur speichern" : "Gefüttert"}
            </button>
          </div>
          {!correction && onRemove && (
            <button
              className="text-button remove-meal-action"
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label={`Mahlzeit ${meal.number} für diesen Tag entfernen`}
            >
              {removing ? "Wird entfernt …" : "Mahlzeit entfernen"}
            </button>
          )}
        </>
      )}
    </form>
  );
}

function SettingsDialog({
  state,
  onClose,
  onMutate,
  onError,
}: {
  state: FeedingState;
  onClose: () => void;
  onMutate: (body: Record<string, unknown>, keepSettings?: boolean) => Promise<void>;
  onError: (message: string) => void;
}) {
  const selectedTargets = state.date >= state.today ? state.day?.totals : null;
  const [name, setName] = useState("");
  const initialEnergyValues = Object.fromEntries(
    state.feedItems.map((item) => [item.id, item.kcalPer100g == null ? "" : String(item.kcalPer100g).replace(".", ",")]),
  );
  const [energyValues, setEnergyValues] = useState<Record<string, string>>(initialEnergyValues);
  const [energySaved, setEnergySaved] = useState(false);
  const [medicationName, setMedicationName] = useState("");
  const [kind, setKind] = useState<FeedKind>("wet");
  const [mealCount, setMealCount] = useState(String(state.day?.mealCount ?? state.currentPlan?.mealCount ?? 3));
  const [effectiveDate, setEffectiveDate] = useState(state.date < state.today ? state.today : state.date);
  const initialPlanDraft = inferPlanDraft(state, selectedTargets, initialEnergyValues);
  const [targetKcal, setTargetKcal] = useState(initialPlanDraft.targetKcal);
  const [percentages, setPercentages] = useState<Record<string, string>>(initialPlanDraft.percentages);
  const percentageTouched = useRef(false);
  const [medicationPlans, setMedicationPlans] = useState<Record<string, MedicationPlanDraft>>(() => {
    const source = medicationPlansForSettings(state);
    return Object.fromEntries(state.medications.map((medication) => {
      const planned = source.find((item) => item.id === medication.id);
      return [medication.id, planned
        ? { targetAmount: planned.targetAmount, unit: planned.unit, mealNumbers: planned.mealNumbers }
        : { targetAmount: "", unit: "", mealNumbers: [] }];
    }));
  });
  const [saving, setSaving] = useState(false);

  // Energy values can be entered before the plan is saved. Keep a legacy draft
  // useful in that case, without writing or migrating anything in the background.
  const previewRows = buildPlanPreviewRows(state.feedItems, percentages, energyValues, targetKcal);

  async function addItem(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onMutate({ action: "create_item", name, kind }, true);
      setName("");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  async function submitEnergy(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setEnergySaved(false);
    try {
      await onMutate({ action: "save_energy", items: state.feedItems.map((item) => ({
        feedItemId: item.id, kcalPer100g: energyValues[item.id] ?? "",
      })) }, true);
      const draft = inferPlanDraft(state, selectedTargets, energyValues);
      if (!targetKcal.trim() && draft.targetKcal) setTargetKcal(draft.targetKcal);
      if (!percentageTouched.current && !Object.values(percentages).some((value) => numericValue(value) > 0)) {
        setPercentages(draft.percentages);
      }
      setEnergySaved(true);
    } catch (error) { onError(messageOf(error)); }
    finally { setSaving(false); }
  }

  async function addMedication(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onMutate({ action: "create_medication", name: medicationName }, true);
      setMedicationName("");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  function updateMedicationPlan(medicationId: string, patch: Partial<MedicationPlanDraft>) {
    setMedicationPlans((current) => ({
      ...current,
      [medicationId]: { ...current[medicationId], ...patch },
    }));
  }

  function toggleMedicationMeal(medicationId: string, mealNumber: number) {
    const draft = medicationPlans[medicationId];
    const mealNumbers = draft.mealNumbers.includes(mealNumber)
      ? draft.mealNumbers.filter((number) => number !== mealNumber)
      : [...draft.mealNumbers, mealNumber].sort((a, b) => a - b);
    updateMedicationPlan(medicationId, { mealNumbers });
  }

  async function submitPlan(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const parsedTargetKcal = numericValue(targetKcal);
      const percentTotal = state.feedItems.reduce((sum, item) => sum + Math.max(0, numericValue(percentages[item.id])), 0);
      const activeWithoutEnergy = state.feedItems.filter((item) => (
        numericValue(percentages[item.id]) > 0 && !finitePositive(numericValue(energyValues[item.id])) && !finitePositive(item.kcalPer100g)
      ));
      const unsavedEnergy = state.feedItems.filter((item) => draftEnergyDiffers(item, energyValues));
      if (!finitePositive(parsedTargetKcal)) throw new Error("Bitte ein Tagesziel größer als 0 kcal eintragen.");
      if (Math.abs(percentTotal - 100) > 0.01) throw new Error(`Die Futteranteile müssen zusammen 100 % ergeben (aktuell ${numberText(percentTotal)} %).`);
      if (unsavedEnergy.length > 0) throw new Error("Bitte zuerst die geänderten Energiegehalte speichern. Erst danach kann der kcal-Plan gespeichert werden.");
      if (activeWithoutEnergy.length > 0) throw new Error(`Für aktive Anteile fehlt der kcal-Wert: ${activeWithoutEnergy.map((item) => item.name).join(", ")}.`);
      await onMutate({
        action: "save_plan",
        effectiveDate,
        mealCount: Number(mealCount),
        targetKcal: parsedTargetKcal,
        items: state.feedItems.map((item) => ({
          feedItemId: item.id,
          caloriePercent: Math.max(0, numericValue(percentages[item.id])),
        })),
        medications: state.medications.flatMap((medication) => {
          const draft = medicationPlans[medication.id];
          const assignedMeals = draft.mealNumbers.filter((number) => number <= Number(mealCount));
          return assignedMeals.length === 0 ? [] : [{
            medicationId: medication.id,
            targetAmount: draft.targetAmount,
            unit: draft.unit,
            mealNumbers: assignedMeals,
          }];
        }),
      });
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Fütterung einrichten</p>
            <h2 id="settings-title">Dauerhafte Tagesvorgaben</h2>
          </div>
          {state.currentPlan && <button className="close-button" type="button" onClick={onClose} aria-label="Schließen">×</button>}
        </div>

        <div className="settings-grid">
          <div className="settings-panel">
            <h3>Futterbausteine</h3>
            <p className="muted">Jede Sorte bleibt einzeln sichtbar – auch während einer Umstellung.</p>
            {state.feedItems.length > 0 && <form className="energy-form" onSubmit={(event) => void submitEnergy(event)}>
              <h3>Energiegehalt je Sorte</h3>
              <p className="muted">Zuerst für jede aktive Sorte den Packungswert in kcal pro 100 g eintragen. Angaben in kcal/kg durch 10 teilen. Komma oder Punkt sind möglich, z. B. 98,5. Sorten mit 0 % brauchen keinen Wert.</p>
              {state.feedItems.map((item) => <label className="amount-input-row" key={item.id}>
                <span>{item.name}</span>
                <span className="input-with-unit"><input type="text" inputMode="decimal"
                  aria-label={`Energiegehalt ${item.name} in kcal pro 100 g`} placeholder="Unbekannt"
                  value={energyValues[item.id] ?? ""} onChange={(event) => { setEnergySaved(false); setEnergyValues({ ...energyValues, [item.id]: event.target.value }); }} />
                  <span>kcal</span></span>
              </label>)}
              <p className="muted">Gilt ab heute. Frühere Tage und gespeicherte Pläne bleiben erhalten. Gleiche Energie bedeutet nicht gleiche Nährstoffzusammensetzung.</p>
              <button className="secondary-button" type="submit" disabled={saving}>Energiewerte speichern</button>
              {energySaved && <p role="status">Energiewerte gespeichert.</p>}
            </form>}
            <div className="food-chip-list">
              {state.feedItems.map((item) => (
                <span className="food-chip" key={item.id}><span className={`food-dot ${item.kind}`} />{item.name}<small>{kindLabel(item.kind)}</small></span>
              ))}
            </div>
            <form className="add-food-form" onSubmit={(event) => void addItem(event)}>
              <label>
                <span>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="z. B. Neues Trockenfutter" required />
              </label>
              <fieldset>
                <legend>Art</legend>
                <div className="segmented">
                  <label><input type="radio" name="kind" value="wet" checked={kind === "wet"} onChange={() => setKind("wet")} /><span>Nassfutter</span></label>
                  <label><input type="radio" name="kind" value="dry" checked={kind === "dry"} onChange={() => setKind("dry")} /><span>Trockenfutter</span></label>
                </div>
              </fieldset>
              <button className="secondary-button" type="submit" disabled={saving}>Baustein hinzufügen</button>
            </form>

            <div className="medication-library">
              <h3>Medikamente</h3>
              <p className="muted">Name frei anlegen; Sollmenge und Mahlzeiten legst du rechts im Tagesplan fest.</p>
              <div className="medication-chip-list">
                {state.medications.length === 0
                  ? <span className="empty-chip-note">Noch kein Medikament angelegt.</span>
                  : state.medications.map((medication) => (
                    <span className="medication-chip" key={medication.id}>{medication.name}</span>
                  ))}
              </div>
              <form className="add-medication-form" onSubmit={(event) => void addMedication(event)}>
                <label>
                  <span>Name</span>
                  <input
                    value={medicationName}
                    onChange={(event) => setMedicationName(event.target.value)}
                    maxLength={80}
                    placeholder="z. B. Schmerzmittel"
                    required
                  />
                </label>
                <button className="secondary-button" type="submit" disabled={saving}>Medikament hinzufügen</button>
              </form>
            </div>
          </div>

          <form className="settings-panel plan-panel" onSubmit={(event) => void submitPlan(event)}>
            <h3>kcal-Tagesplan</h3>
            <p className="muted">Lege ein Tagesziel fest und teile es prozentual auf die Futterbausteine auf. Daraus werden die Tagesmengen in Gramm berechnet. Der Entwurf wird erst mit dem Speichern zum neuen Plan.</p>
            <div className="two-fields">
              <label>
                <span>Gültig ab</span>
                <input type="date" min={state.today} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} required />
              </label>
              <label>
                <span>Mahlzeiten</span>
                <select value={mealCount} onChange={(event) => setMealCount(event.target.value)}>
                  {[2, 3, 4, 5, 6].map((count) => <option value={count} key={count}>{count}</option>)}
                </select>
              </label>
            </div>
            <label className="target-kcal-field">
              <span>Tagesziel</span>
              <span className="input-with-unit">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  step="0.1"
                  inputMode="decimal"
                  value={targetKcal}
                  onChange={(event) => setTargetKcal(event.target.value)}
                  aria-label="Tagesziel in kcal"
                  placeholder="z. B. 700"
                  required
                />
                <span>kcal</span>
              </span>
            </label>
            {initialPlanDraft.legacy && (
              <p className="legacy-draft-note">Aus deinen bisherigen Mengen berechnet. Gilt erst, wenn du die neue Tagesvorgabe speicherst.</p>
            )}
            <div className="plan-percentages" aria-label="Kalorienanteile je Futtersorte">
              {state.feedItems.length === 0 ? (
                <p className="inline-note">Lege links zuerst mindestens einen Futterbaustein an.</p>
              ) : state.feedItems.map((item) => {
                const preview = previewRows.find((row) => row.id === item.id)!;
                return (
                  <div className="plan-percentage-row" key={item.id}>
                    <label className="percentage-label" htmlFor={`plan-${item.id}-percent`}>
                      <span>{item.name}<small>{kindLabel(item.kind)}</small></span>
                    </label>
                    <span className="percentage-input-wrap">
                      <input
                        id={`plan-${item.id}-percent`}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        inputMode="decimal"
                        value={percentages[item.id] ?? "0"}
                        onChange={(event) => {
                          percentageTouched.current = true;
                          setPercentages({ ...percentages, [item.id]: event.target.value });
                        }}
                        aria-label={`Kalorienanteil ${item.name} in Prozent`}
                        required
                      />
                      <span>%</span>
                    </span>
                    <span className="plan-preview-grams">
                      {preview.percent <= 0 ? "Nicht aktiv" : preview.roundedGrams === null ? "kcal-Wert fehlt" : `≈ ${grams(preview.roundedGrams)}`}
                    </span>
                  </div>
                );
              })}
            </div>
            {state.feedItems.length > 0 && <PlanPreview
              items={state.feedItems}
              percentages={percentages}
              energyValues={energyValues}
              targetKcal={targetKcal}
            />}
            <section className="medication-plan-editor" aria-labelledby="medication-plan-title">
              <div>
                <h3 id="medication-plan-title">Medikamentenplan</h3>
                <p className="muted">Sollmenge und Einheit werden genau so protokolliert, wie du sie eingibst. Es findet keine Dosierungsberechnung statt.</p>
              </div>
              {state.medications.length === 0 ? (
                <p className="inline-note">Lege links zuerst ein Medikament an.</p>
              ) : (
                <div className="medication-plan-list">
                  {state.medications.map((medication) => {
                    const draft = medicationPlans[medication.id];
                    const assigned = draft.mealNumbers.some((number) => number <= Number(mealCount));
                    return (
                      <article className={`medication-plan-card ${assigned ? "assigned" : ""}`} key={medication.id}>
                        <div className="medication-plan-heading">
                          <strong>{medication.name}</strong>
                          <small>{assigned ? "Im Tagesplan" : "Nicht eingeplant"}</small>
                        </div>
                        <div className="medication-fields">
                          <label>
                            <span>Sollmenge</span>
                            <input
                              type="text"
                              maxLength={30}
                              value={draft.targetAmount}
                              onChange={(event) => updateMedicationPlan(medication.id, { targetAmount: event.target.value })}
                              placeholder="z. B. ½ oder ⅓"
                              aria-label={`Sollmenge ${medication.name}`}
                              required={assigned}
                            />
                          </label>
                          <label>
                            <span>Einheit</span>
                            <input
                              type="text"
                              list="medication-units"
                              maxLength={30}
                              value={draft.unit}
                              onChange={(event) => updateMedicationPlan(medication.id, { unit: event.target.value })}
                              placeholder="z. B. Tablette"
                              aria-label={`Einheit ${medication.name}`}
                              required={assigned}
                            />
                          </label>
                        </div>
                        <fieldset className="meal-choice-fieldset">
                          <legend>Zu diesen Mahlzeiten</legend>
                          <div className="meal-choice-list">
                            {Array.from({ length: Number(mealCount) }, (_, index) => index + 1).map((number) => (
                              <label key={number}>
                                <input
                                  type="checkbox"
                                  checked={draft.mealNumbers.includes(number)}
                                  onChange={() => toggleMedicationMeal(medication.id, number)}
                                />
                                <span>Mahlzeit {number}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      </article>
                    );
                  })}
                  <datalist id="medication-units">
                    <option value="Gramm" />
                    <option value="Löffelchen" />
                    <option value="Tablette" />
                  </datalist>
                </div>
              )}
            </section>
            <p className="version-note">
              Vergangene Tage bleiben unverändert. Für heute werden nur offene, noch nicht dokumentierte Bereiche angepasst.
            </p>
            <button className="primary-button wide" type="submit" disabled={saving || state.feedItems.length === 0}>
              {saving ? "Wird gespeichert …" : "Vorgaben speichern"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function LoadingDay() {
  return <section className="loading-card" aria-live="polite"><span className="loading-pulse" /> Rosies Fütterung wird geladen …</section>;
}

function PlanPreview({
  items,
  percentages,
  energyValues,
  targetKcal,
}: {
  items: FeedItem[];
  percentages: Record<string, string>;
  energyValues: Record<string, string>;
  targetKcal: string;
}) {
  const rows = buildPlanPreviewRows(items, percentages, energyValues, targetKcal);
  const target = numericValue(targetKcal);
  const totalPercent = rows.reduce((sum, row) => sum + row.percent, 0);
  const activeRows = rows.filter((row) => row.percent > 0);
  const missingEnergy = activeRows.filter((row) => row.energy === null);
  const effectiveKcal = missingEnergy.length > 0 || !finitePositive(target)
    ? null
    : activeRows.reduce((sum, row) => sum + (row.roundedGrams ?? 0) * (row.energy ?? 0) / 100, 0);
  const roundingDelta = effectiveKcal === null ? null : effectiveKcal - target;
  const percentValid = Math.abs(totalPercent - 100) <= 0.01;
  const percentGap = Math.abs(100 - totalPercent);
  return (
    <section className="plan-preview" aria-label="Vorschau der Tagesmengen">
      <div className={`percentage-total ${percentValid ? "valid" : "invalid"}`} role="status">
        <strong>Anteile gesamt: {numberText(totalPercent)} %</strong>
        <span>{percentValid ? "Bereit zum Speichern" : totalPercent < 100
          ? `Noch ${numberText(percentGap)} Prozentpunkte bis 100 %`
          : `${numberText(percentGap)} Prozentpunkte über 100 %`}</span>
      </div>
      {effectiveKcal === null ? (
        <p className="plan-rounding-note">Die 5-g-Vorschau erscheint, sobald ein Tagesziel und kcal-Werte für alle aktiven Sorten vorhanden sind. 0-%-Sorten bleiben außen vor.</p>
      ) : (
        <p className={`plan-rounding-note ${Math.abs(roundingDelta ?? 0) > 0.05 ? "has-delta" : ""}`}>
          Auf 5 g gerundet: {numberText(effectiveKcal)} kcal bei {numberText(target)} kcal Ziel
          {Math.abs(roundingDelta ?? 0) <= 0.05
            ? " · keine relevante Abweichung"
            : ` · ${roundingDelta! > 0 ? "+" : ""}${numberText(roundingDelta!)} kcal Rundungsdifferenz`}
        </p>
      )}
      {missingEnergy.length > 0 && <p className="plan-rounding-note has-delta">Aktive Sorten ohne kcal-Wert: {missingEnergy.map((item) => item.name).join(", ")}.</p>}
    </section>
  );
}

type PlanPreviewRow = {
  id: string;
  name: string;
  percent: number;
  energy: number | null;
  rawGrams: number | null;
  roundedGrams: number | null;
};

function buildPlanPreviewRows(
  items: FeedItem[],
  percentages: Record<string, string>,
  energyValues: Record<string, string>,
  targetKcal: string,
): PlanPreviewRow[] {
  const target = numericValue(targetKcal);
  const rows = items.map((item) => {
    const percent = Math.max(0, numericValue(percentages[item.id]));
    const energy = energyValue(item, energyValues);
    const rawGrams = finitePositive(energy) && finitePositive(target) ? target * percent / energy : null;
    return { id: item.id, name: item.name, percent, energy: finitePositive(energy) ? energy : null, rawGrams, roundedGrams: null };
  });
  const roundable = rows.filter((row) => row.percent > 0 && row.rawGrams !== null && row.energy !== null);
  const rounded = roundPlannedGramVector(
    roundable.map((row) => ({ grams: row.rawGrams ?? 0, kcalPer100g: row.energy })),
    target,
    5,
  );
  const roundedById = new Map(roundable.map((row, index) => [row.id, rounded[index] ?? 0]));
  return rows.map((row) => ({ ...row, roundedGrams: roundedById.get(row.id) ?? null }));
}

function inferPlanDraft(
  state: FeedingState,
  selectedTargets: Array<FeedItem & { targetGrams: number }> | null | undefined,
  energyValues: Record<string, string>,
): { targetKcal: string; percentages: Record<string, string>; legacy: boolean } {
  const plan = state.currentPlan;
  const day = selectedTargets ? state.day : null;
  const selectedDayRows = (selectedTargets ?? []) as Array<FeedItem & { targetGrams: number; caloriePercent?: number | null }>;
  const gramsById = new Map<string, number>();
  state.feedItems.forEach((item) => {
    const planItem = plan?.items.find((candidate) => candidate.id === item.id);
    const dayItem = selectedDayRows.find((candidate) => candidate.id === item.id);
    gramsById.set(item.id, dayItem?.targetGrams ?? planItem?.dailyGrams ?? 0);
  });
  const inferredContributions = state.feedItems.map((item) => {
    const energy = energyValue(item, energyValues);
    return finitePositive(energy) ? (gramsById.get(item.id) ?? 0) * energy / 100 : 0;
  });
  const inferredTarget = inferredContributions.reduce((sum, value) => sum + value, 0);
  const savedTarget = finitePositive(day?.targetKcal) ? day?.targetKcal ?? null
    : finitePositive(plan?.targetKcal) ? plan?.targetKcal ?? null
      : finitePositive(state.day?.balance?.targetKcal) ? state.day?.balance?.targetKcal ?? null : null;
  const target = savedTarget ?? (finitePositive(inferredTarget) ? inferredTarget : null);
  const selectedPercentages = Object.fromEntries(state.feedItems.map((item) => {
    const dayItem = selectedDayRows.find((candidate) => candidate.id === item.id);
    return [item.id, dayItem?.caloriePercent == null ? "0" : String(dayItem.caloriePercent)];
  }));
  const selectedPercentTotal = Object.values(selectedPercentages).reduce((sum, value) => sum + Math.max(0, numericValue(value)), 0);
  const planPercentages = Object.fromEntries(state.feedItems.map((item) => {
    const planItem = plan?.items.find((candidate) => candidate.id === item.id);
    return [item.id, planItem?.caloriePercent == null ? "0" : String(planItem.caloriePercent)];
  }));
  const planPercentTotal = Object.values(planPercentages).reduce((sum, value) => sum + Math.max(0, numericValue(value)), 0);
  const savedPercentages = selectedPercentTotal > 0 ? selectedPercentages : planPercentages;
  const hasSavedPercentages = (selectedPercentTotal > 0 && state.date >= state.today) || planPercentTotal > 0;
  const contributionTotal = inferredContributions.reduce((sum, value) => sum + value, 0);
  const percentages = hasSavedPercentages ? savedPercentages : inferredPercentages(state.feedItems, inferredContributions, contributionTotal);
  const hasExplicitTarget = finitePositive(plan?.targetKcal) || finitePositive(day?.targetKcal);
  return {
    targetKcal: target === null ? "" : formatDraftNumber(target),
    percentages,
    legacy: Boolean(plan && !hasExplicitTarget),
  };
}

function inferredPercentages(items: FeedItem[], contributions: number[], total: number) {
  if (total <= 0) return Object.fromEntries(items.map((item) => [item.id, "0"]));
  const values = contributions.map((value) => Math.round(value / total * 10000) / 100);
  const lastPositive = values.reduce((last, value, index) => value > 0 ? index : last, -1);
  if (lastPositive >= 0) values[lastPositive] += 100 - values.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(items.map((item, index) => [item.id, formatDraftNumber(values[index] ?? 0)]));
}

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function formatLongDate(date: string) {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

function formatShortDate(date: string) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

function kindLabel(kind: FeedKind) { return kind === "wet" ? "Nassfutter" : "Trockenfutter"; }
function grams(value: number) { return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)} g`; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : "Etwas ist schiefgegangen."; }
function numericValue(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}
function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function energyValue(item: FeedItem, draft: Record<string, string>) {
  if (Object.prototype.hasOwnProperty.call(draft, item.id)) {
    const draftText = draft[item.id]?.trim() ?? "";
    const draftValue = numericValue(draftText);
    return draftText && finitePositive(draftValue) ? draftValue : null;
  }
  return item.kcalPer100g ?? null;
}
function draftEnergyDiffers(item: FeedItem, draft: Record<string, string>) {
  const draftValue = energyValue(item, draft);
  const savedValue = finitePositive(item.kcalPer100g) ? item.kcalPer100g : null;
  return draftValue !== savedValue;
}
function formatManualGrams(value: number) { return Number.isInteger(value) ? String(value) : String(value.toFixed(10)).replace(/0+$/, "").replace(/\.$/, ""); }
function formatDraftNumber(value: number) { return Number.isInteger(value) ? String(value) : String(value.toFixed(2)).replace(/0+$/, "").replace(/\.$/, ""); }
function formatAgentTimestamp(value: string) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function withKnownEnergy(meal: MealView, state: FeedingState): MealView {
  return {
    ...meal,
    allocations: meal.allocations.map((allocation) => {
      const dayTotal = state.day?.totals.find((item) => item.id === allocation.id);
      const feedItem = state.feedItems.find((item) => item.id === allocation.id);
      const kcalPer100g = allocation.kcalPer100g ?? dayTotal?.kcalPer100g ?? feedItem?.kcalPer100g ?? null;
      return kcalPer100g == null ? allocation : { ...allocation, kcalPer100g };
    }),
  };
}

function medicationPlansForSettings(state: FeedingState): Array<{
  id: string;
  targetAmount: string;
  unit: string;
  mealNumbers: number[];
}> {
  if (!state.day?.virtual) return state.currentPlan?.medications ?? [];
  const plans = new Map<string, { id: string; targetAmount: string; unit: string; mealNumbers: number[] }>();
  state.day.meals.forEach((meal) => meal.medications.forEach((medication) => {
    const existing = plans.get(medication.id);
    if (existing) existing.mealNumbers.push(meal.number);
    else plans.set(medication.id, {
      id: medication.id,
      targetAmount: medication.targetAmount,
      unit: medication.unit,
      mealNumbers: [meal.number],
    });
  }));
  return [...plans.values()];
}

function numberText(value: number) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
}
