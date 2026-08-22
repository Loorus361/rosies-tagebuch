import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  createAgentAccessToken,
  getAgentAccessStatus,
  revokeAgentAccess,
} from "@/db/agent-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: "Nicht angemeldet." }, 401);
  try {
    return noStore(await getAgentAccessStatus(user.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: "Nicht angemeldet." }, 401);
  try {
    const body = await request.json() as { action?: unknown };
    if (body.action === "revoke") {
      await revokeAgentAccess(user.userId);
      return noStore({ ok: true });
    }
    if (body.action !== "create") return noStore({ error: "Unbekannte Aktion." }, 400);
    if (!env.SITES_BYPASS_TOKEN) {
      return noStore({ error: "Der private Hermes-Zugang ist noch nicht vollständig veröffentlicht." }, 503);
    }
    const agentToken = await createAgentAccessToken(user.userId);
    const mcpUrl = `${request.nextUrl.origin}/mcp`;
    return noStore({
      ok: true,
      config: hermesConfig(mcpUrl, env.SITES_BYPASS_TOKEN, agentToken),
      mcpUrl,
    });
  } catch (error) {
    return apiError(error);
  }
}

function hermesConfig(mcpUrl: string, sitesToken: string, agentToken: string): string {
  return [
    "mcp_servers:",
    "  rosies_tagebuch:",
    `    url: ${JSON.stringify(mcpUrl)}`,
    "    headers:",
    `      OAI-Sites-Authorization: ${JSON.stringify(`Bearer ${sitesToken}`)}`,
    `      Authorization: ${JSON.stringify(`Bearer ${agentToken}`)}`,
    "    timeout: 30",
    "    connect_timeout: 20",
  ].join("\n");
}

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

function apiError(error: unknown) {
  console.error("Agent access API error", error);
  return noStore({ error: "Der Hermes-Zugang konnte gerade nicht geändert werden." }, 500);
}
