import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  assertDate,
  addExtraMeal,
  berlinToday,
  createFeedItem,
  getFeedingDay,
  getFeedingState,
  removeCompletedMeal,
  removeOpenMeal,
  saveMeal,
  savePlan,
} from "@/db/feeding";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  try {
    const date = request.nextUrl.searchParams.get("date") ?? berlinToday();
    assertDate(date);
    return NextResponse.json(await getFeedingState(user.userId, date));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    switch (body.action) {
      case "create_item":
        await createFeedItem(user.userId, body.name, body.kind);
        break;
      case "save_plan":
        await savePlan(user.userId, body);
        break;
      case "save_meal":
        await saveMeal(user.userId, body.mealId, body.actuals, body.completedTime);
        break;
      case "add_extra_meal":
        assertDate(body.date);
        await addExtraMeal(user.userId, body.date);
        return NextResponse.json({ ok: true, day: await getFeedingDay(user.userId, body.date) });
      case "remove_meal": {
        const date = await removeOpenMeal(user.userId, body.mealId);
        return NextResponse.json({ ok: true, day: await getFeedingDay(user.userId, date) });
      }
      case "delete_meal_entry": {
        const date = await removeCompletedMeal(user.userId, body.mealId);
        return NextResponse.json({ ok: true, day: await getFeedingDay(user.userId, date) });
      }
      default:
        return NextResponse.json({ error: "Unbekannte Aktion." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

function apiError(error: unknown) {
  console.error("Feeding API error", error);
  const message = error instanceof Error ? error.message : "Etwas ist schiefgegangen.";
  const isDatabaseError = /D1|SQLITE|database|binding/i.test(message);
  return NextResponse.json(
    { error: isDatabaseError ? "Die Daten konnten gerade nicht gespeichert werden. Bitte versuche es erneut." : message },
    { status: isDatabaseError ? 500 : 400 },
  );
}
