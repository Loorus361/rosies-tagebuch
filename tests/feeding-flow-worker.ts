import { getFeedingState } from "@/db/feeding";
import { mutateFeeding } from "@/db/feeding-mutation";

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
      return Response.json(await mutateFeeding(ownerId, body));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Etwas ist schiefgegangen." },
        { status: 400 },
      );
    }
  },
};
