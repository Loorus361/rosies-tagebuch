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
Oberfläche und werden als solche gekennzeichnet. Hermes darf außerdem
vollständige Mengen-/Zeitkorrekturen vornehmen und den Status bereits geplanter
Medikamente setzen oder zurücknehmen. Planänderungen und Löschwerkzeuge sind
nicht Teil des MCP-Servers; eine Dosierung wird nie berechnet.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: Produktions-Build und serverseitige Zugriffstests
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

## Flexibler Futterausgleich

Die Standardmengen bleiben die Basis. `lib/feeding-energy.ts` berechnet bei jedem Lesen des Tages die offenen Vorschläge aus den tatsächlichen Einträgen neu; gespeicherte Vorschläge sind keine verbindlichen Restmengen. Das gilt auch für Hermes. Überschüsse gleichen Defizite anderer Sorten aus, die verbleibende Mischung orientiert sich an den noch nicht gefütterten Standardmengen (Rundung auf 0,1 g).

Sind für alle verwendeten Sorten kcal/100 g bekannt, gilt ein gemeinsames Energiebudget aus `Summe(Standardgramm × kcal/100 g / 100)`. Andernfalls bleiben Nasssorten getrennt; Trockenfutter wird mit vollständigen Trockenfutter-Energiewerten gewichtet, sonst ausdrücklich näherungsweise 1:1 verrechnet. Es werden keine Herstellerwerte anhand eines Markennamens geraten.

Energiewerte werden separat mit `save_energy` gespeichert und gelten ab dem aktuellen Berliner Datum. Die append-only Tabelle `feed_energy_versions` erhält frühere Werte für frühere Tage. Leere Werte bedeuten unbekannt. Tagespläne, tatsächliche Fütterungsmengen und Medikamente werden durch diese Einstellung nicht geändert.

Herstellerbeispiele (geprüft am 05.09.2026): [Platinum Adult Chicken](https://www.platinum.com/Hund/Produkte-Hundefutter/Trockenfutter/Adult-Chicken.html) 364,4 kcal/100 g; [Royal Canin Gastrointestinal trocken](https://www.royalcanin.com/de/dogs/products/vet-products/gastrointestinal-3911) 412,6 kcal/100 g; [Gastrointestinal Mousse](https://www.royalcanin.com/de/dogs/products/vet-products/gastrointestinal-4038) 110,4 kcal/100 g. 100 g dieser Mousse entsprechen energetisch ca. 26,8 g des genannten Trockenfutters, nicht pauschal 10 g. Maßgeblich ist die konkrete Packung; Energiegleichheit garantiert keine gleiche Nährstoffzusammensetzung.
