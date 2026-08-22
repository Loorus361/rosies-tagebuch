import { getD1 } from "./index";
import type {
  DayTotal,
  DayView,
  FeedItem,
  FeedKind,
  FeedingState,
  MealMedication,
  MealAllocation,
  MealView,
  Medication,
  PlanView,
} from "@/lib/feeding-types";

type VersionRow = { id: string; effective_date: string; meal_count: number };
type DayRow = { id: string; plan_date: string; meal_count: number; effective_date: string };
type DayItemRow = { feed_item_id: string; item_name: string; feed_kind: FeedKind; target_grams: number };
type MealRow = {
  id: string;
  meal_number: number;
  is_extra: number;
  completed_at: string | null;
  recorded_via?: "app" | "hermes" | null;
};
type AllocationRow = {
  meal_id: string;
  feed_item_id: string;
  item_name: string;
  feed_kind: FeedKind;
  planned_grams: number;
  actual_grams: number | null;
};
type MedicationDoseRow = {
  medication_id: string;
  medication_name: string;
  target_amount: string;
  unit: string;
  meal_number: number;
};
type MealMedicationRow = {
  meal_id: string;
  medication_id: string;
  medication_name: string;
  target_amount: string;
  unit: string;
  given_at: string | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function berlinToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function assertDate(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error("Bitte ein gültiges Datum wählen.");
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Bitte ein gültiges Datum wählen.");
  }
}

export async function getFeedingState(ownerId: string, selectedDate: string): Promise<FeedingState> {
  assertDate(selectedDate);
  const db = getD1();
  const today = berlinToday();
  const feedRows = await db.prepare(
    `SELECT id, name, kind FROM feed_items
     WHERE owner_id = ? ORDER BY created_at ASC, name COLLATE NOCASE ASC`,
  ).bind(ownerId).all<{ id: string; name: string; kind: FeedKind }>();
  const feedItems: FeedItem[] = feedRows.results;
  const medicationRows = await db.prepare(
    `SELECT id, name FROM medications
     WHERE owner_id = ? ORDER BY created_at ASC, name COLLATE NOCASE ASC`,
  ).bind(ownerId).all<Medication>();
  const medications: Medication[] = medicationRows.results;
  const lastMeal = await db.prepare(
    `SELECT m.completed_at
     FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
     WHERE d.owner_id = ? AND m.completed_at IS NOT NULL
     ORDER BY unixepoch(m.completed_at) DESC LIMIT 1`,
  ).bind(ownerId).first<{ completed_at: string }>();
  const currentPlan = await readPlan(ownerId, today);
  const selectedPlan = await readPlan(ownerId, selectedDate);
  let day: DayView | null = null;
  if (selectedPlan) {
    if (selectedDate > today) day = virtualDay(selectedDate, selectedPlan);
    else {
      await ensureDay(ownerId, selectedDate, selectedPlan);
      day = await readDay(ownerId, selectedDate);
    }
  } else if (selectedDate <= today) {
    day = await readDay(ownerId, selectedDate);
  }
  return {
    date: selectedDate,
    today,
    lastMealAt: lastMeal?.completed_at ?? null,
    feedItems,
    medications,
    currentPlan,
    day,
  };
}

export async function getFeedingDay(ownerId: string, selectedDate: string): Promise<DayView | null> {
  assertDate(selectedDate);
  return readDay(ownerId, selectedDate);
}

export async function createFeedItem(ownerId: string, rawName: unknown, rawKind: unknown): Promise<void> {
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 80) throw new Error("Der Futtername muss zwischen 1 und 80 Zeichen lang sein.");
  if (rawKind !== "wet" && rawKind !== "dry") throw new Error("Bitte Nass- oder Trockenfutter wählen.");
  try {
    await getD1().prepare(
      `INSERT INTO feed_items (id, owner_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), ownerId, name, rawKind, new Date().toISOString()).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new Error("Ein Futterbaustein mit diesem Namen existiert bereits.");
    }
    throw error;
  }
}

export async function createMedication(ownerId: string, rawName: unknown): Promise<void> {
  const name = normalizeShortText(rawName, 80);
  if (!name) throw new Error("Der Medikamentenname muss zwischen 1 und 80 Zeichen lang sein.");
  try {
    await getD1().prepare(
      `INSERT INTO medications (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), ownerId, name, new Date().toISOString()).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new Error("Ein Medikament mit diesem Namen existiert bereits.");
    }
    throw error;
  }
}

export async function savePlan(
  ownerId: string,
  input: { effectiveDate?: unknown; mealCount?: unknown; items?: unknown; medications?: unknown },
): Promise<void> {
  assertDate(input.effectiveDate);
  const effectiveDate = input.effectiveDate;
  const today = berlinToday();
  if (effectiveDate < today) {
    throw new Error("Vergangene Tagespläne bleiben unverändert. Wähle heute oder einen künftigen Tag.");
  }
  const mealCount = Number(input.mealCount);
  if (!Number.isInteger(mealCount) || mealCount < 2 || mealCount > 6) {
    throw new Error("Bitte zwei bis sechs Mahlzeiten wählen.");
  }
  if (!Array.isArray(input.items)) throw new Error("Bitte mindestens eine Tagesmenge eintragen.");
  const requested = input.items.map((entry) => {
    const item = entry as { feedItemId?: unknown; dailyGrams?: unknown };
    const feedItemId = typeof item.feedItemId === "string" ? item.feedItemId : "";
    const dailyGrams = Number(item.dailyGrams);
    if (!feedItemId || !Number.isFinite(dailyGrams) || dailyGrams < 0 || dailyGrams > 10000) {
      throw new Error("Bitte gültige Tagesmengen zwischen 0 und 10.000 g eintragen.");
    }
    return { feedItemId, dailyGrams: roundGram(dailyGrams) };
  });
  if (!requested.some((item) => item.dailyGrams > 0)) {
    throw new Error("Mindestens eine Tagesmenge muss größer als 0 g sein.");
  }
  const ids = [...new Set(requested.map((item) => item.feedItemId))];
  if (ids.length !== requested.length) throw new Error("Ein Futterbaustein wurde doppelt übermittelt.");
  const rawMedications = input.medications === undefined ? [] : input.medications;
  if (!Array.isArray(rawMedications)) throw new Error("Bitte die Medikamentenvorgaben prüfen.");
  const requestedMedications = rawMedications.map((entry) => {
    const item = entry as {
      medicationId?: unknown;
      targetAmount?: unknown;
      unit?: unknown;
      mealNumbers?: unknown;
    };
    const medicationId = typeof item.medicationId === "string" ? item.medicationId : "";
    const targetAmount = normalizeShortText(item.targetAmount, 30);
    const unit = normalizeShortText(item.unit, 30);
    if (!medicationId || !targetAmount || !unit || !Array.isArray(item.mealNumbers)) {
      throw new Error("Bitte Name, Sollmenge, Einheit und mindestens eine Mahlzeit je Medikament angeben.");
    }
    const mealNumbers = [...new Set(item.mealNumbers.map(Number))];
    if (
      mealNumbers.length === 0
      || mealNumbers.some((number) => !Number.isInteger(number) || number < 1 || number > mealCount)
    ) {
      throw new Error("Jede Medikamentengabe muss einer regulären Mahlzeit zugeordnet sein.");
    }
    return { medicationId, targetAmount, unit, mealNumbers: mealNumbers.sort((a, b) => a - b) };
  });
  if (new Set(requestedMedications.map((item) => item.medicationId)).size !== requestedMedications.length) {
    throw new Error("Ein Medikament wurde doppelt übermittelt.");
  }
  const db = getD1();
  if (effectiveDate === today) {
    const [completed, medicationGiven] = await Promise.all([
      db.prepare(
        `SELECT COALESCE(MAX(m.meal_number), 0) AS highest
         FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
         WHERE d.owner_id = ? AND d.plan_date = ? AND m.is_extra = 0 AND m.completed_at IS NOT NULL`,
      ).bind(ownerId, today).first<{ highest: number }>(),
      db.prepare(
        `SELECT COALESCE(MAX(m.meal_number), 0) AS highest
         FROM meal_records m
         JOIN feeding_days d ON d.id = m.day_id
         JOIN meal_medications mm ON mm.meal_id = m.id
         WHERE d.owner_id = ? AND d.plan_date = ? AND m.is_extra = 0 AND mm.given_at IS NOT NULL`,
      ).bind(ownerId, today).first<{ highest: number }>(),
    ]);
    const protectedMealNumber = Math.max(
      Number(completed?.highest ?? 0),
      Number(medicationGiven?.highest ?? 0),
    );
    if (mealCount < protectedMealNumber) {
      throw new Error(`Heute enthält Mahlzeit ${protectedMealNumber} bereits einen Eintrag. Wähle mindestens ${protectedMealNumber} Mahlzeiten.`);
    }
  }
  const ownedRows = await db.prepare(
    `SELECT id, name, kind FROM feed_items WHERE owner_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(ownerId, ...ids).all<{ id: string; name: string; kind: FeedKind }>();
  if (ownedRows.results.length !== ids.length) {
    throw new Error("Mindestens ein Futterbaustein gehört nicht zu diesem privaten Bereich.");
  }
  const medicationIds = requestedMedications.map((item) => item.medicationId);
  const ownedMedications = medicationIds.length === 0
    ? { results: [] as Medication[] }
    : await db.prepare(
      `SELECT id, name FROM medications WHERE owner_id = ? AND id IN (${medicationIds.map(() => "?").join(",")})`,
    ).bind(ownerId, ...medicationIds).all<Medication>();
  if (ownedMedications.results.length !== medicationIds.length) {
    throw new Error("Mindestens ein Medikament gehört nicht zu diesem privaten Bereich.");
  }
  const positiveItems = requested.filter((item) => item.dailyGrams > 0).map((item) => ({
    ...ownedRows.results.find((row) => row.id === item.feedItemId)!,
    dailyGrams: item.dailyGrams,
  }));
  const versionId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO plan_versions (id, owner_id, effective_date, meal_count, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(versionId, ownerId, effectiveDate, mealCount, new Date().toISOString()),
    ...positiveItems.map((item) => db.prepare(
      `INSERT INTO plan_version_items (plan_version_id, feed_item_id, daily_grams) VALUES (?, ?, ?)`,
    ).bind(versionId, item.id, item.dailyGrams)),
    ...requestedMedications.flatMap((item) => item.mealNumbers.map((mealNumber) => db.prepare(
      `INSERT INTO plan_version_medication_doses
       (plan_version_id, medication_id, medication_name, target_amount, unit, meal_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      item.medicationId,
      ownedMedications.results.find((medication) => medication.id === item.medicationId)!.name,
      item.targetAmount,
      item.unit,
      mealNumber,
    ))),
  ]);
  if (effectiveDate === today) {
    await applyPlanToToday(
      ownerId,
      today,
      versionId,
      mealCount,
      positiveItems,
      requestedMedications.map((item) => ({
        ...item,
        name: ownedMedications.results.find((medication) => medication.id === item.medicationId)!.name,
      })),
    );
  }
}

export async function saveMeal(
  ownerId: string,
  mealId: unknown,
  rawActuals: unknown,
  rawCompletedTime?: unknown,
  recordedVia: "app" | "hermes" = "app",
): Promise<void> {
  if (typeof mealId !== "string" || !mealId || !Array.isArray(rawActuals)) {
    throw new Error("Die Mahlzeit konnte nicht gespeichert werden.");
  }
  const db = getD1();
  const meal = await db.prepare(
    `SELECT m.id, m.day_id, m.meal_number, m.is_extra, m.completed_at, d.plan_date
     FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
     WHERE m.id = ? AND d.owner_id = ?`,
  ).bind(mealId, ownerId).first<{
    id: string;
    day_id: string;
    meal_number: number;
    is_extra: number;
    completed_at: string | null;
    plan_date: string;
  }>();
  if (!meal) throw new Error("Diese Mahlzeit gehört nicht zu deinem privaten Bereich.");
  if (meal.plan_date > berlinToday()) {
    throw new Error("Tatsächliche Mengen können erst am jeweiligen Tag eingetragen werden.");
  }
  const allocationRows = await db.prepare(
    `SELECT feed_item_id, item_name, feed_kind, planned_grams FROM meal_allocations WHERE meal_id = ?`,
  ).bind(mealId).all<{ feed_item_id: string; item_name: string; feed_kind: FeedKind; planned_grams: number }>();
  const actuals = rawActuals.map((entry) => {
    const item = entry as { feedItemId?: unknown; actualGrams?: unknown };
    const feedItemId = typeof item.feedItemId === "string" ? item.feedItemId : "";
    const actualGrams = Number(item.actualGrams);
    if (!feedItemId || !Number.isFinite(actualGrams) || actualGrams < 0 || actualGrams > 10000) {
      throw new Error("Bitte gültige tatsächliche Mengen zwischen 0 und 10.000 g eintragen.");
    }
    return { feedItemId, actualGrams: roundGram(actualGrams) };
  });
  if (actuals.length !== allocationRows.results.length || actuals.some((item) =>
    !allocationRows.results.some((row) => row.feed_item_id === item.feedItemId))) {
    throw new Error("Die Futterangaben sind nicht mehr aktuell. Bitte lade den Tag neu.");
  }
  const targets = await db.prepare(
    `SELECT feed_item_id, item_name, feed_kind, target_grams FROM feeding_day_items WHERE day_id = ?`,
  ).bind(meal.day_id).all<DayItemRow>();
  const otherActuals = await db.prepare(
    `SELECT a.feed_item_id, COALESCE(SUM(a.actual_grams), 0) AS total
     FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
     WHERE m.day_id = ? AND m.id != ? AND m.completed_at IS NOT NULL GROUP BY a.feed_item_id`,
  ).bind(meal.day_id, mealId).all<{ feed_item_id: string; total: number }>();
  const otherMeals = await db.prepare(
    `SELECT id, meal_number, is_extra, completed_at FROM meal_records
     WHERE day_id = ? AND id != ? ORDER BY meal_number`,
  ).bind(meal.day_id, mealId).all<MealRow>();
  const openMeals = otherMeals.results.filter((item) => !item.completed_at);
  const wasCompleted = Boolean(meal.completed_at);
  const completedAt = rawCompletedTime === undefined
    ? wasCompleted ? meal.completed_at! : berlinTimestampForInstant(new Date())
    : berlinLocalTimeToIso(meal.plan_date, rawCompletedTime);
  const orderedMeals = wasCompleted ? [] : [
    ...otherMeals.results.filter((item) => item.completed_at),
    meal,
    ...openMeals,
  ];
  const statements = [
    ...actuals.map((item) => db.prepare(
      `UPDATE meal_allocations SET actual_grams = ? WHERE meal_id = ? AND feed_item_id = ?`,
    ).bind(item.actualGrams, mealId, item.feedItemId)),
    db.prepare(
      `UPDATE meal_records
       SET completed_at = ?, recorded_via = CASE WHEN completed_at IS NULL THEN ? ELSE recorded_via END
       WHERE id = ?`,
    ).bind(completedAt, recordedVia, mealId),
    ...openMeals.map((item) => db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(item.id)),
    ...orderedMeals.map((item, index) => db.prepare(
      "UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?",
    ).bind(-(index + 1), item.id, meal.day_id)),
    ...orderedMeals.map((item, index) => db.prepare(
      "UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?",
    ).bind(index + 1, item.id, meal.day_id)),
  ];
  for (const target of targets.results) {
    const previous = Number(otherActuals.results.find((row) => row.feed_item_id === target.feed_item_id)?.total ?? 0);
    const current = actuals.find((item) => item.feedItemId === target.feed_item_id)?.actualGrams ?? 0;
    const portions = distribute(Math.max(0, roundGram(target.target_grams - previous - current)), openMeals.length);
    openMeals.forEach((openMeal, index) => statements.push(db.prepare(
      `INSERT INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(openMeal.id, target.feed_item_id, target.item_name, target.feed_kind, portions[index])));
  }
  await db.batch(statements);
}

export async function setMedicationGiven(
  ownerId: string,
  rawMealId: unknown,
  rawMedicationId: unknown,
  rawGiven: unknown,
): Promise<string> {
  if (
    typeof rawMealId !== "string"
    || !rawMealId
    || typeof rawMedicationId !== "string"
    || !rawMedicationId
    || typeof rawGiven !== "boolean"
  ) {
    throw new Error("Die Medikamentengabe konnte nicht gespeichert werden.");
  }
  const db = getD1();
  const dose = await db.prepare(
    `SELECT d.plan_date
     FROM meal_medications mm
     JOIN meal_records m ON m.id = mm.meal_id
     JOIN feeding_days d ON d.id = m.day_id
     WHERE mm.meal_id = ? AND mm.medication_id = ? AND d.owner_id = ?`,
  ).bind(rawMealId, rawMedicationId, ownerId).first<{ plan_date: string }>();
  if (!dose) throw new Error("Diese Medikamentengabe gehört nicht zu deinem privaten Bereich.");
  if (dose.plan_date > berlinToday()) {
    throw new Error("Eine Medikamentengabe kann erst am jeweiligen Tag dokumentiert werden.");
  }
  await db.prepare(
    `UPDATE meal_medications SET given_at = ?
     WHERE meal_id = ? AND medication_id = ?
       AND EXISTS (
         SELECT 1 FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
         WHERE m.id = meal_medications.meal_id AND d.owner_id = ?
       )`,
  ).bind(rawGiven ? berlinTimestampForInstant(new Date()) : null, rawMealId, rawMedicationId, ownerId).run();
  return dose.plan_date;
}

export async function addExtraMeal(ownerId: string, rawDate: unknown): Promise<void> {
  assertDate(rawDate);
  const date = rawDate;
  if (date > berlinToday()) {
    throw new Error("Eine zusätzliche Mahlzeit kann erst am ausgewählten Tag angelegt werden.");
  }
  const db = getD1();
  const day = await db.prepare(
    `SELECT id FROM feeding_days WHERE owner_id = ? AND plan_date = ?`,
  ).bind(ownerId, date).first<{ id: string }>();
  if (!day) throw new Error("Für diesen Tag gibt es noch keinen Tagesplan.");

  const [targets, actuals, openMeals, lastMeal] = await Promise.all([
    db.prepare(
      `SELECT feed_item_id, item_name, feed_kind, target_grams
       FROM feeding_day_items WHERE day_id = ? ORDER BY rowid`,
    ).bind(day.id).all<DayItemRow>(),
    db.prepare(
      `SELECT a.feed_item_id, COALESCE(SUM(a.actual_grams), 0) AS total
       FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
       WHERE m.day_id = ? AND m.completed_at IS NOT NULL GROUP BY a.feed_item_id`,
    ).bind(day.id).all<{ feed_item_id: string; total: number }>(),
    db.prepare(
      `SELECT id, meal_number FROM meal_records
       WHERE day_id = ? AND completed_at IS NULL ORDER BY meal_number`,
    ).bind(day.id).all<{ id: string; meal_number: number }>(),
    db.prepare(
      `SELECT COALESCE(MAX(meal_number), 0) AS highest FROM meal_records WHERE day_id = ?`,
    ).bind(day.id).first<{ highest: number }>(),
  ]);

  const extraMeal = { id: crypto.randomUUID(), meal_number: Number(lastMeal?.highest ?? 0) + 1 };
  const allOpenMeals = [...openMeals.results, extraMeal];
  const statements = [
    db.prepare(
      `INSERT INTO meal_records (id, day_id, meal_number, is_extra, completed_at)
       VALUES (?, ?, ?, 1, NULL)`,
    ).bind(extraMeal.id, day.id, extraMeal.meal_number),
    ...openMeals.results.map((meal) =>
      db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(meal.id)),
  ];
  for (const target of targets.results) {
    const actual = Number(actuals.results.find((row) => row.feed_item_id === target.feed_item_id)?.total ?? 0);
    const portions = distribute(Math.max(0, roundGram(target.target_grams - actual)), allOpenMeals.length);
    allOpenMeals.forEach((meal, index) => statements.push(db.prepare(
      `INSERT INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(meal.id, target.feed_item_id, target.item_name, target.feed_kind, portions[index])));
  }
  await db.batch(statements);
}

export async function removeOpenMeal(ownerId: string, rawMealId: unknown): Promise<string> {
  return removeMealRecord(ownerId, rawMealId, false);
}

export async function removeCompletedMeal(ownerId: string, rawMealId: unknown): Promise<string> {
  return removeMealRecord(ownerId, rawMealId, true);
}

async function removeMealRecord(ownerId: string, rawMealId: unknown, completed: boolean): Promise<string> {
  if (typeof rawMealId !== "string" || !rawMealId) {
    throw new Error("Die Mahlzeit konnte nicht entfernt werden.");
  }
  const db = getD1();
  const meal = await db.prepare(
    `SELECT m.id, m.day_id, m.completed_at, d.plan_date
     FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
     WHERE m.id = ? AND d.owner_id = ?`,
  ).bind(rawMealId, ownerId).first<{
    id: string;
    day_id: string;
    completed_at: string | null;
    plan_date: string;
  }>();
  if (!meal) throw new Error("Diese Mahlzeit gehört nicht zu deinem privaten Bereich.");
  if (!completed && meal.completed_at) {
    throw new Error("Eine bereits gefütterte Mahlzeit bleibt als Tagebucheintrag erhalten.");
  }
  if (completed && !meal.completed_at) {
    throw new Error("Diese Mahlzeit ist noch offen. Verwende dafür ‚Mahlzeit entfernen‘.");
  }
  if (meal.plan_date > berlinToday()) {
    throw new Error("Mahlzeiten können erst am ausgewählten Tag entfernt werden.");
  }
  const documentedMedication = await db.prepare(
    `SELECT medication_name FROM meal_medications
     WHERE meal_id = ? AND given_at IS NOT NULL LIMIT 1`,
  ).bind(meal.id).first<{ medication_name: string }>();
  if (documentedMedication) {
    throw new Error(
      `Für diese Mahlzeit ist „${documentedMedication.medication_name}“ bereits als gegeben dokumentiert. Nimm diese Medikamentengabe zuerst zurück.`,
    );
  }

  const [targets, actuals, remainingMeals] = await Promise.all([
    db.prepare(
      `SELECT feed_item_id, item_name, feed_kind, target_grams
       FROM feeding_day_items WHERE day_id = ? ORDER BY rowid`,
    ).bind(meal.day_id).all<DayItemRow>(),
    db.prepare(
      `SELECT a.feed_item_id, COALESCE(SUM(a.actual_grams), 0) AS total
       FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
       WHERE m.day_id = ? AND m.id != ? AND m.completed_at IS NOT NULL GROUP BY a.feed_item_id`,
    ).bind(meal.day_id, meal.id).all<{ feed_item_id: string; total: number }>(),
    db.prepare(
      `SELECT id, meal_number, is_extra, completed_at FROM meal_records
       WHERE day_id = ? AND id != ? ORDER BY meal_number`,
    ).bind(meal.day_id, meal.id).all<MealRow>(),
  ]);
  const openMeals = remainingMeals.results.filter((item) => !item.completed_at);
  const statements = [
    db.prepare("DELETE FROM meal_records WHERE id = ? AND day_id = ?")
      .bind(meal.id, meal.day_id),
    ...remainingMeals.results.map((item, index) => db.prepare(
      "UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?",
    ).bind(-(index + 1), item.id, meal.day_id)),
    ...remainingMeals.results.map((item, index) => db.prepare(
      "UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?",
    ).bind(index + 1, item.id, meal.day_id)),
    ...openMeals.map((item) =>
      db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(item.id)),
  ];
  for (const target of targets.results) {
    const actual = Number(actuals.results.find((row) => row.feed_item_id === target.feed_item_id)?.total ?? 0);
    const portions = distribute(Math.max(0, roundGram(target.target_grams - actual)), openMeals.length);
    openMeals.forEach((openMeal, index) => statements.push(db.prepare(
      `INSERT INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(openMeal.id, target.feed_item_id, target.item_name, target.feed_kind, portions[index])));
  }
  await db.batch(statements);
  return meal.plan_date;
}

async function readPlan(ownerId: string, date: string): Promise<PlanView | null> {
  const db = getD1();
  const version = await db.prepare(
    `SELECT id, effective_date, meal_count FROM plan_versions
     WHERE owner_id = ? AND effective_date <= ?
     ORDER BY effective_date DESC, created_at DESC, id DESC LIMIT 1`,
  ).bind(ownerId, date).first<VersionRow>();
  if (!version) return null;
  const [rows, medicationDoses] = await Promise.all([
    db.prepare(
      `SELECT f.id, f.name, f.kind, p.daily_grams
       FROM plan_version_items p JOIN feed_items f ON f.id = p.feed_item_id
       WHERE p.plan_version_id = ? ORDER BY f.created_at ASC`,
    ).bind(version.id).all<{ id: string; name: string; kind: FeedKind; daily_grams: number }>(),
    db.prepare(
      `SELECT medication_id, medication_name, target_amount, unit, meal_number
       FROM plan_version_medication_doses
       WHERE plan_version_id = ? ORDER BY rowid`,
    ).bind(version.id).all<MedicationDoseRow>(),
  ]);
  const medicationIds = [...new Set(medicationDoses.results.map((dose) => dose.medication_id))];
  return {
    id: version.id,
    effectiveDate: version.effective_date,
    mealCount: version.meal_count,
    items: rows.results.map((row) => ({
      id: row.id, name: row.name, kind: row.kind, dailyGrams: Number(row.daily_grams),
    })),
    medications: medicationIds.map((medicationId) => {
      const dose = medicationDoses.results.find((item) => item.medication_id === medicationId)!;
      return {
        id: medicationId,
        name: dose.medication_name,
        targetAmount: dose.target_amount,
        unit: dose.unit,
        mealNumbers: medicationDoses.results
          .filter((item) => item.medication_id === medicationId)
          .map((item) => item.meal_number)
          .sort((a, b) => a - b),
      };
    }),
  };
}

async function ensureDay(ownerId: string, date: string, plan: PlanView): Promise<void> {
  const db = getD1();
  const existing = await db.prepare(
    "SELECT id FROM feeding_days WHERE owner_id = ? AND plan_date = ?",
  ).bind(ownerId, date).first<{ id: string }>();
  if (existing) return;
  const dayId = crypto.randomUUID();
  const mealIds = Array.from({ length: plan.mealCount }, () => crypto.randomUUID());
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO feeding_days
       (id, owner_id, plan_date, source_plan_version_id, meal_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(dayId, ownerId, date, plan.id, plan.mealCount, new Date().toISOString()),
    ...plan.items.map((item) => db.prepare(
      `INSERT OR IGNORE INTO feeding_day_items
       (day_id, feed_item_id, item_name, feed_kind, target_grams) VALUES (?, ?, ?, ?, ?)`,
    ).bind(dayId, item.id, item.name, item.kind, item.dailyGrams)),
    ...mealIds.map((id, index) => db.prepare(
      `INSERT OR IGNORE INTO meal_records (id, day_id, meal_number, is_extra, completed_at) VALUES (?, ?, ?, 0, NULL)`,
    ).bind(id, dayId, index + 1)),
    ...plan.medications.flatMap((medication) => medication.mealNumbers.map((mealNumber) => db.prepare(
      `INSERT OR IGNORE INTO meal_medications
       (meal_id, medication_id, medication_name, target_amount, unit, given_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(
      mealIds[mealNumber - 1],
      medication.id,
      medication.name,
      medication.targetAmount,
      medication.unit,
    ))),
  ];
  plan.items.forEach((item) => {
    const portions = distribute(item.dailyGrams, plan.mealCount);
    mealIds.forEach((mealId, index) => statements.push(db.prepare(
      `INSERT OR IGNORE INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(mealId, item.id, item.name, item.kind, portions[index])));
  });
  await db.batch(statements);
}

async function readDay(ownerId: string, date: string): Promise<DayView | null> {
  const db = getD1();
  const day = await db.prepare(
    `SELECT d.id, d.plan_date, d.meal_count, p.effective_date
     FROM feeding_days d LEFT JOIN plan_versions p ON p.id = d.source_plan_version_id
     WHERE d.owner_id = ? AND d.plan_date = ?`,
  ).bind(ownerId, date).first<DayRow>();
  if (!day) return null;
  const [dayItems, meals, allocations, medicationRows] = await Promise.all([
    db.prepare(
      `SELECT feed_item_id, item_name, feed_kind, target_grams FROM feeding_day_items WHERE day_id = ? ORDER BY rowid`,
    ).bind(day.id).all<DayItemRow>(),
    db.prepare(
      `SELECT id, meal_number, is_extra, completed_at, recorded_via
       FROM meal_records WHERE day_id = ? ORDER BY meal_number`,
    ).bind(day.id).all<MealRow>(),
    db.prepare(
      `SELECT a.meal_id, a.feed_item_id, a.item_name, a.feed_kind, a.planned_grams, a.actual_grams
       FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
       WHERE m.day_id = ? ORDER BY m.meal_number, a.rowid`,
    ).bind(day.id).all<AllocationRow>(),
    db.prepare(
      `SELECT mm.meal_id, mm.medication_id, mm.medication_name, mm.target_amount, mm.unit, mm.given_at
       FROM meal_medications mm JOIN meal_records m ON m.id = mm.meal_id
       WHERE m.day_id = ? ORDER BY m.meal_number, mm.rowid`,
    ).bind(day.id).all<MealMedicationRow>(),
  ]);
  const mealViews: MealView[] = meals.results.map((meal) => ({
    id: meal.id,
    number: meal.meal_number,
    extra: Boolean(meal.is_extra),
    completed: Boolean(meal.completed_at),
    completedAt: meal.completed_at,
    recordedVia: meal.recorded_via === "hermes" ? "hermes" : meal.recorded_via === "app" ? "app" : null,
    allocations: allocations.results.filter((row) => row.meal_id === meal.id).map((row): MealAllocation => ({
      id: row.feed_item_id,
      name: row.item_name,
      kind: row.feed_kind,
      plannedGrams: Number(row.planned_grams),
      actualGrams: row.actual_grams == null ? null : Number(row.actual_grams),
    })),
    medications: medicationRows.results.filter((row) => row.meal_id === meal.id).map((row): MealMedication => ({
      id: row.medication_id,
      name: row.medication_name,
      targetAmount: row.target_amount,
      unit: row.unit,
      given: Boolean(row.given_at),
      givenAt: row.given_at,
    })),
  }));
  const metadata = new Map<string, FeedItem>();
  dayItems.results.forEach((item) => metadata.set(item.feed_item_id, {
    id: item.feed_item_id, name: item.item_name, kind: item.feed_kind,
  }));
  allocations.results.forEach((item) => metadata.set(item.feed_item_id, {
    id: item.feed_item_id, name: item.item_name, kind: item.feed_kind,
  }));
  const totals: DayTotal[] = [...metadata.values()].map((item) => {
    const target = Number(dayItems.results.find((row) => row.feed_item_id === item.id)?.target_grams ?? 0);
    const actual = roundGram(allocations.results.filter(
      (row) => row.feed_item_id === item.id && row.actual_grams != null,
    ).reduce((sum, row) => sum + Number(row.actual_grams), 0));
    return { ...item, targetGrams: target, actualGrams: actual, remainingGrams: Math.max(0, roundGram(target - actual)) };
  });
  return {
    id: day.id,
    date: day.plan_date,
    mealCount: day.meal_count,
    effectiveDate: day.effective_date ?? day.plan_date,
    virtual: false,
    totals,
    meals: mealViews,
  };
}

async function applyPlanToToday(
  ownerId: string,
  date: string,
  versionId: string,
  mealCount: number,
  planItems: Array<{ id: string; name: string; kind: FeedKind; dailyGrams: number }>,
  planMedications: Array<{
    medicationId: string;
    name: string;
    targetAmount: string;
    unit: string;
    mealNumbers: number[];
  }>,
): Promise<void> {
  const db = getD1();
  const day = await db.prepare(
    "SELECT id, meal_count FROM feeding_days WHERE owner_id = ? AND plan_date = ?",
  ).bind(ownerId, date).first<{ id: string; meal_count: number }>();
  if (!day) return;
  const mealRows = await db.prepare(
    `SELECT id, meal_number, is_extra, completed_at FROM meal_records WHERE day_id = ? ORDER BY meal_number`,
  ).bind(day.id).all<MealRow>();
  const highestCompleted = Math.max(0, ...mealRows.results
    .filter((item) => !item.is_extra && item.completed_at)
    .map((item) => item.meal_number));
  if (mealCount < highestCompleted) {
    throw new Error(`Heute ist Mahlzeit ${highestCompleted} bereits abgeschlossen. Wähle mindestens ${highestCompleted} Mahlzeiten.`);
  }
  const completedActuals = await db.prepare(
    `SELECT a.feed_item_id, COALESCE(SUM(a.actual_grams), 0) AS total
     FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
     WHERE m.day_id = ? AND m.completed_at IS NOT NULL GROUP BY a.feed_item_id`,
  ).bind(day.id).all<{ feed_item_id: string; total: number }>();
  const standardRows = mealRows.results.filter((item) => !item.is_extra).sort((a, b) => a.meal_number - b.meal_number);
  const extras = mealRows.results.filter((item) => Boolean(item.is_extra)).sort((a, b) => a.meal_number - b.meal_number);
  const retainedStandards = standardRows.slice(0, mealCount);
  const obsolete = standardRows.slice(mealCount);
  const missing = Array.from(
    { length: Math.max(0, mealCount - retainedStandards.length) },
    () => ({ id: crypto.randomUUID(), meal_number: 0, is_extra: 0, completed_at: null }),
  );
  const finalStandards = [...retainedStandards, ...missing];
  const allMeals = [...finalStandards, ...extras].map((item, index) => ({ ...item, finalNumber: index + 1 }));
  const open = allMeals.filter((item) => !item.completed_at);
  const oldItems = await db.prepare(
    "SELECT feed_item_id FROM feeding_day_items WHERE day_id = ?",
  ).bind(day.id).all<{ feed_item_id: string }>();
  const statements = [
    db.prepare(
      `UPDATE feeding_days SET source_plan_version_id = ?, meal_count = ? WHERE id = ? AND owner_id = ?`,
    ).bind(versionId, mealCount, day.id, ownerId),
    ...mealRows.results.map((item, index) => db.prepare(
      `UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?`,
    ).bind(-(index + 1), item.id, day.id)),
    ...oldItems.results.map((item) => db.prepare(
      `UPDATE feeding_day_items SET target_grams = 0 WHERE day_id = ? AND feed_item_id = ?`,
    ).bind(day.id, item.feed_item_id)),
    ...planItems.map((item) => db.prepare(
      `INSERT INTO feeding_day_items (day_id, feed_item_id, item_name, feed_kind, target_grams)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day_id, feed_item_id) DO UPDATE SET
       item_name = excluded.item_name, feed_kind = excluded.feed_kind, target_grams = excluded.target_grams`,
    ).bind(day.id, item.id, item.name, item.kind, item.dailyGrams)),
    ...obsolete.map((item) => db.prepare(
      `DELETE FROM meal_records WHERE id = ? AND day_id = ?`,
    ).bind(item.id, day.id)),
    ...missing.map((item) => db.prepare(
      `INSERT INTO meal_records (id, day_id, meal_number, is_extra, completed_at) VALUES (?, ?, ?, 0, NULL)`,
    ).bind(item.id, day.id, allMeals.find((meal) => meal.id === item.id)!.finalNumber)),
    ...allMeals.filter((item) => !missing.some((newItem) => newItem.id === item.id)).map((item) => db.prepare(
      `UPDATE meal_records SET meal_number = ? WHERE id = ? AND day_id = ?`,
    ).bind(item.finalNumber, item.id, day.id)),
    ...open.filter((item) => !missing.some((newItem) => newItem.id === item.id)).map((item) =>
      db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(item.id)),
    ...open.map((item) => db.prepare(
      "DELETE FROM meal_medications WHERE meal_id = ? AND given_at IS NULL",
    ).bind(item.id)),
    ...planMedications.flatMap((medication) => medication.mealNumbers.flatMap((mealNumber) => {
      const meal = finalStandards[mealNumber - 1];
      if (!meal || meal.completed_at) return [];
      return [db.prepare(
        `INSERT OR IGNORE INTO meal_medications
         (meal_id, medication_id, medication_name, target_amount, unit, given_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).bind(meal.id, medication.medicationId, medication.name, medication.targetAmount, medication.unit)];
    })),
  ];
  for (const item of planItems) {
    const actual = Number(completedActuals.results.find((row) => row.feed_item_id === item.id)?.total ?? 0);
    const portions = distribute(Math.max(0, roundGram(item.dailyGrams - actual)), open.length);
    open.forEach((meal, index) => statements.push(db.prepare(
      `INSERT INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(meal.id, item.id, item.name, item.kind, portions[index])));
  }
  await db.batch(statements);
}

function virtualDay(date: string, plan: PlanView): DayView {
  const meals = Array.from({ length: plan.mealCount }, (_, index): MealView => ({
    id: `preview-${index + 1}`,
    number: index + 1,
    extra: false,
    completed: false,
    completedAt: null,
    recordedVia: null,
    allocations: plan.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      plannedGrams: distribute(item.dailyGrams, plan.mealCount)[index],
      actualGrams: null,
    })),
    medications: plan.medications.filter((medication) => medication.mealNumbers.includes(index + 1)).map((medication) => ({
      id: medication.id,
      name: medication.name,
      targetAmount: medication.targetAmount,
      unit: medication.unit,
      given: false,
      givenAt: null,
    })),
  }));
  return {
    id: null,
    date,
    mealCount: plan.mealCount,
    effectiveDate: plan.effectiveDate,
    virtual: true,
    totals: plan.items.map((item) => ({
      id: item.id, name: item.name, kind: item.kind,
      targetGrams: item.dailyGrams, actualGrams: 0, remainingGrams: item.dailyGrams,
    })),
    meals,
  };
}

function distribute(total: number, count: number): number[] {
  if (count <= 0) return [];
  const totalTenths = Math.round(total * 10);
  const base = Math.floor(totalTenths / count);
  let remainder = totalTenths - base * count;
  return Array.from({ length: count }, () => (base + (remainder-- > 0 ? 1 : 0)) / 10);
}

function roundGram(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeShortText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength ? normalized : "";
}

function berlinLocalTimeToIso(date: string, rawTime: unknown): string {
  if (typeof rawTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(rawTime)) {
    throw new Error("Bitte eine gültige Uhrzeit wählen.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = rawTime.split(":").map(Number);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, second));
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    if (
      Number(parts.year) === year
      && Number(parts.month) === month
      && Number(parts.day) === day
      && Number(parts.hour) === hour
      && Number(parts.minute) === minute
      && Number(parts.second) === second
    ) {
      return `${date}T${padTime(hour)}:${padTime(minute)}:${padTime(second)}.000+0${offsetHours}:00`;
    }
  }
  throw new Error("Diese Uhrzeit ist an dem gewählten Tag nicht verfügbar.");
}

function berlinTimestampForInstant(instant: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const instantWithoutMillis = Math.floor(instant.valueOf() / 1000) * 1000;
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((localAsUtc - instantWithoutMillis) / 60_000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const millis = String(instant.getUTCMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${millis}${offsetSign}${padTime(Math.floor(absoluteOffset / 60))}:${padTime(absoluteOffset % 60)}`;
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}
