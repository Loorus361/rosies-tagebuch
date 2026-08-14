import {
  addExtraMeal,
  createFeedItem,
  getFeedingDay,
  getFeedingState,
  removeOpenMeal,
  saveMeal,
  savePlan,
} from "@/db/feeding";

export default {
  async fetch(request: Request): Promise<Response> {
    const ownerId = request.headers.get("oai-authenticated-user-id") ?? "";
    if (!ownerId) return Response.json({ error: "Nicht angemeldet." }, { status: 401 });

    try {
      if (request.method === "GET") {
        const date = new URL(request.url).searchParams.get("date") ?? "";
        return Response.json(await getFeedingState(ownerId, date));
      }

      const body = await request.json() as Record<string, unknown>;
      switch (body.action) {
        case "create_item":
          await createFeedItem(ownerId, body.name, body.kind);
          break;
        case "save_plan":
          await savePlan(ownerId, body);
          break;
        case "save_meal":
          await saveMeal(ownerId, body.mealId, body.actuals);
          break;
        case "add_extra_meal":
          await addExtraMeal(ownerId, body.date);
          return Response.json({ ok: true, day: await getFeedingDay(ownerId, String(body.date)) });
        case "remove_meal": {
          const date = await removeOpenMeal(ownerId, body.mealId);
          return Response.json({ ok: true, day: await getFeedingDay(ownerId, date) });
        }
        default:
          return Response.json({ error: "Unbekannte Aktion." }, { status: 400 });
      }
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Etwas ist schiefgegangen." },
        { status: 400 },
      );
    }
  },
};
