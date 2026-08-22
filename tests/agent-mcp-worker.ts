import { createAgentAccessToken } from "@/db/agent-access";
import { createFeedItem, getFeedingState, savePlan } from "@/db/feeding";
import { POST as mcpPost } from "@/app/api/hermes-mcp/route";

const OWNER_ID = "agent-qa-owner";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/seed" && request.method === "POST") {
      await createFeedItem(OWNER_ID, "Agent Nassfutter", "wet");
      await createFeedItem(OWNER_ID, "Agent Trockenfutter", "dry");
      const state = await getFeedingState(OWNER_ID, berlinToday());
      const wet = state.feedItems.find((item) => item.kind === "wet")!;
      const dry = state.feedItems.find((item) => item.kind === "dry")!;
      await savePlan(OWNER_ID, {
        effectiveDate: berlinToday(),
        mealCount: 2,
        items: [
          { feedItemId: wet.id, dailyGrams: 100 },
          { feedItemId: dry.id, dailyGrams: 20 },
        ],
      });
      return Response.json({ token: await createAgentAccessToken(OWNER_ID) });
    }
    if (url.pathname === "/state") {
      return Response.json(await getFeedingState(OWNER_ID, berlinToday()));
    }
    if (url.pathname === "/api/hermes-mcp") return mcpPost(request);
    return new Response("Not found", { status: 404 });
  },
};

function berlinToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
