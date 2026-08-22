import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser, isRosieOwner } from "@/app/chatgpt-auth";
import {
  createAgentAccessToken,
  getAgentAccessStatus,
  revokeAgentAccess,
} from "@/db/agent-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: "Nicht angemeldet." }, 401);
  if (!(await isRosieOwner(user))) return noStore({ error: "Kein Zugriff." }, 403);
  try {
    return noStore(await getAgentAccessStatus(user.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: "Nicht angemeldet." }, 401);
  if (!(await isRosieOwner(user))) return noStore({ error: "Kein Zugriff." }, 403);
  try {
    const body = await request.json() as { action?: unknown };
    if (body.action === "revoke") {
      await revokeAgentAccess(user.userId);
      return noStore({ ok: true });
    }
    if (body.action !== "create") return noStore({ error: "Unbekannte Aktion." }, 400);
    const agentToken = await createAgentAccessToken(user.userId);
    const mcpUrl = `${request.nextUrl.origin}/api/hermes-mcp`;
    return noStore({
      ok: true,
      config: hermesConfig(mcpUrl, agentToken),
      mcpUrl,
    });
  } catch (error) {
    return apiError(error);
  }
}

function hermesConfig(mcpUrl: string, agentToken: string): string {
  return [
    "mcp_servers:",
    "  rosies_tagebuch:",
    `    url: ${JSON.stringify(mcpUrl)}`,
    "    headers:",
    `      Authorization: ${JSON.stringify(`Bearer ${agentToken}`)}`,
    "    timeout: 30",
    "    connect_timeout: 20",
    "    tools:",
    "      include:",
    "        - rosie_tag_anzeigen",
    "        - rosie_futter_eintragen",
    "        - rosie_futter_korrigieren",
    "        - rosie_medikament_dokumentieren",
    "      resources: false",
    "      prompts: false",
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
