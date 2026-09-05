import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const feedItems = sqliteTable("feed_items", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["wet", "dry"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_feed_items_owner_created").on(table.ownerId, table.createdAt),
  uniqueIndex("idx_feed_items_owner_name").on(table.ownerId, table.name),
]);

export const medications = sqliteTable("medications", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_medications_owner_created").on(table.ownerId, table.createdAt),
  uniqueIndex("idx_medications_owner_name").on(table.ownerId, table.name),
]);

export const planVersions = sqliteTable("plan_versions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  effectiveDate: text("effective_date").notNull(),
  mealCount: integer("meal_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_plan_versions_owner_effective").on(table.ownerId, table.effectiveDate, table.createdAt),
]);

export const planVersionItems = sqliteTable("plan_version_items", {
  planVersionId: text("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "cascade" }),
  feedItemId: text("feed_item_id").notNull().references(() => feedItems.id),
  dailyGrams: real("daily_grams").notNull(),
}, (table) => [primaryKey({ columns: [table.planVersionId, table.feedItemId] })]);

export const planVersionMedicationDoses = sqliteTable("plan_version_medication_doses", {
  planVersionId: text("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "cascade" }),
  medicationId: text("medication_id").notNull().references(() => medications.id),
  medicationName: text("medication_name").notNull(),
  targetAmount: text("target_amount").notNull(),
  unit: text("unit").notNull(),
  mealNumber: integer("meal_number").notNull(),
}, (table) => [primaryKey({ columns: [table.planVersionId, table.medicationId, table.mealNumber] })]);

export const feedingDays = sqliteTable("feeding_days", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  planDate: text("plan_date").notNull(),
  sourcePlanVersionId: text("source_plan_version_id").references(() => planVersions.id),
  mealCount: integer("meal_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_feeding_days_owner_date").on(table.ownerId, table.planDate),
]);

export const feedingDayItems = sqliteTable("feeding_day_items", {
  dayId: text("day_id").notNull().references(() => feedingDays.id, { onDelete: "cascade" }),
  feedItemId: text("feed_item_id").notNull(),
  itemName: text("item_name").notNull(),
  feedKind: text("feed_kind", { enum: ["wet", "dry"] }).notNull(),
  targetGrams: real("target_grams").notNull(),
}, (table) => [primaryKey({ columns: [table.dayId, table.feedItemId] })]);

export const mealRecords = sqliteTable("meal_records", {
  id: text("id").primaryKey(),
  dayId: text("day_id").notNull().references(() => feedingDays.id, { onDelete: "cascade" }),
  mealNumber: integer("meal_number").notNull(),
  isExtra: integer("is_extra", { mode: "boolean" }).notNull().default(false),
  completedAt: text("completed_at"),
  recordedVia: text("recorded_via", { enum: ["app", "hermes"] }),
}, (table) => [
  uniqueIndex("idx_meal_records_day_number").on(table.dayId, table.mealNumber),
]);

export const agentAccessTokens = sqliteTable("agent_access_tokens", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("idx_agent_access_tokens_hash").on(table.tokenHash),
  index("idx_agent_access_tokens_owner_created").on(table.ownerId, table.createdAt),
]);

export const agentActionRequests = sqliteTable("agent_action_requests", {
  ownerId: text("owner_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  status: text("status", { enum: ["pending", "completed"] }).notNull(),
  resultJson: text("result_json"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.idempotencyKey] }),
  index("idx_agent_action_requests_created").on(table.createdAt),
]);

export const mealAllocations = sqliteTable("meal_allocations", {
  mealId: text("meal_id").notNull().references(() => mealRecords.id, { onDelete: "cascade" }),
  feedItemId: text("feed_item_id").notNull(),
  itemName: text("item_name").notNull(),
  feedKind: text("feed_kind", { enum: ["wet", "dry"] }).notNull(),
  plannedGrams: real("planned_grams").notNull(),
  actualGrams: real("actual_grams"),
}, (table) => [
  primaryKey({ columns: [table.mealId, table.feedItemId] }),
  index("idx_meal_allocations_feed_item").on(table.feedItemId),
]);

export const mealMedications = sqliteTable("meal_medications", {
  mealId: text("meal_id").notNull().references(() => mealRecords.id, { onDelete: "cascade" }),
  medicationId: text("medication_id").notNull(),
  medicationName: text("medication_name").notNull(),
  targetAmount: text("target_amount").notNull(),
  unit: text("unit").notNull(),
  givenAt: text("given_at"),
}, (table) => [primaryKey({ columns: [table.mealId, table.medicationId] })]);

// Effective-date history keeps later energy edits out of earlier diary days.
export const feedEnergyVersions = sqliteTable("feed_energy_versions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  feedItemId: text("feed_item_id").notNull().references(() => feedItems.id),
  kcalPer100g: real("kcal_per_100g"),
  effectiveDate: text("effective_date").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_feed_energy_owner_item_date").on(table.ownerId, table.feedItemId, table.effectiveDate, table.createdAt),
]);
