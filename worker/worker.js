/**
 * HAL95 — Cloudflare Worker proxy.
 *
 * The browser never holds an API key and never supplies the system prompt.
 * This Worker:
 *   1. validates origin, size and shape of the request
 *   2. rate limits per IP (KV) and globally per day (KV)
 *   3. injects HAL95's persona server-side
 *   4. calls DeepSeek with a hard output cap
 *   5. returns { reply } (or a base64 image from POST /draw)
 *
 * Secrets (set with `wrangler secret put`, never committed):
 *   DEEPSEEK_API_KEY     — DeepSeek chat completions
 *   HUGGINGFACE_API_KEY  — Hugging Face Inference Providers (image route)
 *
 * KV binding (see wrangler.toml):
 *   RATE_LIMIT           — counters shared across isolates
 */

import { HAL95_SYSTEM_PROMPT } from "../js/persona.js";

/* ==========================================================================
 * CONFIGURATION
 * ========================================================================== */

/**
 * Browser origins allowed to call this Worker. Exact match, no trailing slash.
 * GitHub Pages serves the site at https://<user>.github.io/hal95/; the origin
 * is only the scheme + host, never the path.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:8000",
  "https://sameer-labs.github.io",
];

const RATE_LIMIT_MAX = 20; // requests per IP…
const RATE_LIMIT_WINDOW_MS = 60_000; // …per minute
const GLOBAL_DAILY_MAX = 1_500; // all requests, all IPs, per UTC day

const MAX_HISTORY_MESSAGES = 10;
const MAX_INPUT_CHARS = 300;
const MAX_OUTPUT_TOKENS = 80;
const MAX_BODY_CHARS = 32_768;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
// Verified against https://api-docs.deepseek.com (Nov 2026): the current model
// IDs are deepseek-flash and deepseek-v4-pro. Legacy deepseek-chat is retired.
const DEEPSEEK_MODEL = "deepseek-flash";
const DEEPSEEK_TIMEOUT_MS = 20_000;

/**
 * Image provider. As of Nov 2026 this is the only text-to-image model mapped to
 * the `hf-inference` provider (verified with the Hugging Face model API). It is
 * gated: the Hugging Face account must accept the SD3 licence and the token
 * must have Inference Providers write permission, otherwise the router returns
 * 403. The request body follows the HF `{ inputs, parameters, options }` shape.
 */
const IMAGE_PROVIDER_URL =
  "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers";
const IMAGE_MODEL = "stabilityai/stable-diffusion-3-medium-diffusers";
const IMAGE_SECRET_NAME = "HUGGINGFACE_API_KEY";
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_DRAW_PROMPT_CHARS = 200;

/** Style cues that keep the drawing deliberately crude, not impressive. */
const DRAW_STYLE_PREFIX =
  "badly drawn, childlike scribble, MS Paint style, wobbly lines, flat colours, crude, no shading";

const MAX_IMAGE_BYTES = 2_000_000; // keep the Worker response comfortably small

/** Generic, in-character failures. Real upstream detail only ever hits logs. */
const ERRORS = {
  busy: "THE LINE IS BUSY. CALL BACK LATER.",
  busyTomorrow: "THE LINE IS BUSY. CALL BACK TOMORROW.",
  corrupt: "THAT FILE IS CORRUPT. TRY LATER.",
  signal: "THE LINE IS DOWN. TRY AGAIN.",
  image: "THE PRINTER IS ON FIRE.",
  notFound: "FILE NOT FOUND.",
};

/* ==========================================================================
 * CORS
 * ========================================================================== */

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

/** Only reflect an allow-listed origin. Never echo an arbitrary Origin. */
function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(body, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/* ==========================================================================
 * RATE LIMITING
 *
 * KV counters are shared across isolates, unlike the in-memory map. KV is
 * eventually consistent, so a burst can overshoot slightly; the daily cap is
 * still the hard spending guard. If KV is missing or throws, we fall back to
 * the per-isolate map rather than failing closed.
 * ========================================================================== */

const buckets = new Map();
let memoryDay = { day: "", count: 0 };

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

function secondsUntilNextMinute() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
}

function checkMemoryRateLimit(ip) {
  const now = Date.now();

  // Opportunistic cleanup so the map cannot grow forever in a hot isolate.
  if (buckets.size > 5_000) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) buckets.delete(key);
    }
  }

  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(ip, { windowStart: now, count: 1 });
    return { allowed: true, retryAfter: 0 };
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      scope: "ip",
      retryAfter: Math.max(
        1,
        Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
      ),
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function checkMemoryDaily() {
  const day = utcDay();
  if (memoryDay.day !== day) memoryDay = { day, count: 0 };
  memoryDay.count += 1;

  if (memoryDay.count > GLOBAL_DAILY_MAX) {
    return {
      allowed: false,
      scope: "global",
      retryAfter: secondsUntilUtcMidnight(),
    };
  }

  return { allowed: true, retryAfter: 0 };
}

async function incrementKv(env, key, expirationTtl) {
  const current = Number(await env.RATE_LIMIT.get(key)) || 0;
  const next = current + 1;
  await env.RATE_LIMIT.put(key, String(next), { expirationTtl });
  return next;
}

async function checkRateLimit(env, ip) {
  // Always run the in-isolate counters. KV propagation can lag by up to a
  // minute, so this is what makes a rapid burst fail fast on one isolate.
  const memory = checkMemoryRateLimit(ip);
  if (!memory.allowed) return memory;

  const dailyMemory = checkMemoryDaily();
  if (!dailyMemory.allowed) return dailyMemory;

  if (env.RATE_LIMIT) {
    try {
      const day = utcDay();
      const globalKey = `rl:global:${day}`;
      const ipKey = `rl:ip:${ip}:${Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS)}`;

      // Count every accepted request against the daily spend guard first.
      const globalCount = await incrementKv(env, globalKey, 172_800);
      if (globalCount > GLOBAL_DAILY_MAX) {
        return {
          allowed: false,
          scope: "global",
          retryAfter: secondsUntilUtcMidnight(),
        };
      }

      const ipCount = await incrementKv(env, ipKey, 120);
      if (ipCount > RATE_LIMIT_MAX) {
        return {
          allowed: false,
          scope: "ip",
          retryAfter: secondsUntilNextMinute(),
        };
      }

      return { allowed: true, retryAfter: 0 };
    } catch (error) {
      console.error(
        "HAL95: KV rate limit failed, using memory",
        error?.message ?? "unknown",
      );
    }
  }

  // Memory already counted this request; a KV outage never fails closed.
  return { allowed: true, retryAfter: 0 };
}

/* ==========================================================================
 * INPUT HANDLING
 * ========================================================================== */

function isJsonRequest(request) {
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  return type.includes("application/json");
}

/** Read and parse a bounded JSON body. Returns { value } or { error }. */
async function readJson(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "unreadable" };
  }

  if (text.length === 0) return { error: "empty" };
  if (text.length > MAX_BODY_CHARS) return { error: "too_large" };

  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "invalid_json" };
  }
}

/**
 * Server-side validation. System roles are stripped, never forwarded. Any
 * other malformed entry rejects the whole request with a 400.
 */
function validateMessages(raw) {
  if (!Array.isArray(raw)) return { error: "messages_not_array" };
  if (raw.length === 0) return { error: "no_messages" };
  if (raw.length > MAX_HISTORY_MESSAGES * 3) return { error: "too_many_messages" };

  const messages = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "invalid_message" };
    }

    // Client-supplied system prompts are discarded; ours is injected below.
    if (entry.role === "system") continue;

    if (entry.role !== "user" && entry.role !== "assistant") {
      return { error: "invalid_role" };
    }

    if (typeof entry.content !== "string") {
      return { error: "invalid_content" };
    }

    const content = entry.content.trim();
    if (content.length === 0) return { error: "empty_content" };
    if (content.length > MAX_INPUT_CHARS) return { error: "content_too_long" };

    messages.push({ role: entry.role, content });
  }

  if (messages.length === 0) return { error: "no_messages" };
  if (messages.length > MAX_HISTORY_MESSAGES) return { error: "too_much_history" };

  return { messages };
}

function base64Encode(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

function rateLimitReply(limit, origin) {
  const message =
    limit.scope === "global" ? ERRORS.busyTomorrow : ERRORS.busy;

  return json({ error: message }, 429, origin, {
    "Retry-After": String(limit.retryAfter),
  });
}

/* ==========================================================================
 * ROUTES
 * ========================================================================== */

async function handleChat(request, env, origin) {
  if (!env.DEEPSEEK_API_KEY) {
    console.error("HAL95: DEEPSEEK_API_KEY is not configured");
    return json({ error: ERRORS.signal }, 500, origin);
  }

  const parsed = await readJson(request);
  if (parsed.error) return json({ error: ERRORS.corrupt }, 400, origin);

  const validated = validateMessages(parsed.value?.messages);
  if (validated.error) {
    console.error("HAL95: rejected chat input", validated.error);
    return json({ error: ERRORS.corrupt }, 400, origin);
  }

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: HAL95_SYSTEM_PROMPT },
          ...validated.messages,
        ],
        // Thinking mode would burn the 80-token budget before any visible text.
        thinking: { type: "disabled" },
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.9,
        stream: false,
      }),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("HAL95: DeepSeek request failed", error?.name ?? "unknown");
    return json({ error: ERRORS.signal }, 504, origin);
  }

  if (upstream.status === 429) {
    console.error("HAL95: DeepSeek rate limited");
    return json({ error: ERRORS.busy }, 429, origin);
  }

  if (!upstream.ok) {
    // Never forward the provider's body or headers, only the status to logs.
    console.error("HAL95: DeepSeek responded", upstream.status);
    return json({ error: ERRORS.corrupt }, 502, origin);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    console.error("HAL95: DeepSeek returned invalid JSON");
    return json({ error: ERRORS.corrupt }, 502, origin);
  }

  const reply = data?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || reply.trim().length === 0) {
    console.error("HAL95: DeepSeek returned an empty reply");
    return json({ error: ERRORS.corrupt }, 502, origin);
  }

  // 80 tokens is already short; this is only a guard against a chatty model.
  return json({ reply: reply.trim().slice(0, 600) }, 200, origin);
}

async function handleDraw(request, env, origin) {
  const token = env[IMAGE_SECRET_NAME];
  if (!token) {
    console.error(`HAL95: ${IMAGE_SECRET_NAME} is not configured`);
    return json({ error: ERRORS.image }, 500, origin);
  }

  const parsed = await readJson(request);
  if (parsed.error) return json({ error: ERRORS.corrupt }, 400, origin);

  const rawPrompt = parsed.value?.prompt;
  if (typeof rawPrompt !== "string") {
    return json({ error: ERRORS.corrupt }, 400, origin);
  }

  const prompt = rawPrompt.trim();
  if (prompt.length === 0 || prompt.length > MAX_DRAW_PROMPT_CHARS) {
    return json({ error: ERRORS.corrupt }, 400, origin);
  }

  const styledPrompt = `${prompt}, ${DRAW_STYLE_PREFIX}`;

  let upstream;
  try {
    upstream = await fetch(IMAGE_PROVIDER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "image/png",
      },
      body: JSON.stringify({
        inputs: styledPrompt,
        parameters: {
          negative_prompt: "photorealistic, highly detailed, professional, masterpiece",
          num_inference_steps: 20,
          guidance_scale: 7,
          width: 512,
          height: 512,
        },
        options: { wait_for_model: true },
      }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("HAL95: image request failed", error?.name ?? "unknown");
    return json({ error: ERRORS.image }, 504, origin);
  }

  if (!upstream.ok) {
    console.error("HAL95: image provider responded", upstream.status, IMAGE_MODEL);
    return json({ error: ERRORS.image }, upstream.status === 503 ? 503 : 502, origin);
  }

  const contentType = upstream.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("image/")) {
    // Hugging Face returns JSON when the model is loading or the token is bad.
    console.error("HAL95: unexpected image content type", contentType);
    return json({ error: ERRORS.image }, 502, origin);
  }

  let buffer;
  try {
    buffer = await upstream.arrayBuffer();
  } catch {
    console.error("HAL95: image body could not be read");
    return json({ error: ERRORS.image }, 502, origin);
  }

  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
    console.error("HAL95: image size rejected", buffer.byteLength);
    return json({ error: ERRORS.image }, 502, origin);
  }

  return json(
    {
      image: base64Encode(buffer),
      mimeType: contentType.split(";")[0].trim(),
      prompt,
    },
    200,
    origin,
  );
}

/* ==========================================================================
 * ENTRY POINT
 * ========================================================================== */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";

    // Preflight: answer allowed origins, refuse everything else with no CORS
    // allow header so the browser blocks the request.
    if (request.method === "OPTIONS") {
      if (origin && !isAllowedOrigin(origin)) {
        return new Response(null, { status: 403, headers: { Vary: "Origin" } });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Requests without an Origin (curl, health checks) are allowed through for
    // local debugging; browsers always send one on cross-site POSTs.
    if (origin && !isAllowedOrigin(origin)) {
      return json({ error: ERRORS.notFound }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: ERRORS.notFound }, 405, origin);
    }

    if (!isJsonRequest(request)) {
      return json({ error: ERRORS.corrupt }, 400, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const limit = await checkRateLimit(env, ip);
    if (!limit.allowed) {
      console.error("HAL95: rate limited", limit.scope);
      return rateLimitReply(limit, origin);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (path === "/draw") return handleDraw(request, env, origin);
    if (path === "/") return handleChat(request, env, origin);

    return json({ error: ERRORS.notFound }, 404, origin);
  },
};
