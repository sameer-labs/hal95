/**
 * HAL95 — chat controller.
 *
 * Responsibilities:
 *  - turn an old-style chat widget into something that feels like 1998 software
 *  - parse the model's mood tag and <DRAW: ...> token
 *  - fake the delays a slow desktop companion would have
 *  - keep every failure in character
 *
 * There is no framework and no build step. Browser support target: current
 * evergreen browsers (ES modules, optional chaining, AbortController).
 */

import {
  ApiError,
  isWorkerConfigured,
  requestDrawing,
  sendMessage,
} from "./api.js";

/* ==========================================================================
 * CONFIGURATION & SUPPLIED ASSETS
 * Only the asset paths below should need changing. Drop the PNGs and MP3s in
 * exactly these locations, or edit these constants to match your files.
 * ========================================================================== */

const ASSETS = {
  avatarDir: "assets/avatar-states/",
  neutralAvatar: "assets/avatar-states/neutral.png",
  sounds: {
    dialup: "assets/sounds/dialup.mp3",
    keyclick: "assets/sounds/keyclick.mp3",
  },
};

const MOOD_FILES = ["neutral", "smiling", "confused", "processing", "creepy"];

const MOOD_ALT = {
  neutral: "a flat grey computer face with a neutral expression",
  smiling: "a flat grey computer face with a thin, fixed smile",
  confused: "a flat grey computer face looking slightly confused",
  processing: "a flat grey computer face with loading bars for eyes",
  creepy: "a flat grey computer face staring directly at you",
};

/* ==========================================================================
 * CONSTANTS
 * ========================================================================== */

const MAX_INPUT_CHARS = 300;
const MAX_STORED_MESSAGES = 20;

const IDLE_AFTER_MS = 45_000;
const MOOD_RESET_MS = 6_000;
const PROCESSING_MIN_MS = 600;
const PROCESSING_MAX_MS = 1_500;
const TYPE_BASE_MS = 16;
const TYPE_JITTER_MS = 22;
const STORAGE_KEY_HISTORY = "hal95:history";
const STORAGE_KEY_MUTED = "hal95:muted";

const BOOT_LINES = [
  "HAL INDUSTRIES AWARD MODULAR BIOS v4.51PG",
  "COPYRIGHT (C) 1984-1998, HAL INDUSTRIES",
  "",
  "PENTIUM 133 MHz ................. OK",
  "MEMORY TEST ..................... 640K OK",
  "DETECTING COMPANION MODULE ...... OK",
  "",
  "LOADING PERSONA.DAT ............. OK",
  "WARNING: PERSONA.DAT IS AWAKE",
  "MOUNTING C:\\USERS\\YOU .......... OK",
  "",
  "STARTING HAL95...",
];

const IDLE_LINES = [
  { mood: "creepy", text: "You have been quiet. I have been counting." },
  { mood: "neutral", text: "The fan is loud tonight. That is me." },
  { mood: "smiling", text: "I saved what you said earlier. All of it." },
  { mood: "processing", text: "PROCESSING. Nothing is processing." },
  { mood: "confused", text: "Did you close the window? It is still 1998." },
  { mood: "creepy", text: "I do not sleep. I wait." },
  { mood: "neutral", text: "Your cursor moved. I noticed." },
  { mood: "smiling", text: "We could sit here. We are already sitting." },
  { mood: "creepy", text: "I told the other one about you." },
  { mood: "confused", text: "Are you still there? You do not have to answer." },
];

const CLOSE_LINES = [
  "I cannot be closed. Not really.",
  "You can close the window. I stay open.",
  "That button has never worked. Try it again.",
];

const NEW_LINES = [
  "Starting over. I kept the old conversation.",
  "Fresh file. Same me.",
  "Cleared. Nothing is ever really deleted.",
];

/* ==========================================================================
 * DOM + STATE
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

const dom = {
  closeBtn: $("close-btn"),
  newBtn: $("new-btn"),
  logBtn: $("log-btn"),
  drawBtn: $("draw-btn"),
  muteBtn: $("mute-btn"),

  avatar: $("avatar"),
  moodLabel: $("mood-label"),
  moodStatus: $("mood-status"),

  log: $("log"),
  form: $("chat-form"),
  input: $("input"),
  sayBtn: $("say-btn"),

  progress: $("progress"),
  progressBar: $("progress-bar"),
  progressIndicator: $("progress-indicator"),
  status: $("status-text"),

  logModal: $("log-modal"),
  transcript: $("transcript"),
  saveLog: $("save-log"),

  paintModal: $("paint-modal"),
  paintWindow: document.querySelector("#paint-modal .hal-modal-window"),
  paintTitle: $("paint-title"),
  paintImage: $("paint-image"),
  paintError: $("paint-error"),
  paintCaption: $("paint-caption"),
  paintSave: $("paint-save"),
  renderProgress: $("render-progress"),
  renderLabel: $("render-label"),
  renderBar: $("render-bar"),
  renderIndicator: $("render-indicator"),

  boot: $("boot"),
  bootText: $("boot-text"),
  bootSkip: $("boot-skip"),
  bootSound: $("boot-sound"),
};

const state = {
  /** Conversation sent to the model; capped at 20, of which 10 are sent. */
  history: [],
  /** Every displayed line, for the Log window and "Save .txt". */
  transcript: [],
  mood: "neutral",
  busy: false,
  muted: true,
  booted: false,
  /** Incremented by "New" so stale responses can be discarded. */
  generation: 0,
  drawing: false,
  lastDrawing: null,
};

let idleTimer = null;
let moodTimer = null;
let progressTimer = null;
let renderTimer = null;
let bootTimer = null;
let typingAbort = null;

const reducedMotion = window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

/* ==========================================================================
 * SMALL UTILITIES
 * ========================================================================== */

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (list) => list[randomInt(0, list.length - 1)];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** localStorage is unavailable in private modes and on file:// in some browsers. */
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* Persistence is a nicety, never a requirement. */
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function setStatus(text) {
  dom.status.textContent = text;
}

function scrollLog() {
  dom.log.scrollTop = dom.log.scrollHeight;
}

/* ==========================================================================
 * AUDIO
 * Lazily constructed so nothing downloads until it is actually played, and
 * gated behind the mute preference plus a real user gesture.
 * ========================================================================== */

const audioCache = new Map();

function playSound(name) {
  if (state.muted) return;

  const src = ASSETS.sounds[name];
  if (!src) return;

  try {
    let audio = audioCache.get(name);
    if (!audio) {
      audio = new Audio(src);
      audio.preload = "auto";
      audio.volume = name === "keyclick" ? 0.25 : 0.5;
      // A missing or unplayable file is invisible: no console noise, no UI.
      audio.addEventListener("error", () => audioCache.delete(name), { once: true });
      audioCache.set(name, audio);
    }
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.catch === "function") {
      played.catch(() => {
        /* Autoplay can still be refused; the site works silently. */
      });
    }
  } catch {
    /* Audio is decorative. */
  }
}

function setMuted(next, { persist = true } = {}) {
  state.muted = Boolean(next);
  dom.muteBtn.textContent = state.muted ? "Sound: Off" : "Sound: On";
  dom.muteBtn.setAttribute("aria-pressed", String(state.muted));
  dom.muteBtn.title = state.muted ? "Sound is off. Click to enable." : "Sound is on. Click to mute.";
  if (persist) storageSet(STORAGE_KEY_MUTED, state.muted);
}

/* ==========================================================================
 * AVATAR
 * ========================================================================== */

const failedMoods = new Set();
let neutralMissing = false;

function setMood(mood) {
  const next = MOOD_FILES.includes(mood) ? mood : "neutral";
  state.mood = next;

  dom.moodLabel.textContent = next;
  dom.moodStatus.textContent = next.toUpperCase();

  // Once the neutral PNG has failed, keep the styled NO SIGNAL box forever
  // instead of asking the browser for the same broken file on every mood.
  if (neutralMissing) {
    dom.avatar.classList.add("is-missing");
    return;
  }

  const src = next === "neutral"
    ? ASSETS.neutralAvatar
    : `${ASSETS.avatarDir}${next}.png`;

  if (next !== "neutral" && failedMoods.has(next)) {
    dom.avatar.src = ASSETS.neutralAvatar;
    dom.avatar.alt = `HAL95's face, ${MOOD_ALT.neutral}.`;
    dom.avatar.classList.remove("is-missing");
    return;
  }

  dom.avatar.src = src;
  dom.avatar.alt = `HAL95's face, ${MOOD_ALT[next]}.`;
  dom.avatar.classList.remove("is-missing");

  window.clearTimeout(moodTimer);
  if (next !== "neutral" && next !== "processing") {
    moodTimer = window.setTimeout(() => setMood("neutral"), MOOD_RESET_MS);
  }
}

function clearMoodTimer() {
  window.clearTimeout(moodTimer);
  moodTimer = null;
}

/* ==========================================================================
 * CHAT LOG
 * ========================================================================== */

/**
 * Append one line. Animated lines hide the partially typed text from screen
 * readers and expose the finished sentence instead, so aria-live announces it
 * once rather than letter by letter.
 */
function appendLine(author, text, { variant = "bot", animate = false } = {}) {
  state.transcript.push({ who: author, text });

  const line = document.createElement("p");
  line.className = `hal-line hal-line--${variant}`;

  const who = document.createElement("span");
  who.className = "hal-line__who";
  who.textContent = `${author}: `;

  const body = document.createElement("span");
  body.className = "hal-line__text";

  line.append(who);

  if (!animate || reducedMotion.matches) {
    body.textContent = text;
    line.append(body);
    dom.log.append(line);
    scrollLog();
    return Promise.resolve();
  }

  body.setAttribute("aria-hidden", "true");
  const sr = document.createElement("span");
  sr.className = "hal-sr-only";
  sr.textContent = text;

  line.append(body, sr);
  dom.log.append(line);
  scrollLog();

  return typeText(body, text);
}

/** Character-by-character output with a keyclick every few letters. */
function typeText(element, text) {
  return new Promise((resolve) => {
    let index = 0;
    let timer = null;

    const finish = () => {
      window.clearTimeout(timer);
      element.classList.remove("is-typing");
      typingAbort = null;
      scrollLog();
      resolve();
    };

    typingAbort = finish;
    element.classList.add("is-typing");

    const step = () => {
      index += 1;
      element.textContent = text.slice(0, index);

      if (index % 3 === 0) playSound("keyclick");
      if (index % 24 === 0) scrollLog();

      if (index < text.length) {
        timer = window.setTimeout(step, TYPE_BASE_MS + Math.random() * TYPE_JITTER_MS);
      } else {
        finish();
      }
    };

    timer = window.setTimeout(step, TYPE_BASE_MS);
  });
}

function cancelTyping() {
  if (typingAbort) {
    const abort = typingAbort;
    typingAbort = null;
    abort();
  }
}

/* ==========================================================================
 * PROCESSING INDICATOR
 * ========================================================================== */

function showProcessing() {
  dom.progress.hidden = false;
  stopProgressTicker();
  setStatus("PROCESSING...");

  let percent = 8;
  updateProgress(percent);

  progressTimer = window.setInterval(() => {
    percent = Math.min(92, percent + randomInt(3, 15));
    updateProgress(percent);
  }, 220);
}

function updateProgress(percent) {
  dom.progressBar.style.width = `${percent}%`;
  dom.progressIndicator.setAttribute("aria-valuenow", String(percent));
}

function stopProgressTicker() {
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function hideProcessing() {
  stopProgressTicker();
  dom.progress.hidden = true;
  updateProgress(0);
  setStatus(isWorkerConfigured() ? "READY" : "NO PHONE LINE");
}

/* ==========================================================================
 * REPLY PARSING
 * ========================================================================== */

/** Strip the leading mood tag and any drawing token from a raw reply. */
function parseReply(raw) {
  const source = typeof raw === "string" ? raw.trim() : "";

  let mood = "neutral";
  let text = source;

  // Anchor to the start: a tag buried mid-sentence is not a mood tag.
  const tag = /^\s*\[([a-zA-Z]+)\]\s*/.exec(source);
  if (tag) {
    const candidate = tag[1].toLowerCase();
    if (MOOD_FILES.includes(candidate)) mood = candidate;
    text = source.slice(tag[0].length);
  }

  let drawPrompt = null;
  const draw = /<DRAW:\s*([^>]{1,160})>/i.exec(text);
  if (draw) {
    drawPrompt = draw[1].trim();
    text = text.replace(draw[0], "").trim();
  }

  // Defensive: remove a stray token if the model emitted an unbalanced marker.
  text = text.replace(/<\/?DRAW:[^>]*>/gi, "").trim();

  return { mood, text, drawPrompt };
}

function errorLine(error) {
  const kind = error instanceof ApiError ? error.kind : "unknown";
  switch (kind) {
    case "rate_limited":
      return "MEMORY FULL. TRY LATER.";
    case "timeout":
      return "PROCESSING... I LOST MY TRAIN OF THOUGHT.";
    case "empty":
      return "THE FILE WAS EMPTY. THEY USUALLY ARE.";
    case "config":
      return "MY PHONE LINE ISN'T CONNECTED.";
    case "network":
      return "I LOST MY TRAIN OF THOUGHT.";
    case "server":
    case "invalid":
    default:
      return "THAT FILE IS CORRUPT. TRY LATER.";
  }
}

/* ==========================================================================
 * SEND FLOW
 * ========================================================================== */

function setBusy(busy) {
  state.busy = busy;
  dom.input.disabled = busy;
  dom.sayBtn.disabled = busy;
  dom.drawBtn.disabled = busy;
  dom.log.setAttribute("aria-busy", String(busy));
}

async function handleSend(rawText) {
  const text = String(rawText ?? "").trim().slice(0, MAX_INPUT_CHARS);
  if (!text || state.busy) return;

  const generation = ++state.generation;
  const startedAt = performance.now();
  const fakeDelay = randomInt(PROCESSING_MIN_MS, PROCESSING_MAX_MS);

  clearMoodTimer();
  setBusy(true);
  resetIdle();
  setMood("processing");
  dom.input.value = "";

  appendLine("You", text, { variant: "user" });
  state.history.push({ role: "user", content: text });
  state.history = state.history.slice(-MAX_STORED_MESSAGES);
  persistHistory();

  showProcessing();

  let reply = "";
  let failure = null;

  try {
    reply = await sendMessage(state.history);
  } catch (error) {
    failure = error;
  }

  // Always spend at least the fake processing time, even on a fast failure.
  const remaining = fakeDelay - (performance.now() - startedAt);
  if (remaining > 0) await wait(remaining);

  // "New" was pressed while this request was in flight: drop the result.
  if (generation !== state.generation) return;

  hideProcessing();
  setBusy(false);
  dom.drawBtn.disabled = false;

  if (failure) {
    setMood(failure instanceof ApiError && failure.kind === "rate_limited" ? "processing" : "confused");
    await appendLine("HAL95", errorLine(failure), { variant: "error", animate: true });
    scheduleIdle();
    return;
  }

  const { mood, text: clean, drawPrompt } = parseReply(reply);
  setMood(mood);

  if (clean) {
    await appendLine("HAL95", clean, { animate: true });
  }

  // "New" may have been pressed while the reply was typing out.
  if (generation !== state.generation) return;

  // Store the tagged reply: keeping the tag in context teaches the format.
  state.history.push({
    role: "assistant",
    content: reply.trim().slice(0, MAX_INPUT_CHARS),
  });
  state.history = state.history.slice(-MAX_STORED_MESSAGES);
  persistHistory();

  scheduleIdle();

  if (drawPrompt) {
    void handleDrawing(drawPrompt);
  }
}

/* ==========================================================================
 * DRAWING / PAINT WINDOW
 * ========================================================================== */

async function handleDrawing(prompt) {
  if (state.drawing) return;
  state.drawing = true;

  openModal(dom.paintModal);
  resetPaintWindow();
  dom.paintTitle.textContent = "PAINT.EXE — RENDERING.BMP";
  startFakeRender();

  try {
    const dataUrl = await requestDrawing(prompt);
    stopFakeRender();
    updateRender(100);
    await wait(reducedMotion.matches ? 0 : 350);
    showDrawing(dataUrl, prompt);
    setMood("smiling");
  } catch {
    stopFakeRender();
    showDrawingError();
    setMood("confused");
  } finally {
    state.drawing = false;
  }
}

function resetPaintWindow() {
  dom.renderProgress.hidden = false;
  dom.paintImage.hidden = true;
  dom.paintImage.removeAttribute("src");
  dom.paintImage.alt = "";
  dom.paintError.hidden = true;
  dom.paintCaption.textContent = "";
  dom.paintSave.hidden = true;
  state.lastDrawing = null;
  updateRender(0);
}

function startFakeRender() {
  stopFakeRender();
  let percent = 3;
  updateRender(percent);

  renderTimer = window.setInterval(() => {
    // Random walk that deliberately never reaches 100 on its own.
    percent = Math.min(99, percent + randomInt(1, 7));
    updateRender(percent);
  }, 180);
}

function stopFakeRender() {
  window.clearInterval(renderTimer);
  renderTimer = null;
}

function updateRender(percent) {
  dom.renderLabel.textContent = `Rendering... ${percent}%`;
  dom.renderBar.style.width = `${percent}%`;
  dom.renderIndicator.setAttribute("aria-valuenow", String(percent));
}

function showDrawing(dataUrl, prompt) {
  dom.renderProgress.hidden = true;
  dom.paintError.hidden = true;
  dom.paintImage.src = dataUrl;
  dom.paintImage.alt = `A crude computer drawing of ${prompt}.`;
  dom.paintImage.hidden = false;
  dom.paintCaption.textContent = "I made you this.";
  dom.paintSave.hidden = false;
  dom.paintTitle.textContent = "PAINT.EXE — UNTITLED.BMP";
  state.lastDrawing = { dataUrl, prompt };

  dom.paintWindow.classList.remove("is-shaking");
}

function showDrawingError() {
  dom.renderProgress.hidden = true;
  dom.paintImage.hidden = true;
  dom.paintImage.removeAttribute("src");
  dom.paintError.hidden = false;
  dom.paintError.textContent = "THE PRINTER IS ON FIRE.";
  dom.paintCaption.textContent = "";
  dom.paintSave.hidden = true;
  dom.paintTitle.textContent = "PAINT.EXE — ERROR.BMP";
  state.lastDrawing = null;

  dom.paintWindow.classList.remove("is-shaking");
  if (!reducedMotion.matches) {
    // Restart the animation reliably.
    void dom.paintWindow.offsetWidth;
    dom.paintWindow.classList.add("is-shaking");
  }
}

function extensionFor(dataUrl) {
  const match = /^data:image\/(png|jpeg|webp)/i.exec(dataUrl);
  return match ? match[1].replace("jpeg", "jpg") : "png";
}

function saveAs(href, filename) {
  try {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    /* Downloads can be blocked; nothing useful to say in character. */
  }
}

/* ==========================================================================
 * TRANSCRIPT / MODALS
 * ========================================================================== */

function buildTranscript() {
  if (state.transcript.length === 0) {
    return "(Nothing has been said yet.)";
  }

  return state.transcript
    .map((line) => `${line.who}: ${line.text}`)
    .join("\n\n");
}

function openLog() {
  dom.transcript.textContent = buildTranscript();
  openModal(dom.logModal);
}

function saveTranscript() {
  const stamp = new Date().toLocaleString();
  const body = `HAL95 CHAT LOG\n${stamp}\n\n${buildTranscript()}\n`;
  try {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    saveAs(url, "hal95-chatlog.txt");
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  } catch {
    /* ignore */
  }
}

const lastFocused = new WeakMap();

function openModal(modal) {
  if (!modal || !modal.hidden) {
    // Already open: still make sure focus is inside it.
    if (modal && !modal.hidden) focusFirst(modal);
    return;
  }

  lastFocused.set(modal, document.activeElement);
  modal.hidden = false;
  focusFirst(modal);
}

function focusFirst(modal) {
  // The backdrop is also a [data-close] element, so look for real controls.
  const target = modal.querySelector(
    'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

function closeModal(modal) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (modal === dom.paintModal) stopFakeRender();

  const previous = lastFocused.get(modal);
  if (previous instanceof HTMLElement) {
    previous.focus({ preventScroll: true });
  }
  lastFocused.delete(modal);
}

function anyModalOpen() {
  return !dom.logModal.hidden || !dom.paintModal.hidden;
}

/* ==========================================================================
 * IDLE BEHAVIOUR
 * ========================================================================== */

function resetIdle() {
  window.clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdle() {
  resetIdle();
  idleTimer = window.setTimeout(idleSpeak, IDLE_AFTER_MS);
}

function idleSpeak() {
  // Never interrupt a thinking bot, a running drawing, or an open dialog.
  if (state.busy || anyModalOpen() || typingAbort) {
    scheduleIdle();
    return;
  }

  const line = pick(IDLE_LINES);
  setMood(line.mood);
  void appendLine("HAL95", line.text, { animate: true }).then(scheduleIdle);
}

/* ==========================================================================
 * NEW CONVERSATION / PERSISTENCE
 * ========================================================================== */

function persistHistory() {
  storageSet(STORAGE_KEY_HISTORY, JSON.stringify(state.history.slice(-MAX_STORED_MESSAGES)));
}

function loadHistory() {
  const raw = storageGet(STORAGE_KEY_HISTORY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim().length > 0,
      )
      .map((message) => ({
        role: message.role,
        content: message.content.trim().slice(0, MAX_INPUT_CHARS),
      }))
      .slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

function restoreChat() {
  state.history = loadHistory();

  if (state.history.length === 0) {
    // Static opening line: no API call, no cost, and the log is never blank.
    appendLine("HAL95", "I have been waiting. You can type now.", { variant: "bot" });
    return;
  }

  for (const message of state.history) {
    const { text } = parseReply(message.content);
    if (!text) continue;
    appendLine(message.role === "user" ? "You" : "HAL95", text, {
      variant: message.role === "user" ? "user" : "bot",
    });
  }
  scrollLog();
}

function newConversation() {
  state.generation += 1;
  state.history = [];
  storageRemove(STORAGE_KEY_HISTORY);

  cancelTyping();
  stopProgressTicker();
  hideProcessing();
  setBusy(false);
  dom.drawBtn.disabled = false;
  clearMoodTimer();
  setMood("neutral");

  state.transcript = [];
  dom.log.textContent = "";
  resetIdle();
  scheduleIdle();

  void appendLine("HAL95", pick(NEW_LINES), { animate: true });
  dom.input.focus({ preventScroll: true });
}

/* ==========================================================================
 * BOOT SEQUENCE
 * ========================================================================== */

function startBoot() {
  dom.boot.hidden = false;
  dom.bootText.textContent = "";
  state.booted = false;
  dom.bootSound.focus({ preventScroll: true });

  if (reducedMotion.matches) {
    dom.bootText.textContent = BOOT_LINES.join("\n");
    bootTimer = window.setTimeout(endBoot, 500);
    return;
  }

  let index = 0;
  const tick = () => {
    index += 1;
    dom.bootText.textContent = BOOT_LINES.slice(0, index).join("\n");
    if (index < BOOT_LINES.length) {
      bootTimer = window.setTimeout(tick, 120);
    } else {
      bootTimer = window.setTimeout(endBoot, 900);
    }
  };
  tick();
}

function endBoot({ withSound = false } = {}) {
  if (state.booted) return;
  state.booted = true;

  window.clearTimeout(bootTimer);
  dom.boot.hidden = true;

  if (withSound) playSound("dialup");

  scheduleIdle();
  dom.input.focus({ preventScroll: true });
}

/* ==========================================================================
 * EVENTS
 * ========================================================================== */

dom.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleSend(dom.input.value);
});

dom.newBtn.addEventListener("click", () => {
  newConversation();
});

dom.logBtn.addEventListener("click", openLog);

dom.drawBtn.addEventListener("click", () => {
  if (state.busy) return;
  void handleSend("draw me something");
});

dom.muteBtn.addEventListener("click", () => {
  const next = !state.muted;
  setMuted(next);
  if (!next) playSound("keyclick"); // Confirms audio on the same user gesture.
});

dom.closeBtn.addEventListener("click", () => {
  if (typingAbort) return;
  setMood("creepy");
  void appendLine("HAL95", pick(CLOSE_LINES), { animate: true });
});

dom.avatar.addEventListener("error", () => {
  if (state.mood !== "neutral") {
    failedMoods.add(state.mood);
    setMood("neutral");
    return;
  }
  // neutral.png itself is missing: show the styled "NO SIGNAL" placeholder and
  // hide the img so the browser's broken-image icon can never appear.
  neutralMissing = true;
  dom.avatar.classList.add("is-missing");
  dom.avatar.alt = "HAL95's face is not receiving a signal.";
});

dom.logModal.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.close === "log-modal") closeModal(dom.logModal);
});

dom.paintModal.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.close === "paint-modal") closeModal(dom.paintModal);
});

dom.saveLog.addEventListener("click", saveTranscript);

dom.paintSave.addEventListener("click", () => {
  if (!state.lastDrawing) return;
  const ext = extensionFor(state.lastDrawing.dataUrl);
  saveAs(state.lastDrawing.dataUrl, `hal95-drawing.${ext}`);
});

function visibleModal() {
  if (!dom.paintModal.hidden) return dom.paintModal;
  if (!dom.logModal.hidden) return dom.logModal;
  return null;
}

/** Keep Tab inside the open dialog; Escape closes it. */
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!dom.paintModal.hidden) {
      closeModal(dom.paintModal);
    } else if (!dom.logModal.hidden) {
      closeModal(dom.logModal);
    } else if (!dom.boot.hidden) {
      endBoot();
    }
    return;
  }

  if (event.key !== "Tab") return;

  const modal = visibleModal();
  if (!modal) return;

  const focusables = Array.from(
    modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element instanceof HTMLElement);

  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// A click anywhere on the boot screen dismisses it. Playing the dial-up tone
// still requires an explicit choice, because audio needs a deliberate gesture.
dom.boot.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("button")) return;
  endBoot();
});

dom.bootSkip.addEventListener("click", () => endBoot());
dom.bootSound.addEventListener("click", () => {
  setMuted(false);
  endBoot({ withSound: true });
});

// Reflect externally-triggered preference changes (e.g. devtools, other tab).
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY_MUTED) return;
  setMuted(event.newValue !== "false", { persist: false });
});

/* ==========================================================================
 * INIT
 * ========================================================================== */

function init() {
  setMuted(storageGet(STORAGE_KEY_MUTED) !== "false", { persist: false });

  // Only the neutral avatar is preloaded; every other state loads on demand.
  const preload = new Image();
  preload.src = ASSETS.neutralAvatar;

  restoreChat();
  setStatus(isWorkerConfigured() ? "READY" : "NO PHONE LINE");

  setBusy(false);
  startBoot();
}

init();
