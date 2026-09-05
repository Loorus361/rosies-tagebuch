import {
  claimAgentRequest,
  completeAgentRequest,
  releaseAgentRequest,
} from "./agent-access";
import {
  addExtraMeal,
  assertDate,
  berlinToday,
  getFeedingDay,
  getFeedingState,
  saveMeal,
  setMedicationGiven,
} from "./feeding";
import type { DayView, FeedKind, MealView } from "@/lib/feeding-types";

export type AgentFoodAmount = { foodName: string; grams: number };
export type AgentRecordInput = {
  date?: string;
  time?: string;
  amounts: AgentFoodAmount[];
  createExtraIfNeeded: boolean;
  idempotencyKey: string;
};
export type AgentCorrectionInput = {
  date?: string;
  mealNumber: number;
  time: string;
  amounts: AgentFoodAmount[];
  idempotencyKey: string;
};
export type AgentMedicationInput = {
  date?: string;
  mealNumber: number;
  medicationName: string;
  given: boolean;
  idempotencyKey: string;
};

export type AgentDayResult = {
  date: string;
  today: string;
  lastMealAt: string | null;
  balance: DayView["balance"];
  foods: Array<{ name: string; kind: FeedKind }>;
  totals: Array<{
    name: string;
    kind: FeedKind;
    targetGrams: number;
    kcalPer100g: number | null;
    fedGrams: number;
    remainingGrams: number;
  }>;
  meals: Array<{
    number: number;
    extra: boolean;
    status: "open" | "recorded";
    completedAt: string | null;
    recordedVia: "app" | "hermes" | null;
    amounts: Array<{ name: string; kind: FeedKind; suggestedGrams: number; actualGrams: number | null }>;
    medications: Array<{
      name: string;
      targetAmount: string;
      unit: string;
      given: boolean;
      givenAt: string | null;
    }>;
  }>;
};

export type AgentRecordResult = {
  status: "recorded" | "already_recorded";
  date: string;
  mealNumber: number;
  extra: boolean;
  completedAt: string;
  amounts: AgentFoodAmount[];
  summary: string;
};
export type AgentCorrectionResult = {
  status: "corrected" | "already_corrected";
  date: string;
  mealNumber: number;
  completedAt: string;
  amounts: AgentFoodAmount[];
  summary: string;
};
export type AgentMedicationResult = {
  status: "documented" | "already_documented";
  changed: boolean;
  date: string;
  mealNumber: number;
  medicationName: string;
  targetAmount: string;
  unit: string;
  given: boolean;
  givenAt: string | null;
  summary: string;
};

export async function getAgentFeedingDay(ownerId: string, rawDate?: string): Promise<AgentDayResult> {
  const date = rawDate ?? berlinToday();
  assertDate(date);
  const state = await getFeedingState(ownerId, date);
  if (!state.day) throw new Error(`Für ${date} gibt es keinen Fütterungsplan.`);
  return serializeDay(state.day, state.today, state.lastMealAt, state.feedItems);
}

export async function recordAgentMeal(ownerId: string, input: AgentRecordInput): Promise<AgentRecordResult> {
  const date = input.date ?? berlinToday();
  assertDate(date);
  if (date > berlinToday()) throw new Error("Futter kann nicht für einen zukünftigen Tag eingetragen werden.");
  if (date < berlinToday() && !input.time) {
    throw new Error("Für einen vergangenen Tag muss die lokale Uhrzeit angegeben werden.");
  }
  const normalizedAmounts = normalizeAmounts(input.amounts, true);

  const normalizedInput = { ...input, date, amounts: normalizedAmounts };
  const claim = await claimAgentRequest(ownerId, input.idempotencyKey, normalizedInput);
  if (claim.state === "completed") {
    return { ...(claim.result as Omit<AgentRecordResult, "status">), status: "already_recorded" };
  }
  if (claim.state === "pending") {
    throw new Error("Dieser Eintrag wird bereits verarbeitet. Bitte mit derselben idempotency_key erneut versuchen.");
  }

  try {
    let state = await getFeedingState(ownerId, date);
    if (!state.day) throw new Error(`Für ${date} gibt es keinen Fütterungsplan.`);
    let meal = state.day.meals.find((candidate) => !candidate.completed);
    if (!meal && input.createExtraIfNeeded) {
      await addExtraMeal(ownerId, date);
      state = await getFeedingState(ownerId, date);
      meal = [...(state.day?.meals ?? [])].reverse().find((candidate) => !candidate.completed && candidate.extra);
    }
    if (!meal) {
      throw new Error("Alle Mahlzeiten sind bereits eingetragen. Für eine weitere Mahlzeit create_extra_if_needed auf true setzen.");
    }

    const matched = matchAmounts(meal, normalizedAmounts);
    await saveMeal(
      ownerId,
      meal.id,
      meal.allocations.map((allocation) => ({
        feedItemId: allocation.id,
        actualGrams: matched.get(allocation.id) ?? 0,
      })),
      input.time,
      "hermes",
    );
    const savedDay = await getFeedingDay(ownerId, date);
    const savedMeal = savedDay?.meals.find((candidate) => candidate.id === meal!.id);
    if (!savedMeal?.completedAt) throw new Error("Der gespeicherte Fütterungseintrag konnte nicht bestätigt werden.");
    const result: AgentRecordResult = {
      status: "recorded",
      date,
      mealNumber: savedMeal.number,
      extra: savedMeal.extra,
      completedAt: savedMeal.completedAt,
      amounts: savedMeal.allocations
        .filter((allocation) => Number(allocation.actualGrams ?? 0) > 0)
        .map((allocation) => ({ foodName: allocation.name, grams: Number(allocation.actualGrams) })),
      summary: summarizeMeal(savedMeal),
    };
    await completeAgentRequest(ownerId, input.idempotencyKey, result);
    return result;
  } catch (error) {
    await releaseAgentRequest(ownerId, input.idempotencyKey);
    throw error;
  }
}

export async function correctAgentMeal(ownerId: string, input: AgentCorrectionInput): Promise<AgentCorrectionResult> {
  const date = input.date ?? berlinToday();
  assertDate(date);
  if (date > berlinToday()) throw new Error("Ein Fütterungseintrag kann nicht für einen zukünftigen Tag korrigiert werden.");
  if (!Number.isInteger(input.mealNumber) || input.mealNumber < 1) {
    throw new Error("Bitte eine gültige Mahlzeitennummer angeben.");
  }
  const normalizedAmounts = normalizeAmounts(input.amounts, false);
  const normalizedInput = { ...input, date, amounts: normalizedAmounts };
  const claim = await claimAgentRequest(ownerId, input.idempotencyKey, normalizedInput);
  if (claim.state === "completed") {
    return { ...(claim.result as Omit<AgentCorrectionResult, "status">), status: "already_corrected" };
  }
  if (claim.state === "pending") {
    throw new Error("Diese Korrektur wird bereits verarbeitet. Bitte mit derselben idempotency_key erneut versuchen.");
  }

  try {
    const state = await getFeedingState(ownerId, date);
    const meal = state.day?.meals.find((candidate) => candidate.number === input.mealNumber);
    if (!meal) throw new Error(`Mahlzeit ${input.mealNumber} existiert an diesem Tag nicht.`);
    if (!meal.completed) throw new Error(`Mahlzeit ${input.mealNumber} ist noch offen und kann nicht korrigiert werden.`);
    const matched = matchAmounts(meal, normalizedAmounts);
    if (matched.size !== meal.allocations.length || normalizedAmounts.length !== meal.allocations.length) {
      throw new Error("Bei einer Korrektur müssen alle Futtersorten dieser Mahlzeit mit ihrer vollständigen Ist-Menge angegeben werden.");
    }
    await saveMeal(
      ownerId,
      meal.id,
      meal.allocations.map((allocation) => ({
        feedItemId: allocation.id,
        actualGrams: matched.get(allocation.id),
      })),
      input.time,
      "hermes",
    );
    const savedDay = await getFeedingDay(ownerId, date);
    const savedMeal = savedDay?.meals.find((candidate) => candidate.id === meal.id);
    if (!savedMeal?.completedAt) throw new Error("Die korrigierte Fütterung konnte nicht bestätigt werden.");
    const result: AgentCorrectionResult = {
      status: "corrected",
      date,
      mealNumber: savedMeal.number,
      completedAt: savedMeal.completedAt,
      amounts: savedMeal.allocations.map((allocation) => ({
        foodName: allocation.name,
        grams: Number(allocation.actualGrams ?? 0),
      })),
      summary: `Korrigiert: ${summarizeMeal(savedMeal).replace(/^Eingetragen: /, "")}`,
    };
    await completeAgentRequest(ownerId, input.idempotencyKey, result);
    return result;
  } catch (error) {
    await releaseAgentRequest(ownerId, input.idempotencyKey);
    throw error;
  }
}

export async function documentAgentMedication(
  ownerId: string,
  input: AgentMedicationInput,
): Promise<AgentMedicationResult> {
  const date = input.date ?? berlinToday();
  assertDate(date);
  if (date > berlinToday()) throw new Error("Ein Medikament kann nicht für einen zukünftigen Tag dokumentiert werden.");
  if (!Number.isInteger(input.mealNumber) || input.mealNumber < 1) {
    throw new Error("Bitte eine gültige Mahlzeitennummer angeben.");
  }
  const medicationName = normalizeFoodName(input.medicationName);
  if (!medicationName) throw new Error("Bitte den exakten Medikamentennamen angeben.");
  const normalizedInput = { ...input, date, medicationName };
  const claim = await claimAgentRequest(ownerId, input.idempotencyKey, normalizedInput);
  if (claim.state === "completed") {
    return { ...(claim.result as Omit<AgentMedicationResult, "status">), status: "already_documented" };
  }
  if (claim.state === "pending") {
    throw new Error("Diese Medikamentendokumentation wird bereits verarbeitet. Bitte mit derselben idempotency_key erneut versuchen.");
  }

  try {
    const state = await getFeedingState(ownerId, date);
    const meal = state.day?.meals.find((candidate) => candidate.number === input.mealNumber);
    if (!meal) throw new Error(`Mahlzeit ${input.mealNumber} existiert an diesem Tag nicht.`);
    const matches = meal.medications.filter((medication) =>
      medication.name.toLocaleLowerCase("de-DE") === medicationName.toLocaleLowerCase("de-DE"));
    if (matches.length === 0) {
      throw new Error(`„${medicationName}“ ist für Mahlzeit ${input.mealNumber} nicht geplant. Zuerst rosie_tag_anzeigen aufrufen.`);
    }
    if (matches.length > 1) {
      throw new Error(`„${medicationName}“ ist nicht eindeutig. Bitte den exakten Namen aus rosie_tag_anzeigen verwenden.`);
    }
    const medication = matches[0];
    const changed = medication.given !== input.given;
    if (changed) await setMedicationGiven(ownerId, meal.id, medication.id, input.given);
    const savedDay = changed ? await getFeedingDay(ownerId, date) : state.day;
    const savedMedication = savedDay?.meals.find((candidate) => candidate.id === meal.id)
      ?.medications.find((candidate) => candidate.id === medication.id);
    if (!savedMedication) throw new Error("Die Medikamentendokumentation konnte nicht bestätigt werden.");
    const action = input.given ? "als gegeben dokumentiert" : "als nicht gegeben markiert";
    const result: AgentMedicationResult = {
      status: "documented",
      changed,
      date,
      mealNumber: meal.number,
      medicationName: savedMedication.name,
      targetAmount: savedMedication.targetAmount,
      unit: savedMedication.unit,
      given: savedMedication.given,
      givenAt: savedMedication.givenAt,
      summary: changed
        ? `Dokumentiert: ${savedMedication.name} bei Mahlzeit ${meal.number} ${action}.`
        : `Keine Änderung: ${savedMedication.name} war bei Mahlzeit ${meal.number} bereits ${input.given ? "als gegeben" : "als nicht gegeben"} dokumentiert.`,
    };
    await completeAgentRequest(ownerId, input.idempotencyKey, result);
    return result;
  } catch (error) {
    await releaseAgentRequest(ownerId, input.idempotencyKey);
    throw error;
  }
}

function matchAmounts(meal: MealView, amounts: AgentFoodAmount[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const amount of amounts) {
    const matches = meal.allocations.filter((allocation) =>
      normalizeFoodName(allocation.name).toLocaleLowerCase("de-DE") === amount.foodName.toLocaleLowerCase("de-DE"));
    if (matches.length === 0) {
      throw new Error(`„${amount.foodName}“ gehört nicht zu dieser Mahlzeit. Zuerst rosie_tag_anzeigen aufrufen.`);
    }
    if (matches.length > 1) {
      throw new Error(`„${amount.foodName}“ ist nicht eindeutig. Bitte den exakten Namen aus rosie_tag_anzeigen verwenden.`);
    }
    result.set(matches[0].id, amount.grams);
  }
  return result;
}

function serializeDay(
  day: DayView,
  today: string,
  lastMealAt: string | null,
  foods: Array<{ name: string; kind: FeedKind }>,
): AgentDayResult {
  return {
    date: day.date,
    today,
    lastMealAt,
    balance: day.balance,
    foods: foods.map((food) => ({ name: food.name, kind: food.kind })),
    totals: day.totals.map((total) => ({
      name: total.name,
      kind: total.kind,
      targetGrams: total.targetGrams,
      kcalPer100g: total.kcalPer100g ?? null,
      fedGrams: total.actualGrams,
      remainingGrams: total.remainingGrams,
    })),
    meals: day.meals.map((meal) => ({
      number: meal.number,
      extra: meal.extra,
      status: meal.completed ? "recorded" : "open",
      completedAt: meal.completedAt,
      recordedVia: meal.recordedVia,
      amounts: meal.allocations.map((allocation) => ({
        name: allocation.name,
        kind: allocation.kind,
        suggestedGrams: allocation.plannedGrams,
        actualGrams: allocation.actualGrams,
      })),
      medications: meal.medications.map((medication) => ({
        name: medication.name,
        targetAmount: medication.targetAmount,
        unit: medication.unit,
        given: medication.given,
        givenAt: medication.givenAt,
      })),
    })),
  };
}

function summarizeMeal(meal: MealView): string {
  const time = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(new Date(meal.completedAt!));
  const amounts = meal.allocations
    .filter((allocation) => Number(allocation.actualGrams ?? 0) > 0)
    .map((allocation) => `${formatGram(Number(allocation.actualGrams))} g ${allocation.name}`)
    .join(", ");
  return `Eingetragen: ${time} Uhr – ${amounts}.`;
}

function normalizeFoodName(value: string): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeAmounts(amounts: AgentFoodAmount[], requirePositive: boolean): AgentFoodAmount[] {
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new Error("Mindestens eine Futtermenge muss angegeben werden.");
  }
  const normalized = amounts.map((amount) => ({
    foodName: normalizeFoodName(amount.foodName),
    grams: roundGram(Number(amount.grams)),
  })).sort((a, b) => a.foodName.localeCompare(b.foodName));
  if (normalized.some((amount) => !amount.foodName || !Number.isFinite(amount.grams) || amount.grams < 0 || amount.grams > 10_000)) {
    throw new Error("Bitte gültige Futterangaben zwischen 0 und 10.000 g übermitteln.");
  }
  if (requirePositive && !normalized.some((amount) => amount.grams > 0)) {
    throw new Error("Mindestens eine Futtermenge muss größer als 0 g sein.");
  }
  if (new Set(normalized.map((amount) => amount.foodName.toLocaleLowerCase("de-DE"))).size !== normalized.length) {
    throw new Error("Eine Futtersorte wurde doppelt angegeben.");
  }
  return normalized;
}

function roundGram(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function formatGram(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
}
