import {
  assertDate,
  addExtraMeal,
  berlinToday,
  createFeedItem,
  createMedication,
  getFeedingState,
  removeCompletedMeal,
  removeOpenMeal,
  saveMeal,
  savePlan,
  setMedicationGiven,
} from "./feeding";

export async function mutateFeeding(ownerId: string, body: Record<string, unknown>) {
  const selectedDate = body.selectedDate ?? body.date ?? berlinToday();
  assertDate(selectedDate);
  switch (body.action) {
    case "create_item":
      await createFeedItem(ownerId, body.name, body.kind);
      break;
    case "create_medication":
      await createMedication(ownerId, body.name);
      break;
    case "save_plan":
      await savePlan(ownerId, body);
      break;
    case "save_meal":
      await saveMeal(ownerId, body.mealId, body.actuals, body.completedTime);
      break;
    case "add_extra_meal":
      assertDate(body.date);
      await addExtraMeal(ownerId, body.date);
      break;
    case "remove_meal": {
      await removeOpenMeal(ownerId, body.mealId);
      break;
    }
    case "delete_meal_entry": {
      await removeCompletedMeal(ownerId, body.mealId);
      break;
    }
    case "set_medication_given": {
      await setMedicationGiven(ownerId, body.mealId, body.medicationId, body.given);
      break;
    }
    default:
      throw new Error("Unbekannte Aktion.");
  }
  // The write is committed. A refresh failure must never be reported as a failed write.
  try {
    const state = await getFeedingState(ownerId, selectedDate);
    return { ok: true as const, state, day: state.day };
  } catch (error) {
    console.error("Post-save refresh failed", error);
    return { ok: true as const, refreshError: "Gespeichert. Die Ansicht konnte nicht aktualisiert werden. Bitte lade den Tag erneut." };
  }
}
