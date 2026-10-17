// Glasklar – zentrale Spielwerte. Hier anpassen, alles andere liest von hier.
export const CONFIG = {
  // Füllung pro Frage nach tier der gewählten Antwort
  // Dezimalwerte erlaubt (z. B. 0,3) – gerundet wird erst bei der Abrechnung nach 3 Fragen
  fillByTier: { 1: 3, 2: 2, 3: 1, 4: 0.3, 5: 0 },
  // "Nichts passt" und keine Antwort bis Timer-Ende
  fillNothing: 3,
  fillTimeout: 3,

  // Multiplayer: +1 pro weiterem Spieler mit gleicher Antwort, max. +2
  sameAnswerBonusPerPlayer: 1,
  sameAnswerBonusMax: 2,

  // Schlücke pro Runde sind hierauf gekappt (= Füllstufen des Glases)
  maxSipsPerRound: 10,
  questionsPerRound: 3,

  // Kein Zeitlimit – nur im Multiplayer: Sobald alle bis auf einen geantwortet haben,
  // bleiben dem letzten Spieler noch so viele Sekunden.
  lastAnswerSeconds: 20,

  // Suche: Vorschläge erst bei ganzem Wort (exakt oder mit Tippfehler), nie per Anfangsbuchstabe
  search: {
    maxResults: 6,
    fuzzyMinLength: 5, // Tippfehler-Toleranz erst ab so vielen Buchstaben
    fuzzyMaxDistance: 1, // erlaubte Tippfehler (vertauschte Buchstaben zählen als 1)
    // Offene Fragen (ohne @typ, z. B. „Etwas, das man im Bad findet") bekommen mehr Spielraum:
    tolerant: {
      fuzzyMinLength: 4, // 1 Tippfehler schon ab 4 Buchstaben
      fuzzy2MinLength: 8, // 2 Tippfehler ab 8 Buchstaben
      partMinLength: 4, // Wortteil-Treffer: „Badezimmerspiegel" → Spiegel, „elektrische Zahnbürste" → Zahnbürste
      partMinShare: 0.6, // „Bürste" → Zahnbürste nur, wenn das Getippte ≥ 60 % der Antwort ausmacht
    },
  },

  // Multiplayer (Phase 2)
  minPlayers: 2,
  roomInactiveHours: 6,
};
