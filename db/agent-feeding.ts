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

export type AgentDayResult = {
  date: string;
  today: string;
  lastMealAt: string | null;
  foods: Array<{ name: string; kind: FeedKind }>;
  totals: Array<{
    name: string;
    kind: FeedKind;
    targetGrams: number;
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
  if (!Array.isArray(input.amounts) || input.amounts.length === 0) {
    throw new Error("Mindestens eine Futtermenge muss angegeben werden.");
  }

  const normalizedAmounts = input.amounts.map((amount) => ({
    foodName: normalizeFoodName(amount.foodName),
    grams: roundGram(Number(amount.grams)),
  })).sort((a, b) => a.foodName.localeCompare(b.foodName));
  if (normalizedAmounts.some((amount) => !amount.foodName || !Number.isFinite(amount.grams) || amount.grams < 0 || amount.grams > 10_000)) {
    throw new Error("Bitte gültige Futterangaben zwischen 0 und 10.000 g übermitteln.");
  }
  if (!normalizedAmounts.some((amount) => amount.grams > 0)) {
    throw new Error("Mindestens eine Futtermenge muss größer als 0 g sein.");
  }
  if (new Set(normalizedAmounts.map((amount) => amount.foodName.toLocaleLowerCase("de-DE"))).size !== normalizedAmounts.length) {
    throw new Error("Eine Futtersorte wurde doppelt angegeben.");
  }

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
    foods: foods.map((food) => ({ name: food.name, kind: food.kind })),
    totals: day.totals.map((total) => ({
      name: total.name,
      kind: total.kind,
      targetGrams: total.targetGrams,
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

function roundGram(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function formatGram(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
}
