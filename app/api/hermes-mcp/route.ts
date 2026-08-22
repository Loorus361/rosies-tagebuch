// Dedicated non-reserved route for Hermes' Streamable HTTP MCP connection.
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authenticateAgentToken } from "@/db/agent-access";
import {
  correctAgentMeal,
  documentAgentMedication,
  getAgentFeedingDay,
  recordAgentMeal,
} from "@/db/agent-feeding";

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
        "Für Korrekturen oder Medikamente die dafür vorgesehenen separaten Werkzeuge verwenden.",
        "Keine Pläne ändern und keine Einträge löschen.",
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

  server.registerTool(
    "rosie_futter_korrigieren",
    {
      title: "Rosies Fütterungseintrag korrigieren",
      description: [
        "Korrigiert Mengen und Uhrzeit einer bereits eingetragenen Mahlzeit.",
        "Vorher rosie_tag_anzeigen aufrufen.",
        "Alle Futtersorten der Mahlzeit müssen mit vollständigen Ist-Mengen angegeben werden, auch Sorten mit 0 g.",
        "Nur auf einen eindeutigen Korrekturauftrag von Carlos aufrufen.",
        "Bei einer technischen Wiederholung dieselbe idempotency_key erneut verwenden.",
      ].join(" "),
      inputSchema: z.object({
        date: dateSchema.optional(),
        meal_number: z.number().int().min(1).max(100)
          .describe("Nummer der bereits eingetragenen Mahlzeit aus rosie_tag_anzeigen"),
        time: timeSchema.describe("Vollständige korrigierte lokale Uhrzeit"),
        amounts: z.array(z.object({
          food_name: z.string().min(1).max(80).describe("Exakter Futtername aus rosie_tag_anzeigen"),
          grams: z.number().min(0).max(10_000),
        })).min(1).describe("Vollständige Ist-Mengen aller Futtersorten dieser Mahlzeit"),
        idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
          .describe("Pro Korrekturauftrag einmalig erzeugen und bei Wiederholungen unverändert wiederverwenden."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ date, meal_number, time, amounts, idempotency_key }) => {
      if (!ownerId) throw new Error("Der private Datenbereich fehlt.");
      const result = await correctAgentMeal(ownerId, {
        date,
        mealNumber: meal_number,
        time,
        amounts: amounts.map((amount) => ({ foodName: amount.food_name, grams: amount.grams })),
        idempotencyKey: idempotency_key,
      });
      return {
        content: [{ type: "text", text: result.summary }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "rosie_medikament_dokumentieren",
    {
      title: "Rosies Medikament dokumentieren",
      description: [
        "Markiert ein für eine konkrete Mahlzeit geplantes Medikament als gegeben oder nicht gegeben.",
        "Vorher rosie_tag_anzeigen aufrufen und Mahlzeit sowie Medikamentenname exakt übernehmen.",
        "Berechnet keine Dosierung und ändert keinen Medikamentenplan.",
        "Bei einer technischen Wiederholung dieselbe idempotency_key erneut verwenden.",
      ].join(" "),
      inputSchema: z.object({
        date: dateSchema.optional(),
        meal_number: z.number().int().min(1).max(100)
          .describe("Mahlzeitennummer aus rosie_tag_anzeigen"),
        medication_name: z.string().min(1).max(80)
          .describe("Exakter Medikamentenname aus rosie_tag_anzeigen"),
        given: z.boolean()
          .describe("true dokumentiert die Gabe; false nimmt die Dokumentation zurück"),
        idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
          .describe("Pro Medikamentenauftrag einmalig erzeugen und bei Wiederholungen unverändert wiederverwenden."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ date, meal_number, medication_name, given, idempotency_key }) => {
      if (!ownerId) throw new Error("Der private Datenbereich fehlt.");
      const result = await documentAgentMedication(ownerId, {
        date,
        mealNumber: meal_number,
        medicationName: medication_name,
        given,
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
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return unauthorized("missing_access_token", "Der Bearer-Zugangsschlüssel fehlt.");
  }
  const token = readBearerToken(authorization);
  if (!token) {
    return unauthorized(
      "invalid_authorization_header",
      "Die Authorization-Kopfzeile muss genau einen Bearer-Zugangsschlüssel enthalten.",
    );
  }
  const access = await authenticateAgentToken(token);
  if (!access) {
    return unauthorized(
      "invalid_access_token",
      "Der Zugangsschlüssel ist ungültig oder widerrufen.",
    );
  }
  const authInfo: AuthInfo = {
    token: "verified",
    clientId: access.ownerId,
    scopes: ["feeding:read", "feeding:write", "medication:write"],
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

function unauthorized(code: string, message: string): Response {
  return Response.json(
    { error: code, error_description: message },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="rosies-tagebuch", error="${code}"`,
        "cache-control": "no-store",
      },
    },
  );
}
