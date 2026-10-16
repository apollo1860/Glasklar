// Glasklar – Firebase-Konfiguration.
// Firebase-Konsole → Projekteinstellungen → Allgemein → "Meine Apps" → Web-App → Konfiguration hier eintragen.
// Außerdem nötig: Realtime Database anlegen, Authentication → "Anonym" aktivieren,
// Regeln aus database.rules.json einspielen.
//
// Solange hier Platzhalter stehen, läuft der Multiplayer im lokalen Testmodus
// (mehrere Tabs im selben Browser spielen gegeneinander, kein Server nötig).
export const firebaseConfig = {
  apiKey: 'DEIN_API_KEY',
  authDomain: 'DEIN_PROJEKT.firebaseapp.com',
  databaseURL: 'https://DEIN_PROJEKT-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'DEIN_PROJEKT',
  storageBucket: 'DEIN_PROJEKT.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000',
};

export const isFirebaseConfigured = () =>
  !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('DEIN') && !firebaseConfig.databaseURL.includes('DEIN_PROJEKT');
