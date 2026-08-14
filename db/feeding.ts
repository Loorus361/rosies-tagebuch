import { getD1 } from "./index";
import type {
  DayTotal,
  DayView,
  FeedItem,
  FeedKind,
  FeedingState,
  MealAllocation,
  MealView,
  PlanView,
} from "@/lib/feeding-types";

type VersionRow = { id: string; effective_date: string; meal_count: number };
type DayRow = { id: string; plan_date: string; meal_count: number; effective_date: string };
type DayItemRow = { feed_item_id: string; item_name: string; feed_kind: FeedKind; target_grams: number };
type MealRow = { id: string; meal_number: number; completed_at: string | null };
type AllocationRow = {
  meal_id: string;
  feed_item_id: string;
  item_name: string;
  feed_kind: FeedKind;
  planned_grams: number;
  actual_grams: number | null;
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
  return { date: selectedDate, today, feedItems, currentPlan, day };
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

export async function savePlan(
  ownerId: string,
  input: { effectiveDate?: unknown; mealCount?: unknown; items?: unknown },
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
  const db = getD1();
  if (effectiveDate === today) {
    const completed = await db.prepare(
      `SELECT COALESCE(MAX(m.meal_number), 0) AS highest
       FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
       WHERE d.owner_id = ? AND d.plan_date = ? AND m.completed_at IS NOT NULL`,
    ).bind(ownerId, today).first<{ highest: number }>();
    if (mealCount < Number(completed?.highest ?? 0)) {
      throw new Error(`Heute ist Mahlzeit ${completed?.highest} bereits abgeschlossen. Wähle mindestens ${completed?.highest} Mahlzeiten.`);
    }
  }
  const ownedRows = await db.prepare(
    `SELECT id, name, kind FROM feed_items WHERE owner_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(ownerId, ...ids).all<{ id: string; name: string; kind: FeedKind }>();
  if (ownedRows.results.length !== ids.length) {
    throw new Error("Mindestens ein Futterbaustein gehört nicht zu diesem privaten Bereich.");
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
  ]);
  if (effectiveDate === today) {
    await applyPlanToToday(ownerId, today, versionId, mealCount, positiveItems);
  }
}

export async function saveMeal(ownerId: string, mealId: unknown, rawActuals: unknown): Promise<void> {
  if (typeof mealId !== "string" || !mealId || !Array.isArray(rawActuals)) {
    throw new Error("Die Mahlzeit konnte nicht gespeichert werden.");
  }
  const db = getD1();
  const meal = await db.prepare(
    `SELECT m.id, m.day_id, m.meal_number, d.plan_date
     FROM meal_records m JOIN feeding_days d ON d.id = m.day_id
     WHERE m.id = ? AND d.owner_id = ?`,
  ).bind(mealId, ownerId).first<{ id: string; day_id: string; meal_number: number; plan_date: string }>();
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
  const openMeals = await db.prepare(
    `SELECT id, meal_number FROM meal_records
     WHERE day_id = ? AND id != ? AND completed_at IS NULL ORDER BY meal_number`,
  ).bind(meal.day_id, mealId).all<{ id: string; meal_number: number }>();
  const statements = [
    ...actuals.map((item) => db.prepare(
      `UPDATE meal_allocations SET actual_grams = ? WHERE meal_id = ? AND feed_item_id = ?`,
    ).bind(item.actualGrams, mealId, item.feedItemId)),
    db.prepare("UPDATE meal_records SET completed_at = ? WHERE id = ?").bind(new Date().toISOString(), mealId),
    ...openMeals.results.map((item) => db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(item.id)),
  ];
  for (const target of targets.results) {
    const previous = Number(otherActuals.results.find((row) => row.feed_item_id === target.feed_item_id)?.total ?? 0);
    const current = actuals.find((item) => item.feedItemId === target.feed_item_id)?.actualGrams ?? 0;
    const portions = distribute(Math.max(0, roundGram(target.target_grams - previous - current)), openMeals.results.length);
    openMeals.results.forEach((openMeal, index) => statements.push(db.prepare(
      `INSERT INTO meal_allocations
       (meal_id, feed_item_id, item_name, feed_kind, planned_grams, actual_grams)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(openMeal.id, target.feed_item_id, target.item_name, target.feed_kind, portions[index])));
  }
  await db.batch(statements);
}

async function readPlan(ownerId: string, date: string): Promise<PlanView | null> {
  const db = getD1();
  const version = await db.prepare(
    `SELECT id, effective_date, meal_count FROM plan_versions
     WHERE owner_id = ? AND effective_date <= ?
     ORDER BY effective_date DESC, created_at DESC, id DESC LIMIT 1`,
  ).bind(ownerId, date).first<VersionRow>();
  if (!version) return null;
  const rows = await db.prepare(
    `SELECT f.id, f.name, f.kind, p.daily_grams
     FROM plan_version_items p JOIN feed_items f ON f.id = p.feed_item_id
     WHERE p.plan_version_id = ? ORDER BY f.created_at ASC`,
  ).bind(version.id).all<{ id: string; name: string; kind: FeedKind; daily_grams: number }>();
  return {
    id: version.id,
    effectiveDate: version.effective_date,
    mealCount: version.meal_count,
    items: rows.results.map((row) => ({
      id: row.id, name: row.name, kind: row.kind, dailyGrams: Number(row.daily_grams),
    })),
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
      `INSERT OR IGNORE INTO meal_records (id, day_id, meal_number, completed_at) VALUES (?, ?, ?, NULL)`,
    ).bind(id, dayId, index + 1)),
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
  const [dayItems, meals, allocations] = await Promise.all([
    db.prepare(
      `SELECT feed_item_id, item_name, feed_kind, target_grams FROM feeding_day_items WHERE day_id = ? ORDER BY rowid`,
    ).bind(day.id).all<DayItemRow>(),
    db.prepare(
      `SELECT id, meal_number, completed_at FROM meal_records WHERE day_id = ? ORDER BY meal_number`,
    ).bind(day.id).all<MealRow>(),
    db.prepare(
      `SELECT a.meal_id, a.feed_item_id, a.item_name, a.feed_kind, a.planned_grams, a.actual_grams
       FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
       WHERE m.day_id = ? ORDER BY m.meal_number, a.rowid`,
    ).bind(day.id).all<AllocationRow>(),
  ]);
  const mealViews: MealView[] = meals.results.map((meal) => ({
    id: meal.id,
    number: meal.meal_number,
    completed: Boolean(meal.completed_at),
    allocations: allocations.results.filter((row) => row.meal_id === meal.id).map((row): MealAllocation => ({
      id: row.feed_item_id,
      name: row.item_name,
      kind: row.feed_kind,
      plannedGrams: Number(row.planned_grams),
      actualGrams: row.actual_grams == null ? null : Number(row.actual_grams),
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
): Promise<void> {
  const db = getD1();
  const day = await db.prepare(
    "SELECT id FROM feeding_days WHERE owner_id = ? AND plan_date = ?",
  ).bind(ownerId, date).first<{ id: string }>();
  if (!day) return;
  const mealRows = await db.prepare(
    `SELECT id, meal_number, completed_at FROM meal_records WHERE day_id = ? ORDER BY meal_number`,
  ).bind(day.id).all<MealRow>();
  const highestCompleted = Math.max(0, ...mealRows.results.filter((item) => item.completed_at).map((item) => item.meal_number));
  if (mealCount < highestCompleted) {
    throw new Error(`Heute ist Mahlzeit ${highestCompleted} bereits abgeschlossen. Wähle mindestens ${highestCompleted} Mahlzeiten.`);
  }
  const completedActuals = await db.prepare(
    `SELECT a.feed_item_id, COALESCE(SUM(a.actual_grams), 0) AS total
     FROM meal_allocations a JOIN meal_records m ON m.id = a.meal_id
     WHERE m.day_id = ? AND m.completed_at IS NOT NULL GROUP BY a.feed_item_id`,
  ).bind(day.id).all<{ feed_item_id: string; total: number }>();
  const kept = mealRows.results.filter((item) => item.meal_number <= mealCount || Boolean(item.completed_at));
  const missing = Array.from({ length: mealCount }, (_, index) => index + 1)
    .filter((number) => !kept.some((item) => item.meal_number === number))
    .map((number) => ({ id: crypto.randomUUID(), meal_number: number, completed_at: null }));
  const allMeals = [...kept, ...missing].sort((a, b) => a.meal_number - b.meal_number);
  const open = allMeals.filter((item) => !item.completed_at && item.meal_number <= mealCount);
  const obsolete = mealRows.results.filter((item) => !item.completed_at && item.meal_number > mealCount);
  const oldItems = await db.prepare(
    "SELECT feed_item_id FROM feeding_day_items WHERE day_id = ?",
  ).bind(day.id).all<{ feed_item_id: string }>();
  const statements = [
    db.prepare(
      `UPDATE feeding_days SET source_plan_version_id = ?, meal_count = ? WHERE id = ? AND owner_id = ?`,
    ).bind(versionId, mealCount, day.id, ownerId),
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
      `INSERT INTO meal_records (id, day_id, meal_number, completed_at) VALUES (?, ?, ?, NULL)`,
    ).bind(item.id, day.id, item.meal_number)),
    ...open.filter((item) => !missing.some((newItem) => newItem.id === item.id)).map((item) =>
      db.prepare("DELETE FROM meal_allocations WHERE meal_id = ?").bind(item.id)),
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
    completed: false,
    allocations: plan.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      plannedGrams: distribute(item.dailyGrams, plan.mealCount)[index],
      actualGrams: null,
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
