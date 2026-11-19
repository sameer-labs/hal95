/**
 * HAL95 — client API layer.
 *
 * The browser only ever talks to our own Cloudflare Worker. It never sees an
 * API key, and it cannot choose the system prompt: the Worker injects it.
 *
 * Failure is expected (free tiers sleep, phones lose signal, GitHub Pages is
 * static), so every path resolves to an ApiError with a stable `kind` that the
 * UI turns into an in-character line.
 */

/* -------------------------------------------------------------------------
 * CONFIGURE ME: the deployed Worker URL, no trailing slash.
 * Example: "https://hal95-worker.your-name.workers.dev"
 * ---------------------------------------------------------------------- */
export const WORKER_URL = "https://hal95-worker.sameer0ayat.workers.dev";

const TEXT_TIMEOUT_MS = 20_000;
const DRAW_TIMEOUT_MS = 75_000; // two 35s Worker attempts fit inside this
const RETRY_DELAY_MS = 600;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 300;

/** Error with a stable machine-readable kind and whether a retry may help. */
export class ApiError extends Error {
  /**
   * @param {"config"|"network"|"timeout"|"rate_limited"|"server"|"empty"|"invalid"} kind
   * @param {string} message Developer-facing description (never shown to users).
   * @param {boolean} [retryable]
   */
  constructor(kind, message, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** True when WORKER_URL is still the placeholder or obviously unusable. */
export function isWorkerConfigured() {
  return /^https:\/\/[^\s]+$/i.test(WORKER_URL) && !WORKER_URL.includes("YOUR-SUBDOMAIN");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One POST attempt, with an abort-based timeout.
 * @param {string} path
 * @param {unknown} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function postOnce(path, payload, timeoutMs) {
  if (!isWorkerConfigured()) {
    throw new ApiError("config", "WORKER_URL has not been configured.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    // AbortError means our timer fired; everything else is a transport problem.
    if (controller.signal.aborted) {
      throw new ApiError("timeout", `Request to ${path} timed out.`, true);
    }
    throw new ApiError("network", `Request to ${path} failed.`, true);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new ApiError("rate_limited", "The Worker rate limit was hit.");
  }
  if (!response.ok) {
    throw new ApiError(
      "server",
      `Worker responded ${response.status}.`,
      response.status >= 500,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError("invalid", "Worker response was not valid JSON.");
  }
}

/**
 * POST with exactly one retry for transient failures.
 * @param {string} path
 * @param {unknown} payload
 * @param {number} timeoutMs
 * @param {{ retryTimeouts?: boolean }} [options]
 */
async function post(path, payload, timeoutMs, { retryTimeouts = true } = {}) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await postOnce(path, payload, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ApiError &&
        error.retryable &&
        attempt === 0 &&
        (retryTimeouts || error.kind !== "timeout");

      if (!retryable) break;
      await delay(RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof ApiError
    ? lastError
    : new ApiError("network", "Unknown request failure.", true);
}

/**
 * Normalise history before it leaves the browser. The Worker validates again;
 * this is convenience and payload hygiene, not a security boundary.
 * @param {Array<{role: string, content: string}>} history
 */
function sanitiseHistory(history) {
  const safe = Array.isArray(history) ? history : [];
  return safe
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, MAX_MESSAGE_CHARS),
    }))
    .slice(-MAX_MESSAGES);
}

/**
 * Ask HAL95 for one reply.
 * @param {Array<{role: string, content: string}>} history Full conversation; trimmed here.
 * @returns {Promise<string>} Raw reply, including the mood tag.
 */
export async function sendMessage(history) {
  const messages = sanitiseHistory(history);
  if (messages.length === 0) {
    throw new ApiError("invalid", "Nothing to send.");
  }

  const data = await post("/", { messages }, TEXT_TIMEOUT_MS);
  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";

  if (!reply) {
    throw new ApiError("empty", "Worker returned an empty reply.");
  }
  return reply;
}

/**
 * Ask for a drawing. The Worker returns a sanitized SVG document plus a short
 * caption. We wrap the SVG in a data URL so it can only ever load as an <img>:
 * no inline markup, no script, no DOM injection.
 * Drawing retries are limited to transport errors: a 75s timeout repeated once
 * would leave the dialog open for two and a half minutes.
 * @param {string} prompt
 * @returns {Promise<{dataUrl: string, caption: string, svg: string}>}
 */
export async function requestDrawing(prompt) {
  const clean = String(prompt ?? "").trim().slice(0, 100);
  if (!clean) {
    throw new ApiError("invalid", "Empty drawing prompt.");
  }

  const data = await post(
    "/draw",
    { prompt: clean },
    DRAW_TIMEOUT_MS,
    { retryTimeouts: false },
  );

  const svg = typeof data?.svg === "string" ? data.svg.trim() : "";
  if (!svg.startsWith("<svg") || !svg.endsWith("</svg>")) {
    throw new ApiError("empty", "Worker returned no drawing.");
  }

  const caption =
    typeof data?.caption === "string" && data.caption.trim().length > 0
      ? data.caption.trim().slice(0, 60)
      : "";

  return {
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    caption,
    svg,
  };
}
