export type FeedKind = "wet" | "dry";

export type FeedItem = { id: string; name: string; kind: FeedKind };
export type Medication = { id: string; name: string };
export type PlanMedication = Medication & {
  targetAmount: string;
  unit: string;
  mealNumbers: number[];
};
export type MealMedication = Medication & {
  targetAmount: string;
  unit: string;
  given: boolean;
  givenAt: string | null;
};
export type PlanItem = FeedItem & { dailyGrams: number };
export type PlanView = {
  id: string;
  effectiveDate: string;
  mealCount: number;
  items: PlanItem[];
  medications: PlanMedication[];
};
export type DayTotal = FeedItem & {
  targetGrams: number;
  actualGrams: number;
  remainingGrams: number;
};
export type MealAllocation = FeedItem & {
  plannedGrams: number;
  actualGrams: number | null;
};
export type MealView = {
  id: string;
  number: number;
  extra: boolean;
  completed: boolean;
  completedAt: string | null;
  recordedVia: "app" | "hermes" | null;
  allocations: MealAllocation[];
  medications: MealMedication[];
};
export type DayView = {
  id: string | null;
  date: string;
  mealCount: number;
  effectiveDate: string;
  virtual: boolean;
  totals: DayTotal[];
  meals: MealView[];
};
export type FeedingState = {
  date: string;
  today: string;
  lastMealAt: string | null;
  feedItems: FeedItem[];
  medications: Medication[];
  currentPlan: PlanView | null;
  day: DayView | null;
};
