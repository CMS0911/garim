// Copy to firebase-config.js and fill from the Firebase console (Project settings > Your apps).
// The web config is not a secret; App Check protects the AI Logic API. Never commit debug tokens.
export const firebaseConfig = {
  apiKey: "…",
  authDomain: "garim-hybrid.firebaseapp.com",
  projectId: "garim-hybrid",
  storageBucket: "garim-hybrid.firebasestorage.app",
  messagingSenderId: "…",
  appId: "…",
};

// App Check > Apps > reCAPTCHA Enterprise site key (created when you register the provider)
export const recaptchaSiteKey = "…";
