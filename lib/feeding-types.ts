export type FeedKind = "wet" | "dry";

export type FeedItem = { id: string; name: string; kind: FeedKind };
export type PlanItem = FeedItem & { dailyGrams: number };
export type PlanView = {
  id: string;
  effectiveDate: string;
  mealCount: number;
  items: PlanItem[];
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
  allocations: MealAllocation[];
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
  feedItems: FeedItem[];
  currentPlan: PlanView | null;
  day: DayView | null;
};
