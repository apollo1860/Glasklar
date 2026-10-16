# Glasklar 🍺

Trinkspiel als Webapp: Alle bekommen dieselbe „Nenne ein …"-Frage. Je offensichtlicher die Antwort, desto voller das Glas – seltene Antworten halten es leer. Nach 3 Fragen trinkt jede:r so viele Schlücke, wie das Glas voll ist (max. 10).

🔞 Ab 18 · Verantwortungsvoll trinken · Alkoholfrei ist völlig ok.

## Lokal starten

`fetch()` funktioniert nicht über `file://`, daher einen einfachen Server nutzen:

```bash
npx serve .          # oder: npm run serve
# → http://localhost:3000
```

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
js/config.js           Alle Spielwerte (Füllung je tier, Cap, Aufschlag, Timer …)
js/logic.js            Reine Funktionen: Normalisierung, Suche, Bewertung, Ziehen
js/game.js             App-Start, Zustandsmaschine, Singleplayer
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

**tier** (aus Sicht deutschsprachiger Spieler, geschätzt pro 100 Mitspieler):
tier1 > 15 · tier2 5–15 · tier3 1–5 · tier4 0,2–1 · tier5 < 0,2 (aber real und bekannt).

## Fehlende Antworten ergänzen

Im Spiel werden getippte Texte ohne Treffer und jedes „Nichts passt" lokal gespeichert. Export unter **Einstellungen → Fehlende Antworten → Als JSON exportieren**.
