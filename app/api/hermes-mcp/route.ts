// Dedicated non-reserved route for Hermes' Streamable HTTP MCP connection.
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authenticateAgentToken } from "@/db/agent-access";
import { getAgentFeedingDay, recordAgentMeal } from "@/db/agent-feeding";

export const dynamic = "force-dynamic";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Datum in Europe/Berlin als YYYY-MM-DD");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .describe("Lokale Uhrzeit in Europe/Berlin als HH:mm oder HH:mm:ss");

const handler = createMcpHandler(({ authInfo }) => {
  const ownerId = authInfo?.clientId;
  const server = new McpServer({ name: "Rosies Tagebuch", version: "1.0.0" });

  server.registerTool(
    "rosie_tag_anzeigen",
    {
      title: "Rosies Fütterungstag anzeigen",
      description: "Liest Rosies Fütterungsplan, offene Mahlzeiten und bereits gefütterte Mengen. Vor jedem Eintrag aufrufen, damit die exakten Futternamen verwendet werden.",
      inputSchema: z.object({ date: dateSchema.optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ date }) => {
      if (!ownerId) throw new Error("Der private Datenbereich fehlt.");
      const result = await getAgentFeedingDay(ownerId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "rosie_futter_eintragen",
    {
      title: "Futter für Rosie eintragen",
      description: [
        "Trägt eine Fütterung in die nächste offene Mahlzeit ein.",
        "Vorher rosie_tag_anzeigen aufrufen und die Futternamen exakt übernehmen.",
        "Nicht genannte Futtersorten werden für diese Mahlzeit mit 0 g gespeichert.",
        "Bei einer technischen Wiederholung dieselbe idempotency_key erneut verwenden.",
        "Keine Medikamente, Pläne, Korrekturen oder Löschungen durchführen.",
      ].join(" "),
      inputSchema: z.object({
        date: dateSchema.optional(),
        time: timeSchema.optional(),
        amounts: z.array(z.object({
          food_name: z.string().min(1).max(80).describe("Exakter Futtername aus rosie_tag_anzeigen"),
          grams: z.number().min(0).max(10_000),
        })).min(1),
        create_extra_if_needed: z.boolean().default(false)
          .describe("Nur true setzen, wenn Carlos ausdrücklich eine zusätzliche Mahlzeit eintragen möchte."),
        idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
          .describe("Pro Nutzerauftrag einmalig erzeugen und bei Wiederholungen unverändert wiederverwenden."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ date, time, amounts, create_extra_if_needed, idempotency_key }) => {
      if (!ownerId) throw new Error("Der private Datenbereich fehlt.");
      const result = await recordAgentMeal(ownerId, {
        date,
        time,
        amounts: amounts.map((amount) => ({ foodName: amount.food_name, grams: amount.grams })),
        createExtraIfNeeded: create_extra_if_needed,
        idempotencyKey: idempotency_key,
      });
      return {
        content: [{ type: "text", text: result.summary }],
        structuredContent: result,
      };
    },
  );

  return server;
}, { responseMode: "json" });

async function serve(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Ungültiger Ursprung." }, { status: 403 });
  }
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) return unauthorized();
  const access = await authenticateAgentToken(token);
  if (!access) return unauthorized();
  const authInfo: AuthInfo = {
    token: "verified",
    clientId: access.ownerId,
    scopes: ["feeding:read", "feeding:write"],
  };
  const response = await handler.fetch(request, { authInfo });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request) { return serve(request); }
export async function GET(request: Request) { return serve(request); }
export async function DELETE(request: Request) { return serve(request); }

function readBearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function unauthorized(): Response {
  return Response.json(
    { error: "Hermes ist nicht für Rosies Tagebuch freigeschaltet." },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="rosies-tagebuch"', "cache-control": "no-store" } },
  );
}
