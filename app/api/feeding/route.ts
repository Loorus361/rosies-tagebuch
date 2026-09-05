import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser, isRosieOwner } from "@/app/chatgpt-auth";
import { assertDate, berlinToday, getFeedingState } from "@/db/feeding";
import { mutateFeeding } from "@/db/feeding-mutation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  if (!(await isRosieOwner(user))) return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  try {
    const date = request.nextUrl.searchParams.get("date") ?? berlinToday();
    assertDate(date);
    return NextResponse.json(await getFeedingState(user.userId, date), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  if (!(await isRosieOwner(user))) return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    return NextResponse.json(await mutateFeeding(user.userId, body));
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
