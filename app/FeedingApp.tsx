"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { FeedKind, FeedingState, MealView } from "@/lib/feeding-types";

type Props = { displayName: string };
type Editor = { mealId: string } | null;

export function FeedingApp({ displayName }: Props) {
  const [selectedDate, setSelectedDate] = useState(() => localDate());
  const [state, setState] = useState<FeedingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
  const [addingExtra, setAddingExtra] = useState(false);
  const [removingMealId, setRemovingMealId] = useState<string | null>(null);

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

  async function mutate(body: Record<string, unknown>, keepSettings = false) {
    setError("");
    const response = await fetch("/api/feeding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string; day?: FeedingState["day"] };
    if (!response.ok) throw new Error(result.error || "Die Änderung konnte nicht gespeichert werden.");
    if (Object.prototype.hasOwnProperty.call(result, "day")) {
      setState((current) => current ? { ...current, day: result.day ?? null } : current);
    } else {
      await load(selectedDate);
    }
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

  async function submitMeal(event: FormEvent, meal: MealView, values: Record<string, string>) {
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

  const greetingName = displayName.includes("@") ? "Carlos" : displayName.split(" ")[0];
  const selectedLabel = formatLongDate(selectedDate);
  const isToday = state?.today === selectedDate;
  const completed = state?.day?.meals.filter((meal) => meal.completed).length ?? 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Rosis Tagebuch</p>
          <h1>Fütterung</h1>
        </div>
        <div className="account-chip" title={`Angemeldet als ${displayName}`}>
          <span className="status-dot" /> Privat für {greetingName}
        </div>
      </header>

      <section className="day-heading" aria-labelledby="day-title">
        <div>
          <p className="date-kicker">{isToday ? "Heute" : state?.day?.virtual ? "Vorschau" : "Tagebuch"}</p>
          <h2 id="day-title">{selectedLabel}</h2>
          <p className="day-subline">{isToday ? "Ein ruhiger Blick auf Rosis Tag." : "Plan und Einträge dieses Tages."}</p>
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
                        <span className={`meal-status ${meal.completed ? "done" : "open"}`}>
                          {meal.completed ? "Eingetragen" : "Offen"}
                        </span>
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
                          onSubmit={(event, values) => void submitMeal(event, meal, values)}
                        />
                      ) : editor?.mealId === meal.id ? (
                        <MealAmountForm
                          meal={meal}
                          disabled={savingMealId === meal.id}
                          saving={savingMealId === meal.id}
                          correction
                          onCancel={() => setEditor(null)}
                          onSubmit={(event, values) => void submitMeal(event, meal, values)}
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
                          <button className="text-button edit-entry" type="button" onClick={() => openMeal(meal)}>Eintrag korrigieren</button>
                        </>
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
          key={`${state.date}-${state.currentPlan?.id ?? "none"}-${state.feedItems.map((item) => item.id).join("-")}`}
          state={state}
          onClose={() => state.currentPlan && setSettingsOpen(false)}
          onMutate={mutate}
          onError={(value) => setError(value)}
        />
      )}
    </main>
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
  onSubmit: (event: FormEvent, values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    meal.allocations.map((item) => [item.id, String(item.actualGrams ?? item.plannedGrams)]),
  ));
  return (
    <form className="meal-form inline-meal-form" onSubmit={(event) => onSubmit(event, values)}>
      <p>{previewOnly ? "Vorgeschlagene Menge" : correction ? "Tatsächliche Menge korrigieren" : "Vorschlag direkt anpassen"}</p>
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

  async function submitPlan(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onMutate({
        action: "save_plan",
        effectiveDate,
        mealCount: Number(mealCount),
        items: state.feedItems.map((item) => ({ feedItemId: item.id, dailyGrams: amounts[item.id] ?? "0" })),
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
            <p className="version-note">
              Vergangene Tage bleiben unverändert. Für heute werden nur noch offene Mahlzeiten neu verteilt.
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
  return <section className="loading-card" aria-live="polite"><span className="loading-pulse" /> Rosis Fütterung wird geladen …</section>;
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
