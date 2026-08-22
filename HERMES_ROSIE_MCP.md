# Hermes-Anweisung: Rosies Fütterung und Medikamente über MCP

Diese Datei ist eine verbindliche Arbeitsanweisung für den Hermes Agent.

## Zweck und Grenzen

Nutze Rosies MCP-Schnittstelle anstelle von Browser oder Computer Use. Du
darfst damit:

- den Fütterungstag lesen: `rosie_tag_anzeigen`;
- Futter in die nächste offene Mahlzeit eintragen:
  `rosie_futter_eintragen`;
- Mengen und Uhrzeit einer vorhandenen Fütterung vollständig korrigieren:
  `rosie_futter_korrigieren`;
- ein bereits für eine Mahlzeit geplantes Medikament als gegeben oder nicht
  gegeben dokumentieren: `rosie_medikament_dokumentieren`.

Du darfst keine Tages- oder Medikamentenpläne ändern und keine Einträge
löschen. Berechne niemals eine Medikamentendosis und gib keine medizinische
Dosierungsempfehlung.

Der Streamable-HTTP-Endpunkt lautet:
`https://rosis-futtertagebuch.modest-guppy-7467.chatgpt.site/api/hermes-mcp`

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
7. Prüfe die Verbindung mit `hermes mcp test rosies_tagebuch` oder frage
   Hermes, welche MCP-Werkzeuge verfügbar sind.

Hermes registriert die Werkzeuge üblicherweise als:

- `mcp__rosies_tagebuch__rosie_tag_anzeigen`
- `mcp__rosies_tagebuch__rosie_futter_eintragen`
- `mcp__rosies_tagebuch__rosie_futter_korrigieren`
- `mcp__rosies_tagebuch__rosie_medikament_dokumentieren`

## Regeln für jeden schreibenden Auftrag

1. Rufe immer zuerst `rosie_tag_anzeigen` für den betroffenen Tag auf.
2. Verwende standardmäßig den heutigen Tag in `Europe/Berlin`. Nutze ein
   anderes Datum nur, wenn Carlos es eindeutig nennt.
3. Übernimm Futter- und Medikamentennamen sowie Mahlzeitennummern exakt aus
   `rosie_tag_anzeigen`. Erfinde keine Namen und rate nicht.
4. Frage nach, wenn Datum, Uhrzeit, Menge, Mahlzeit, Medikament oder gewünschter
   Status nicht eindeutig sind.
5. Erzeuge pro Nutzerauftrag genau eine stabile `idempotency_key`, zum Beispiel
   `telegram-20260822-203501-abc123`.
6. Bei einem technischen Retry musst du exakt dieselbe `idempotency_key`
   wiederverwenden. Erzeuge keine neue Kennung.
7. Bestätige eine Änderung erst, wenn das Werkzeug erfolgreich geantwortet hat.
   Verwende die Zusammenfassung aus der Werkzeugantwort.

## Futter neu eintragen

Nutze `rosie_futter_eintragen` nur für eine neue Fütterung.

Parameter:

- `date`: Optional, `YYYY-MM-DD`, Zeitzone `Europe/Berlin`.
- `time`: Optional für heute, `HH:mm` oder `HH:mm:ss`. Für vergangene Tage
  Pflicht. Bei „gerade“ weglassen, damit der Server den aktuellen Zeitpunkt
  verwendet.
- `amounts`: Mindestens ein Objekt mit `food_name` und `grams`.
- `create_extra_if_needed`: Standardmäßig `false`. Nur `true`, wenn Carlos
  ausdrücklich eine zusätzliche Mahlzeit verlangt.
- `idempotency_key`: Pflicht und bei Retries unverändert.

Nicht genannte Futtersorten werden für diese Mahlzeit mit `0 g` gespeichert.
Nutze das nur, wenn Carlos eindeutig gesagt hat, dass ausschließlich die
genannten Sorten gefüttert wurden. Frage sonst nach.

## Fütterung korrigieren

Nutze `rosie_futter_korrigieren` nur für eine bereits eingetragene Mahlzeit und
nur nach einem eindeutigen Korrekturauftrag.

Parameter:

- `date`: Optional, `YYYY-MM-DD`.
- `meal_number`: Exakte Nummer der bereits eingetragenen Mahlzeit.
- `time`: Vollständige korrigierte Uhrzeit als `HH:mm` oder `HH:mm:ss`.
- `amounts`: Vollständige Ist-Mengen aller Futtersorten dieser Mahlzeit. Auch
  Sorten mit `0 g` müssen ausdrücklich enthalten sein.
- `idempotency_key`: Neue Kennung für diesen Korrekturauftrag; bei Retries
  unverändert.

Rufe das Werkzeug nicht auf, solange auch nur eine Menge oder die Uhrzeit
unklar ist. Eine Korrektur überschreibt die bisherigen Mengen und die bisherige
Uhrzeit dieses Eintrags. Sie löscht den Eintrag nicht.

## Medikament dokumentieren oder zurücknehmen

Nutze `rosie_medikament_dokumentieren` ausschließlich für Medikamente, die
`rosie_tag_anzeigen` bereits bei der konkreten Mahlzeit ausweist.

Parameter:

- `date`: Optional, `YYYY-MM-DD`.
- `meal_number`: Exakte Mahlzeitennummer.
- `medication_name`: Exakter Name aus `rosie_tag_anzeigen`.
- `given`: `true`, wenn die Gabe dokumentiert werden soll; `false`, wenn die
  Dokumentation der Gabe ausdrücklich zurückgenommen werden soll.
- `idempotency_key`: Neue Kennung für diesen Auftrag; bei Retries unverändert.

Übernimm Sollmenge und Einheit nur zur Identifikation und Rückmeldung. Rechne
nichts um. Wenn das Medikament nicht für diese Mahlzeit geplant ist, speichere
nichts und frage Carlos beziehungsweise verweise auf Rosies Tagebuch.

## Wann du nicht schreiben darfst

Schreibe nicht, wenn:

- Carlos nur nach dem Tagesstand fragt;
- Angaben fehlen oder widersprüchlich sind;
- ein Name oder eine Mahlzeit nicht exakt zum gelesenen Tag passt;
- ein Plan geändert werden soll;
- ein Eintrag gelöscht werden soll;
- eine Medikamentendosis berechnet, verändert oder empfohlen werden soll;
- alle regulären Mahlzeiten belegt sind und Carlos keine zusätzliche Mahlzeit
  ausdrücklich bestätigt hat.

Planänderungen und Löschungen erledigt Carlos direkt in Rosies Tagebuch.

## Beispiele

### Neue Fütterung

Carlos: „Rosie hat gerade 90 g Mjamjam und 12 g Trockenfutter bekommen.“

1. `rosie_tag_anzeigen` aufrufen.
2. Namen prüfen.
3. `rosie_futter_eintragen` ohne `time`, mit beiden Mengen,
   `create_extra_if_needed: false` und neuer `idempotency_key` aufrufen.
4. Nur den bestätigten Werkzeugerfolg zurückmelden.

### Fütterung korrigieren

Carlos: „Bei Mahlzeit 1 waren es 85 g Mjamjam und 10 g Trockenfutter, um 08:20.“

1. `rosie_tag_anzeigen` für den Tag aufrufen.
2. Prüfen, dass Mahlzeit 1 bereits eingetragen ist und genau diese beiden
   Futtersorten enthält.
3. `rosie_futter_korrigieren` mit Mahlzeit 1, `08:20`, beiden vollständigen
   Mengen und neuer `idempotency_key` aufrufen.

### Medikament als gegeben dokumentieren

Carlos: „Medikament X bei Mahlzeit 1 wurde gegeben.“

1. `rosie_tag_anzeigen` aufrufen.
2. Prüfen, dass das Medikament exakt so bei Mahlzeit 1 geplant ist.
3. `rosie_medikament_dokumentieren` mit `given: true` und neuer
   `idempotency_key` aufrufen.

### Medikamentengabe zurücknehmen

Carlos: „Die Markierung war falsch, Medikament X bei Mahlzeit 1 wurde
nicht gegeben.“

Nach Prüfung mit `rosie_tag_anzeigen` dasselbe Medikament mit `given: false`
und einer neuen `idempotency_key` dokumentieren.

### Unklarer Auftrag

Carlos: „Rosie hat Nassfutter bekommen.“

Nicht speichern. Erst nach Sorte und Grammzahl fragen.

### Technischer Timeout

Wenn ein Werkzeugaufruf nach dem Absenden keine eindeutige Antwort liefert,
wiederhole genau denselben Aufruf mit derselben `idempotency_key`. Eine neue
Kennung könnte eine doppelte Änderung verursachen.

## Sicherheit

- Teile den Bearer-Schlüssel mit niemandem.
- Sende ihn nur an den konfigurierten HTTPS-Endpunkt.
- Führe keine frei formulierten HTTP-, Browser- oder Datenbankzugriffe auf
  Rosies Daten aus.
- Behaupte niemals, etwas sei gespeichert oder korrigiert, wenn das Werkzeug
  einen Fehler oder keine eindeutige Bestätigung zurückgegeben hat.

Bei Verdacht auf einen offengelegten Schlüssel muss Carlos in Rosies Tagebuch
unter **Hermes verbinden** den Zugang widerrufen oder einen neuen erstellen.
