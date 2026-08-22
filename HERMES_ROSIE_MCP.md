# Hermes-Anweisung: Rosies Fütterung über MCP

Diese Datei ist eine verbindliche Arbeitsanweisung für den Hermes Agent.

## Zweck

Nutze Rosies MCP-Schnittstelle, um den aktuellen Fütterungstag zu lesen und
eindeutig beauftragte Fütterungen in Rosies Tagebuch einzutragen. Verwende dafür
keinen Browser und kein Computer Use.

Die Schnittstelle erlaubt ausschließlich:

- `rosie_tag_anzeigen`
- `rosie_futter_eintragen`

Der Streamable-HTTP-Endpunkt lautet:
`https://rosis-futtertagebuch.modest-guppy-7467.chatgpt.site/api/hermes-mcp`

Sie erlaubt keine Änderungen an Tagesplänen, Medikamenten, vorhandenen
Einträgen oder Löschungen.

## Einmalige Einrichtung

1. Carlos öffnet Rosies Tagebuch:
   `https://rosis-futtertagebuch.modest-guppy-7467.chatgpt.site`
2. Carlos wählt **Hermes verbinden**.
3. Carlos erstellt einen Hermes-Zugang und kopiert den vollständig angezeigten
   YAML-Block.
4. Füge diesen Block in `~/.hermes/config.yaml` unter `mcp_servers:` ein. Wenn
   dort bereits MCP-Server stehen, führe die Einträge zusammen und lege keinen
   zweiten Schlüssel `mcp_servers:` an.
5. Behandle den enthaltenen Bearer-Schlüssel wie ein Passwort. Gib ihn niemals
   in Chatnachrichten, Logs, Zusammenfassungen oder Antworten aus.
6. Lade die MCP-Server mit `/reload-mcp` neu oder starte Hermes neu.
7. Prüfe die Verbindung mit `hermes mcp test rosies_tagebuch` oder frage Hermes,
   welche MCP-Werkzeuge verfügbar sind.

Hermes registriert die Werkzeuge üblicherweise als:

- `mcp__rosies_tagebuch__rosie_tag_anzeigen`
- `mcp__rosies_tagebuch__rosie_futter_eintragen`

## Verbindlicher Ablauf für jeden Fütterungsauftrag

1. Rufe immer zuerst `rosie_tag_anzeigen` auf.
2. Verwende standardmäßig den heutigen Tag in der Zeitzone
   `Europe/Berlin`. Nutze ein anderes Datum nur, wenn Carlos es eindeutig
   nennt.
3. Übernimm Futternamen exakt aus `rosie_tag_anzeigen`. Erfinde keine Namen und
   rate nicht bei ähnlich benannten Sorten.
4. Prüfe, ob Carlos die tatsächlich gefütterten Grammzahlen eindeutig genannt
   hat. Bei fehlenden oder widersprüchlichen Mengen frage nach, bevor du
   speicherst.
5. Rufe anschließend `rosie_futter_eintragen` genau einmal auf.
6. Erzeuge für jeden Nutzerauftrag eine neue stabile `idempotency_key`, zum
   Beispiel `telegram-20260822-203501-abc123`. Bei einem technischen
   Wiederholungsversuch musst du exakt dieselbe `idempotency_key` verwenden.
7. Bestätige den Eintrag erst, wenn das Werkzeug erfolgreich geantwortet hat.
   Verwende die Zusammenfassung und Uhrzeit aus der Werkzeugantwort.

## Parameter für `rosie_futter_eintragen`

- `date`: Optional, Format `YYYY-MM-DD`, Zeitzone `Europe/Berlin`.
- `time`: Optional für heute, Format `HH:mm` oder `HH:mm:ss`. Für vergangene
  Tage ist die Uhrzeit Pflicht. Wenn Carlos „gerade“ sagt, lasse `time` weg,
  damit der Server den aktuellen Zeitpunkt verwendet.
- `amounts`: Mindestens ein Objekt mit `food_name` und `grams`. Der
  `food_name` muss exakt aus `rosie_tag_anzeigen` stammen.
- `create_extra_if_needed`: Standardmäßig `false`. Setze es nur dann auf
  `true`, wenn Carlos ausdrücklich eine zusätzliche Mahlzeit eintragen möchte.
- `idempotency_key`: Pflicht. Für denselben Nutzerauftrag bei jedem Retry
  unverändert wiederverwenden.

Wichtig: Futtersorten, die in `amounts` nicht genannt werden, werden für diese
Mahlzeit mit `0 g` gespeichert. Nutze dieses Verhalten nur, wenn Carlos klar
gesagt hat, dass lediglich die genannten Sorten gefüttert wurden. Frage sonst
nach.

## Wann du nicht speichern darfst

Speichere nicht, wenn:

- Datum, Uhrzeit oder Grammzahl unklar sind;
- ein Futtername nicht exakt zum aktuellen Tagesplan passt;
- Carlos nur nach dem Tagesstand fragt;
- Carlos eine Korrektur oder Löschung verlangt;
- Carlos Medikamente dokumentieren oder einen Plan ändern möchte;
- alle regulären Mahlzeiten bereits eingetragen sind und Carlos keine
  zusätzliche Mahlzeit ausdrücklich bestätigt hat.

Bei Korrekturen, Löschungen, Medikamenten oder Planänderungen verweise Carlos
auf Rosies Tagebuch.

## Beispiele

### Eindeutiger Auftrag

Carlos: „Rosie hat gerade 90 g Mjamjam und 12 g Trockenfutter bekommen.“

Vorgehen:

1. `rosie_tag_anzeigen` aufrufen.
2. Prüfen, ob `Mjamjam` und `Trockenfutter` exakt so vorhanden sind.
3. `rosie_futter_eintragen` mit den beiden Mengen, ohne `time`, mit
   `create_extra_if_needed: false` und einer neuen `idempotency_key` aufrufen.
4. Nur den bestätigten Werkzeugerfolg knapp an Carlos zurückmelden.

### Unklarer Auftrag

Carlos: „Rosie hat Nassfutter bekommen.“

Nicht speichern. Erst nach Sorte und Grammzahl fragen.

### Technischer Timeout

Wenn der erste Werkzeugaufruf nach dem Absenden keine eindeutige Antwort
liefert, wiederhole ihn ausschließlich mit derselben `idempotency_key`. Erzeuge
keine neue Kennung, sonst könnte ein doppelter Tagebucheintrag entstehen.

## Sicherheit

- Teile den Bearer-Schlüssel mit niemandem.
- Sende ihn nur an den in der Konfiguration eingetragenen HTTPS-Endpunkt.
- Führe keine frei formulierten HTTP- oder Datenbankzugriffe auf Rosies Daten
  aus.
- Behaupte niemals, ein Eintrag sei gespeichert, wenn das MCP-Werkzeug einen
  Fehler oder keine eindeutige Bestätigung zurückgegeben hat.

Bei Verdacht auf einen offengelegten Schlüssel muss Carlos in Rosies Tagebuch
unter **Hermes verbinden** den Zugang widerrufen oder einen neuen erstellen.
