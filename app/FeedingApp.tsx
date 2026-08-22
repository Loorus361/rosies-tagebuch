"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  formatElapsedSinceMeal,
  formatExactMealTime,
  formatRoundedMealTime,
} from "@/lib/feeding-time";
import type { FeedKind, FeedingState, MealView } from "@/lib/feeding-types";

type Props = { displayName: string };
type Editor = { mealId: string } | null;
type MedicationPlanDraft = { targetAmount: string; unit: string; mealNumbers: number[] };

export function FeedingApp({ displayName }: Props) {
  const [selectedDate, setSelectedDate] = useState(() => localDate());
  const [state, setState] = useState<FeedingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentAccessOpen, setAgentAccessOpen] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
  const [addingExtra, setAddingExtra] = useState(false);
  const [removingMealId, setRemovingMealId] = useState<string | null>(null);
  const [savingMedicationKey, setSavingMedicationKey] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());

  const load = useCallback(async (date: string) => {
    try {
      const response = await fetch(`/api/feeding?date=${encodeURIComponent(date)}`);
      const data = await response.json() as FeedingState & { error?: string };
      if (!response.ok) throw new Error(data.error || "Der Tag konnte nicht geladen werden.");
      setState(data);
      if (!data.currentPlan || data.feedItems.length === 0) setSettingsOpen(true);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  // Loading the selected date is the external synchronization this effect owns.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(selectedDate); }, [load, selectedDate]);

  useEffect(() => {
    if (!state?.lastMealAt || state.today !== selectedDate) return;
    const interval = window.setInterval(() => setTimerNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [selectedDate, state?.lastMealAt, state?.today]);

  async function mutate(body: Record<string, unknown>, keepSettings = false) {
    setError("");
    const response = await fetch("/api/feeding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || "Die Änderung konnte nicht gespeichert werden.");
    await load(selectedDate);
    setSettingsOpen(keepSettings);
  }

  function moveDay(offset: number) {
    const date = new Date(`${selectedDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    setLoading(true);
    setError("");
    setSelectedDate(date.toISOString().slice(0, 10));
    setEditor(null);
  }

  function selectDay(date: string) {
    setLoading(true);
    setError("");
    setSelectedDate(date);
    setEditor(null);
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

  return (
    <main className="app-shell">
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
          <p className="day-subline">{isToday ? "Ein ruhiger Blick auf Rosies Tag." : "Plan und Einträge dieses Tages."}</p>
        </div>
        <div className="date-controls" aria-label="Tag auswählen">
          <button className="icon-button" type="button" onClick={() => moveDay(-1)} aria-label="Vorheriger Tag">←</button>
          <input
            className="date-input"
            type="date"
            value={selectedDate}
            onChange={(event) => selectDay(event.target.value)}
            aria-label="Datum"
          />
          <button className="icon-button" type="button" onClick={() => moveDay(1)} aria-label="Nächster Tag">→</button>
          {!isToday && <button className="text-button" type="button" onClick={() => selectDay(state?.today ?? localDate())}>Heute</button>}
        </div>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <LoadingDay />}

      {!loading && state && (
        <>
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

              <section className="totals-grid" aria-label="Mengen je Futtersorte">
                {state.day.totals.map((item) => (
                  <article className="total-card" key={item.id}>
                    <div className="total-title-row">
                      <div>
                        <span className={`kind-badge ${item.kind}`}>{kindLabel(item.kind)}</span>
                        <h3>{item.name}</h3>
                      </div>
                      <strong>{grams(item.remainingGrams)} offen</strong>
                    </div>
                    <div className="amount-row">
                      <span><b>{grams(item.targetGrams)}</b> geplant</span>
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
                  <p>Nach jedem Eintrag werden die offenen Mahlzeiten neu verteilt.</p>
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
                          meal={meal}
                          disabled={Boolean(state.day?.virtual) || savingMealId === meal.id || removingMealId !== null || addingExtra}
                          saving={savingMealId === meal.id}
                          previewOnly={Boolean(state.day?.virtual)}
                          removing={removingMealId === meal.id}
                          onRemove={() => void removeMeal(meal)}
                          onSubmit={(event, values, completedTime) => void submitMeal(event, meal, values, completedTime)}
                        />
                      ) : editor?.mealId === meal.id ? (
                        <MealAmountForm
                          meal={meal}
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
        </>
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
            Hermes erhält ausschließlich zwei Werkzeuge: den Fütterungstag lesen und Futter in die nächste offene Mahlzeit eintragen.
            Pläne, Medikamente, Korrekturen und Löschungen bleiben gesperrt.
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
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    meal.allocations.map((item) => [item.id, String(item.actualGrams ?? item.plannedGrams)]),
  ));
  const [completedTime, setCompletedTime] = useState(() => formatExactMealTime(meal.completedAt));
  return (
    <form className="meal-form inline-meal-form" onSubmit={(event) => onSubmit(event, values, correction ? completedTime : undefined)}>
      <p>{previewOnly ? "Vorgeschlagene Menge" : correction ? "Mengen und Uhrzeit korrigieren" : "Vorschlag direkt anpassen"}</p>
      {meal.allocations.map((item) => (
        <label className="amount-input-row" key={item.id}>
          <span>
            {item.name}
            <small className="meal-kind-label">{kindLabel(item.kind)}</small>
          </span>
          <span className="input-with-unit">
            <input
              type="number"
              min="0"
              max="10000"
              step="0.1"
              value={values[item.id] ?? ""}
              onChange={(event) => setValues({ ...values, [item.id]: event.target.value })}
              aria-label={`${kindLabel(item.kind)} ${item.name}, tatsächliche Menge`}
              disabled={disabled}
              required
            />
            <span>g</span>
          </span>
        </label>
      ))}
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
  const [medicationName, setMedicationName] = useState("");
  const [kind, setKind] = useState<FeedKind>("wet");
  const [mealCount, setMealCount] = useState(String(state.day?.mealCount ?? state.currentPlan?.mealCount ?? 3));
  const [effectiveDate, setEffectiveDate] = useState(state.date < state.today ? state.today : state.date);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(
    state.feedItems.map((item) => [
      item.id,
      String(
        selectedTargets?.find((target) => target.id === item.id)?.targetGrams
        ?? state.currentPlan?.items.find((planItem) => planItem.id === item.id)?.dailyGrams
        ?? 0
      ),
    ]),
  ));
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
      await onMutate({
        action: "save_plan",
        effectiveDate,
        mealCount: Number(mealCount),
        items: state.feedItems.map((item) => ({ feedItemId: item.id, dailyGrams: amounts[item.id] ?? "0" })),
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
            <h3>Tagesvorgaben</h3>
            <p className="muted">Diese Standardmengen und die reguläre Mahlzeitenzahl gelten ab dem gewählten Datum. Vorschläge kannst du unten im jeweiligen Tag direkt anpassen.</p>
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
            <div className="daily-amounts">
              {state.feedItems.length === 0 ? (
                <p className="inline-note">Lege links zuerst mindestens einen Futterbaustein an.</p>
              ) : state.feedItems.map((item) => (
                <label className="amount-input-row" key={item.id}>
                  <span>{item.name}<small>{kindLabel(item.kind)}</small></span>
                  <span className="input-with-unit">
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      step="0.1"
                      value={amounts[item.id] ?? "0"}
                      onChange={(event) => setAmounts({ ...amounts, [item.id]: event.target.value })}
                      aria-label={`Tagesmenge ${item.name}`}
                      required
                    />
                    <span>g</span>
                  </span>
                </label>
              ))}
            </div>
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
function formatAgentTimestamp(value: string) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
