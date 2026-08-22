# Rosies Tagebuch

Private ChatGPT-Sites-App für Rosies Fütterungsplanung und Tageshistorie.

## Prerequisites

- Node.js `>=22.13.0`

## Lokal starten

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

Die App nutzt Sites D1 als zentrale Datenbank. Browser-Speicher ist nicht die
Datenquelle. Seiten und API-Zugriffe verlangen die von ChatGPT bereitgestellte
Identität und zusätzlich eine feste Server-Allowlist für Carlos; jede
Datenbankabfrage wird außerdem nach der Nutzer-ID gefiltert.

## Hermes-Agent

Die App stellt unter `/api/hermes-mcp` einen privaten
Streamable-HTTP-MCP-Server bereit.
Er exponiert ausschließlich den Fütterungstag und das idempotente Eintragen in
die nächste offene Mahlzeit. Zugriff erfordert einen in D1 gehashten,
widerrufbaren Agentenschlüssel. Er wird ausschließlich über den angemeldeten
Dialog „Hermes verbinden“ bereitgestellt und darf nicht in Git eingecheckt
werden.

Hermes-Einträge verwenden dieselbe owner-gefilterte Fütterungslogik wie die
Oberfläche, werden als solche gekennzeichnet und können in der App weiterhin
korrigiert oder entfernt werden. Plan-, Medikamenten-, Korrektur- und
Löschwerkzeuge sind nicht Teil des MCP-Servers.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: Produktions-Build und serverseitige Zugriffstests
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
