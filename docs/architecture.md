# Garim — architecture

## Layers

```
 citizen message (photo / text file / paste)
        │
        ▼
 ┌──────────────────────────────┐
 │ 1. Local redaction           │  deterministic rules, in the browser
 │    RRN · phone · email ·     │  labels: [RRN_1] [PHONE_1] [EMAIL_1]
 │    account · plate · address │          [ACCOUNT_1] [PLATE_1] [ADDR_1]
 │    + user-marked names       │  mapping stays in the tab (memory only)
 └──────────────────────────────┘
        │ masked text only
        ▼
 ┌──────────────────────────────┐
 │ 2. Triage — hybrid           │  Firebase AI Logic
 │    Auto: PREFER_ON_DEVICE    │  on-device Gemini Nano, cloud fallback
 │    Device-only: ONLY_ON_DEVICE│ structured output (one Schema, both paths)
 └──────────────────────────────┘
        │ masked text + requests
        ▼
 ┌──────────────────────────────┐
 │ 3. Reply draft — cloud       │  ONLY_IN_CLOUD, masked text only
 └──────────────────────────────┘
        │ placeholders
        ▼
 ┌──────────────────────────────┐
 │ 4. Local restore             │  [NAME_1] → the real value, in the tab
 └──────────────────────────────┘

 Inspector: the exact payload that left the device (or "nothing left"),
 the inference source reported by the SDK, and the latency.
```

## Privacy boundary

- Everything the user typed stays in the browser except the **masked** text, and the inspector shows that masked text verbatim.
- Firestore gets `masked`, `triage`, `source`, `createdAt` under `users/{uid}/triage` — no raw text, no mapping.
- `firestore.rules` allows read/write only for `request.auth.uid == uid`; everything else is denied.

## Inference modes

| Mode | Triage | Draft |
| --- | --- | --- |
| Auto (device first) | `PREFER_ON_DEVICE` | `ONLY_IN_CLOUD` |
| Device-only | `ONLY_ON_DEVICE` (Korean input refused with an explanation) | disabled |
| Cloud-preferred | `PREFER_IN_CLOUD` | `ONLY_IN_CLOUD` |
| Policy `policy_device_only = true` | `ONLY_ON_DEVICE` | disabled |

## Files

| File | Purpose |
| --- | --- |
| `app/index.html` | three-pane UI + inspector |
| `app/garim.js` | Firebase init, redaction rules, model routing, restore, policy, masked history |
| `app/styles.css` | layout |
| `app/firebase-config.example.js` | copy to `firebase-config.js` and fill in |
| `firestore.rules` | per-uid access to masked history |
| `firebase.json` | Hosting + Firestore rules deployment |
| `samples/` | synthetic English and Korean complaints |
