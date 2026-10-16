// Glasklar – Firebase-Konfiguration.
// Firebase-Konsole → Projekteinstellungen → Allgemein → "Meine Apps" → Web-App → Konfiguration hier eintragen.
// Außerdem nötig: Realtime Database anlegen, Authentication → "Anonym" aktivieren,
// Regeln aus database.rules.json einspielen.
//
// Solange hier Platzhalter stehen, läuft der Multiplayer im lokalen Testmodus
// (mehrere Tabs im selben Browser spielen gegeneinander, kein Server nötig).
export const firebaseConfig = {
  apiKey: 'AIzaSyByQU6vcXymNcQ03wgQqo4AAEtCp_fbypM',
  authDomain: 'glasklar-d31d7.firebaseapp.com',
  databaseURL: 'https://glasklar-d31d7-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'glasklar-d31d7',
  storageBucket: 'glasklar-d31d7.firebasestorage.app',
  messagingSenderId: '321407558383',
  appId: '1:321407558383:web:410e12610e863c00aaf11a',
};

export const isFirebaseConfigured = () =>
  !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('DEIN') && !firebaseConfig.databaseURL.includes('DEIN_PROJEKT');
