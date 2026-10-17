# Glasklar 🍺

Trinkspiel als Webapp: Alle bekommen dieselbe „Nenne ein …"-Frage. Je offensichtlicher die Antwort, desto voller das Glas – seltene Antworten halten es leer. Nach 3 Fragen trinkt jede:r so viele Schlücke, wie das Glas voll ist (max. 10).

Füllung pro Antwort: tier1 = 3, tier2 = 2, tier3 = 1, tier4 = 0,3, tier5 = 0, „Nichts passt" = 3 (`CONFIG.fillByTier`, Dezimalwerte erlaubt). Gerundet wird erst bei der Abrechnung nach 3 Fragen: ab ,5 auf, darunter ab. Liegt die Runde über 0 und unter 0,5, heißt es nur „Mini-Schluck trinken" – ohne Zahl.

🔞 Ab 18 · Verantwortungsvoll trinken · Alkoholfrei ist völlig ok.

## Lokal starten

`fetch()` funktioniert nicht über `file://`, daher einen einfachen Server nutzen:

```bash
npx serve .          # oder: npm run serve
# → http://localhost:3000
```

## Multiplayer

Ohne Firebase-Konfiguration läuft der Multiplayer im **lokalen Testmodus**: Mehrere Tabs im selben Browser spielen gegeneinander (localStorage + BroadcastChannel). Einfach die Seite zweimal öffnen.
Mit Konfiguration lässt sich der Testmodus über `?lokal` in der URL erzwingen (z. B. `http://localhost:3000/?lokal`).

### Firebase einrichten

1. In der [Firebase-Konsole](https://console.firebase.google.com/) ein Projekt anlegen.
2. **Build → Realtime Database → Datenbank erstellen** (Standort z. B. `europe-west1`).
3. **Build → Authentication → Anmeldemethode → Anonym** aktivieren.
4. **Projekteinstellungen → Allgemein → Meine Apps → Web-App hinzufügen**, die angezeigte Konfiguration in `js/firebase-config.js` eintragen (inkl. `databaseURL`).
5. **Realtime Database → Regeln**: Inhalt von `database.rules.json` einfügen und veröffentlichen.
6. Unter **Authentication → Einstellungen → Autorisierte Domains** die GitHub-Pages-Domain ergänzen (z. B. `apollo1860.github.io`).

### Ablauf

- Raum per 4-stelligem Code (oder Einladungslink `?raum=1234`), Name wählen, Host startet ab 2 verbundenen Spielern.
- Kein Zeitlimit – bis auf eine Ausnahme: Haben alle bis auf eine:n geantwortet, bleiben dem letzten Spieler noch 20 Sekunden (`CONFIG.lastAnswerSeconds`). Der Countdown läuft über die Serverzeit (`.info/serverTimeOffset`), nicht über die Uhr des Geräts.
- Antworten liegen bis zum Reveal verdeckt (die Regeln erlauben das Lesen erst nach der Frage), danach sind Eingaben gesperrt.
- Reveal, sobald alle geantwortet haben oder die letzten 20 Sekunden abgelaufen sind.
- Reconnect: Spieler-ID und Raum werden gespeichert, beim Neuladen kommt „Zurück ins Spiel?".
- Verlässt der Host den Raum, übernimmt der älteste verbundene Spieler. Bei weniger als 2 verbundenen Spielern pausiert das Spiel (ein laufender Countdown wird angehalten).
- Räume, die länger als 6 Stunden inaktiv sind, werden beim Erstellen eines neuen Raums gelöscht.

### Datenmodell (`rooms/{code}`)

| Pfad | Inhalt |
|---|---|
| `meta` | Phase, Host, Runde, Frage-Nr., Kategorien, Pause, letzte Aktivität |
| `players/{uid}` | Name, Beitrittszeit, verbunden/ausgetreten |
| `question` | aktuelle Frage-ID, Anzeigezeit, ggf. Start der letzten 20 s (`lastCallAt`) |
| `answered/{uid}` | nur „hat geantwortet" (für alle sichtbar) |
| `answers/{uid}` | die Antwort selbst – lesbar erst nach dem Reveal |
| `fills/{uid}/q1..q3` | Füllung pro Frage der laufenden Runde |
| `history/r{n}/{uid}` | exakte Füllung pro Runde (Dezimal); Anzeige und Gesamtranking runden je Runde |
| `played/{frageId}` | im Raum schon gespielte Fragen |

Zusätzlich `roomsActivity/{code}` (nur Zeitstempel) zum Aufräumen alter Räume; abfragbar ist dort nur, was älter als 6 Stunden ist.

**Grenzen der Regeln:** Ein Raum ist nur mit Code erreichbar, schreiben darf nur, wer im Raum ist, und jeder nur seinen eigenen Spieler-Eintrag und seine eigene Antwort. Die Host-Logik selbst läuft im Browser. Ein Mitspieler, der die Seite manipuliert, könnte also Phase oder Füllungen verändern – für ein Partyspiel unter Freunden ist das vertretbar.

## Befehle

```bash
npm test             # Node-Tests für js/logic.js
npm run build-data   # data-src/*.txt → data/*.json + data/index.json
npm run validate     # prüft data/, zeigt Tabelle mit Tier-Verteilung
```

## Struktur

```
index.html
css/style.css          Heller Look, Glas-Effekte, Animationen
js/config.js           Alle Spielwerte (Füllung je tier, Cap, Aufschlag, letzte 20 s …)
js/logic.js            Reine Funktionen: Normalisierung, Suche, Bewertung, Ziehen
js/game.js             App-Start, Zustandsmaschine, Singleplayer
js/mp.js               Multiplayer-Steuerung (Lobby, Fragen, Reveal, Abrechnung, Host-Wechsel)
js/net.js              Firebase- bzw. lokales Test-Backend, Räume, Presence
js/firebase-config.js  Firebase-Konfiguration (Platzhalter)
js/common.js           Gemeinsame Bausteine (Countdown, Glas-Füllung, Einstellungen)
js/ui.js               Bildschirme, Modals, Antwort-Eingabe mit Dropdown, Fehlend-Log
js/glass.js            SVG-Glas (Wellen, Schaum, Bläschen, Shake, Overflow)
js/fx.js               Konfetti, Funkeln, Spritzer, Vibration
js/audio.js            WebAudio-Sounds (synthetisch, keine Assets)
js/data.js             Lazy-Loading der Kategorien
js/storage.js          localStorage-Helfer
data/index.json        Kategorien + Fragen-IDs (generiert)
data/{kategorie}.json  Fragen mit Antworten (generiert)
data-src/              Quelldateien zum Bearbeiten (eine .txt pro Frage)
tools/build-data.js    Baut data/ aus data-src/, hält Antwort-IDs stabil
tools/validate.js      Schema- und Qualitätsprüfung
tests/                 Node-Tests (node --test)
database.rules.json    Security Rules für die Realtime Database
```

## Fragen bearbeiten

Fragen werden in `data-src/{kategorie}/{frage-id}.txt` gepflegt und mit `npm run build-data` nach `data/` übersetzt:

```
@id geo-001
@text Nenne ein Land der Erde
# Kommentar
1 Deutschland = BRD; Bundesrepublik Deutschland
3 Dänemark
5 Dschibuti = Djibouti
```

Pro Zeile: `tier Antwort = Alias; Alias`. Bereits vergebene Antwort-IDs bleiben beim Neubauen erhalten (Abgleich über den normalisierten Text), neue Antworten bekommen die nächste freie Nummer. Danach `npm run validate`.

Optionale Kopfzeilen:

| Kopfzeile | Bedeutung |
|---|---|
| `@typ geschlossen` | Kleine, vollständig aufzählbare Menge (z. B. Länder in Ostasien). Mindestens 5 Antworten statt 60. |
| `@typ rangliste` | Wissensfrage nach Rang (z. B. Bundesland mit der höchsten Arbeitslosenquote). tier ergibt sich aus dem Rang, kein Gleiche-Antwort-Aufschlag, Lösung wird nach dem Reveal angezeigt. |
| `@loesung …` | Lösungstext für den Reveal (Pflicht bei `rangliste`). |
| `@quelle …` | Datenquelle (Dokumentation). |

Ranglisten-Füllung: US-Staaten Platz 1–3 = 0, 4–8 = 1, 9–10 = 2, Rest = 3; Bundesländer Platz 1 = 0, 2–3 = 1, 4–6 = 2, Rest = 3.

**tier** (aus Sicht deutschsprachiger Spieler, geschätzt pro 100 Mitspieler):
tier1 > 15 · tier2 5–15 · tier3 1–5 · tier4 0,2–1 · tier5 < 0,2 (aber real und bekannt).

## Eingabe

Vorschläge erscheinen erst, wenn das **ganze Wort** getippt ist – exakt (Groß-/Kleinschreibung, ä/ae/a, ß/ss, Akzente, Satzzeichen und Artikel egal) oder ab 5 Buchstaben mit einem Tippfehler („Meintest du?"). Anfangsbuchstaben oder Wortteile zeigen nichts an, damit man sich die Antworten nicht aus der Liste aussuchen kann. Alternative Schreibweisen gehören deshalb als Alias in die Daten.

Offene Fragen (ohne `@typ`, z. B. „Etwas, das man im Badezimmer findet") bekommen mehr Spielraum (`CONFIG.search.tolerant`):

- Plural und Endungen zählen als Treffer („Handtücher" → Handtuch, „Kerzen" → Kerze).
- 1 Tippfehler schon ab 4 Buchstaben, 2 Tippfehler ab 8 Buchstaben.
- Wortteile ganzer Wörter werden als „Meintest du?" vorgeschlagen („Badezimmerspiegel" → Spiegel, „elektrische Zahnbürste" → Zahnbürste, „Bürste" → Haarbürste, wenn das Getippte mindestens 60 % der Antwort ausmacht).

Die Vorschläge erscheinen immer über dem Eingabefeld.

## Fehlende Antworten ergänzen

Im Spiel werden getippte Texte ohne Treffer und jedes „Nichts passt" lokal gespeichert. Export unter **Einstellungen → Fehlende Antworten → Als JSON exportieren**.
