// Garim — hybrid intake desk.
// Every inference call goes through Firebase AI Logic (no direct model API keys anywhere).
// Layer 1: local redaction (rules, in the browser). Layer 2: triage, on-device first.
// Layer 3: reply draft from the cloud, masked text only. Layer 4: the inspector proves it.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, Schema }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js";
import { getFirestore, collection, addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getRemoteConfig, fetchAndActivate, getBoolean }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-remote-config.js";
import { firebaseConfig, recaptchaSiteKey } from "./firebase-config.js";

/* ------------------------------------------------------------------ init */
const app = initializeApp(firebaseConfig);

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  // Debug token for local development only. Never ship it, never commit it.
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });
const db = getFirestore(app);
const auth = getAuth(app);
const rc = getRemoteConfig(app);
rc.settings.minimumFetchIntervalMillis = 60_000;

const state = {
  manual: {},           // [NAME_1] -> value the user marked by hand. In memory only.
  mapping: {},          // all tags for the current text. In memory only.
  masked: "",
  triage: null,
  policy: { deviceOnly: false, cloudDraft: true },
};

/* --------------------------------------------------------------- masking */
const RULES = [
  { kind: "RRN", re: /(?<!\d)\d{6}\s?[-–]\s?\d{7}(?!\d)/g },
  { kind: "PHONE", re: /(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g },
  { kind: "EMAIL", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { kind: "ACCOUNT", re: /(?<!\d)\d{2,6}[-.\s]\d{2,6}[-.\s]\d{2,8}(?!\d)/g },
  { kind: "PLATE", re: /(?<!\d)\d{2,3}[가-힣]\s?\d{4}(?!\d)/g },
  {
    kind: "ADDR",
    re: /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n]{0,30}?(?:로|길)\s?\d{1,4}/g,
  },
  {
    kind: "ADDR",
    re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){0,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Row|Way|Court|Ct)\b(?:,?\s*(?:Apt|Suite|Unit|No\.|#)\s?[\w-]+)?/g,
  },
];

const isDateLike = (s) => /^(19|20)\d{2}[-.\s]\d{1,2}[-.\s]\d{1,2}$/.test(s);

// Rebuilt from scratch on every pass, so the same text always yields the same labels:
// one tag per distinct value, numbering continuing from the tags the user marked by hand.
function maskLocal(text, manual = {}) {
  const mapping = { ...manual };
  const counters = {};
  for (const key of Object.keys(manual)) {
    const m = key.match(/^\[(\w+)_(\d+)\]$/);
    if (m) counters[m[1]] = Math.max(counters[m[1]] ?? 0, Number(m[2]));
  }
  let masked = text;
  for (const { kind, re } of RULES) {
    const seen = new Map();
    for (const [tag, value] of Object.entries(manual)) {
      if (tag.startsWith(`[${kind}_`)) seen.set(value, tag);
    }
    masked = masked.replace(re, (hit) => {
      if (kind === "ACCOUNT" && isDateLike(hit)) return hit;
      if (seen.has(hit)) return seen.get(hit);
      counters[kind] = (counters[kind] ?? 0) + 1;
      let tag = `[${kind}_${counters[kind]}]`;
      while (mapping[tag] && mapping[tag] !== hit) {
        counters[kind] += 1;
        tag = `[${kind}_${counters[kind]}]`;
      }
      mapping[tag] = hit;
      seen.set(hit, tag);
      return tag;
    });
  }
  return { masked, mapping };
}

function nextTag(kind) {
  const n = Object.keys(state.manual).filter((k) => k.startsWith(`[${kind}_`)).length + 1;
  return `[${kind}_${n}]`;
}

function restore(text) {
  return text.replace(/\[(NAME|PHONE|ADDR|RRN|EMAIL|ACCOUNT|PLATE)_\d+\]/g,
    (tag) => state.mapping[tag] ?? tag);
}

const hasHangul = (s) => /[가-힣]/.test(s);

/* ---------------------------------------------------------------- models */
const triageSchema = Schema.object({
  properties: {
    language: Schema.string(),
    category: Schema.string(),
    summary: Schema.string(),
    requests: Schema.array({ items: Schema.string() }),
    deadline: Schema.string(),
    department: Schema.string(),
    priority: Schema.enumString({ enum: ["low", "normal", "urgent"] }),
  },
});

const cloudParams = {
  model: "gemini-3.5-flash-lite",
  generationConfig: { responseMimeType: "application/json", responseSchema: triageSchema },
};
const deviceParams = { promptOptions: { responseConstraint: triageSchema } };

function triageModel(mode) {
  const m = state.policy.deviceOnly || mode === "device"
    ? InferenceMode.ONLY_ON_DEVICE
    : mode === "cloud"
      ? InferenceMode.PREFER_IN_CLOUD
      : InferenceMode.PREFER_ON_DEVICE;
  return getGenerativeModel(ai, { mode: m, inCloudParams: cloudParams, onDeviceParams: deviceParams });
}

const draftModel = () => getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: { model: "gemini-3.5-flash-lite" },
});

/* -------------------------------------------------------------- UI wiring */
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setBadge(el, source, extra = "") {
  el.className = "badge";
  if (source === InferenceSource.ON_DEVICE) { el.textContent = "ON_DEVICE" + extra; el.classList.add("on"); }
  else if (source === InferenceSource.IN_CLOUD) { el.textContent = "IN_CLOUD" + extra; el.classList.add("cloud"); }
  else { el.textContent = "no request yet"; el.classList.add("muted"); }
}

function renderChips() {
  const box = $("chips");
  box.innerHTML = "";
  const entries = Object.entries(state.mapping).slice(0, 12);
  for (const [tag, value] of entries) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<b>${tag}</b> ${escapeHtml(value)}`;
    box.appendChild(chip);
  }
  const rest = Object.keys(state.mapping).length - entries.length;
  if (rest > 0) {
    const more = document.createElement("span");
    more.className = "chip muted";
    more.textContent = `+${rest} more`;
    box.appendChild(more);
  }
}

function renderTriage(data) {
  const list = (arr) => (arr && arr.length
    ? `<ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
    : "<p class='muted'>—</p>");
  $("triage").innerHTML = `
    <div class="card"><h3>Type</h3><div>${escapeHtml(data.category || "—")}</div></div>
    <div class="card"><h3>Summary</h3><div>${escapeHtml(data.summary || "—")}</div></div>
    <div class="card"><h3>Requests</h3>${list(data.requests)}</div>
    <div class="card"><h3>Deadline · department</h3>
      <div>${escapeHtml(data.deadline || "—")} · ${escapeHtml(data.department || "—")}</div>
      <div class="muted">priority: ${escapeHtml(data.priority || "—")}</div>
    </div>`;
}

function refreshMasked() {
  $("masked").textContent = state.masked;
  renderChips();
  $("langNote").textContent = hasHangul($("input").value)
    ? "The on-device model doesn't support Korean. Redaction still happens here; the understanding step needs the cloud, and only masked text is sent."
    : "";
}

function note(text) {
  $("inspectorState").textContent = text;
}

/* -------------------------------------------------------------- actions */
async function loadPolicy() {
  try {
    await fetchAndActivate(rc);
    state.policy = {
      deviceOnly: getBoolean(rc, "policy_device_only"),
      cloudDraft: getBoolean(rc, "policy_cloud_draft_enabled"),
    };
  } catch (e) {
    console.warn("Remote Config unavailable, using defaults", e);
  }
  $("policyBadge").textContent = state.policy.deviceOnly
    ? "policy: device-only"
    : state.policy.cloudDraft ? "policy: cloud draft allowed" : "policy: no cloud draft";
  $("draft").disabled = state.policy.deviceOnly || !state.policy.cloudDraft;
  $("draft").title = state.policy.deviceOnly ? "Cloud is disabled by your organization's policy" : "";
}

async function prepareModel() {
  const model = triageModel($("mode").value);
  $("prepare").textContent = "Preparing… 0%";
  try {
    await model.initializeDeviceModel((v) => {
      $("prepare").textContent = `Preparing… ${Math.round(v * 1000) / 10}%`;
    });
    $("prepare").textContent = "On-device model prepared";
  } catch (e) {
    $("prepare").textContent = "On-device model unavailable here";
    console.warn(e);
  }
}

async function analyze() {
  const raw = $("input").value.trim();
  if (!raw) return;
  ({ masked: state.masked, mapping: state.mapping } = maskLocal(raw, state.manual));
  refreshMasked();

  const onlyDevice = state.policy.deviceOnly || $("mode").value === "device";
  if (onlyDevice && hasHangul(raw)) {
    note("This message is in Korean, which the on-device model doesn't support, and this mode never calls the cloud. Nothing was sent.");
    return;
  }

  const model = triageModel($("mode").value);
  const prompt = [
    "You are an intake assistant at a public service counter.",
    "Read the citizen message and return JSON matching the schema.",
    "The text has been redacted: [NAME_1], [PHONE_1], [ADDR_1], [RRN_1] are placeholders.",
    "Never guess or invent the redacted values.",
    "Write summary, requests, deadline and department in the message's language.",
    "",
    state.masked,
  ].join("\n");

  $("analyze").disabled = true;
  note("Analyzing…");
  try {
    const started = performance.now();
    const result = await model.generateContent(prompt);
    const source = result.response.inferenceSource;
    state.triage = JSON.parse(result.response.text());
    renderTriage(state.triage);
    setBadge($("sourceBadge"), source, ` · ${Math.round(performance.now() - started)} ms`);
    if (source === InferenceSource.IN_CLOUD) {
      $("payload").textContent = prompt;
      note("This message could not be handled on-device, so the cloud ran it — and this is the exact text that was sent.");
    } else {
      $("payload").textContent = "";
      note("Nothing left this device.");
    }
    await saveEntry(state.triage, source);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/not available|api-not-enabled|not supported/i.test(msg)) {
      note(onlyDevice
        ? "The on-device model (Gemini Nano) is not available in this browser, and Device-only mode never calls the cloud. Nothing was sent. Use Chrome 139+ on supported desktop hardware, or switch to Auto."
        : `Request failed: ${msg}`);
    } else {
      note(`Request failed: ${msg}`);
    }
    console.warn(e);
  } finally {
    $("analyze").disabled = false;
  }
}

async function draftReply() {
  if (!state.masked) return;
  if (state.policy.deviceOnly || !state.policy.cloudDraft) {
    note("Cloud is disabled by your organization's policy. No request was sent.");
    return;
  }
  const prompt = `Write a courteous reply to this citizen message.
Keep every placeholder exactly as written (e.g. [NAME_1]).
Use only placeholders that already appear in the text; never invent a new one.
Do not invent a person's name or signature — sign as the office.
Requests to address: ${(state.triage?.requests || []).join("; ")}

${state.masked}`;

  // The inspector shows the exact text that leaves the device.
  $("payload").textContent = prompt;
  note("This is the exact text sent to the cloud.");

  try {
    const res = await draftModel().generateContent(prompt);
    $("draftOut").value = res.response.text();
    setBadge($("sourceBadge"), res.response.inferenceSource);
  } catch (e) {
    note(`Draft failed: ${e.message}`);
    console.warn(e);
  }
}

async function saveEntry(triage, source) {
  try {
    const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
    await addDoc(collection(db, "users", user.uid, "triage"), {
      masked: state.masked,          // masked only — never the raw text or the mapping
      triage,
      source,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn("history not saved", e);
  }
}

/* --------------------------------------------------------------- handlers */
$("analyze").addEventListener("click", analyze);
$("prepare").addEventListener("click", prepareModel);
$("draft").addEventListener("click", draftReply);
$("restore").addEventListener("click", () => { $("draftOut").value = restore($("draftOut").value); });

$("input").addEventListener("input", () => {
  ({ masked: state.masked, mapping: state.mapping } = maskLocal($("input").value, state.manual));
  refreshMasked();
});

$("file").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  if (file.type.startsWith("image/")) {
    // Image input on the on-device path is JPEG/PNG only; wire the Part here when built.
    $("langNote").textContent = "Image input: pass the file as inlineData (image/jpeg or image/png).";
    return;
  }
  $("input").value = await file.text();
  $("input").dispatchEvent(new Event("input"));
});

// Manual labelling: names are not auto-detected. Select text, then mark it.
$("markSelection").addEventListener("click", () => {
  const ta = $("input");
  const { selectionStart: s, selectionEnd: e } = ta;
  if (s === e) return;
  const selected = ta.value.slice(s, e);
  const tag = nextTag("NAME");
  state.manual[tag] = selected;
  ta.value = ta.value.slice(0, s) + tag + ta.value.slice(e);
  ({ masked: state.masked, mapping: state.mapping } = maskLocal(ta.value, state.manual));
  refreshMasked();
});

/* ------------------------------------------------------------------ boot */
loadPolicy();
refreshMasked();
setBadge($("sourceBadge"), null);
