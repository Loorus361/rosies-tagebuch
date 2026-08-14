# Rosis Tagebuch

Private ChatGPT-Sites-App für Rosis Fütterungsplanung und Tageshistorie.

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
Identität; jede Datenbankabfrage wird zusätzlich nach der Nutzer-ID gefiltert.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: Produktions-Build und serverseitige Zugriffstests
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
