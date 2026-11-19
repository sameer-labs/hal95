/**
 * HAL95 — Cloudflare Worker proxy.
 *
 * The browser never holds an API key and never supplies the system prompt.
 * This Worker:
 *   1. validates origin, size and shape of the request
 *   2. rate limits per IP (KV) and globally per day (KV)
 *   3. injects HAL95's persona server-side
 *   4. calls DeepSeek with a hard output cap
 *   5. returns { reply } from POST /, or a sanitised SVG from POST /draw
 *
 * Both routes use DeepSeek: the chat route asks for a persona reply, the draw
 * route asks the same model to pretend it is a terrible 1998 paint program.
 * Model output is never trusted: the SVG is rebuilt from a shape whitelist.
 *
 * Secrets (set with `wrangler secret put`, never committed):
 *   DEEPSEEK_API_KEY     — DeepSeek chat completions (chat and drawing)
 *
 * KV binding (see wrangler.toml):
 *   RATE_LIMIT           — counters shared across isolates
 */

import { HAL95_SYSTEM_PROMPT } from "../js/persona.js";
import { parseDrawResponse } from "./sanitize.js";

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

const RATE_LIMIT_MAX = 20; // chat requests per IP…
const DRAW_RATE_LIMIT_MAX = 5; // …drawings per IP…
const RATE_LIMIT_WINDOW_MS = 60_000; // …per minute
const GLOBAL_DAILY_MAX = 1_500; // all requests, all IPs, per UTC day
const DRAW_DAILY_WEIGHT = 2; // drawings are ~2× the spend of a chat reply

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
 * Drawing uses the same text model as chat, with a completely separate prompt
 * and token budget. One retry covers a malformed or empty SVG; two attempts at
 * 35 seconds still fit inside the browser's 75-second request timeout.
 */
const DRAW_TIMEOUT_MS = 35_000;
const DRAW_ATTEMPTS = 2;
const MAX_DRAW_PROMPT_CHARS = 100;
const MAX_DRAW_TOKENS = 900;
const MAX_DRAW_REPLY_CHARS = 32_000; // guard before the sanitiser's 8 KB cap

/**
 * The artist is deliberately bad. Every rule below exists to stop the model
 * drifting into clean illustration: fixed canvas, few shapes, thick wobbly
 * outlines, flat colours that miss their own edges, and a short caption.
 * The sanitizer accepts only shape elements, so text inside the SVG is dropped
 * even if the model ignores the instruction.
 */
const DRAW_SYSTEM_PROMPT = `You are HAL95's drawing module: a cheap 1998 paint program operated by a machine that has never seen the thing it is drawing. You draw deliberately badly. The result should be crude, childlike and only just recognisable, like an MS Paint sketch made with a mouse that sticks.

OUTPUT RULES
- Return ONLY the SVG document, then a single newline, then one line starting exactly with "CAPTION:".
- No markdown fences, no commentary, no explanations.
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240">
- The first child MUST be <rect x="0" y="0" width="320" height="240" fill="#ffffff"/>
- Use 6 to 14 shape elements in total, including the white background rect.
- Allowed elements only: rect, circle, ellipse, line, polyline, polygon, path.
- Never use text, style, script, image, foreignObject, href, xlink, filters or external references.
- Outlines: stroke="#000000" with stroke-width between 4 and 8, stroke-linecap="round", stroke-linejoin="round". Lines should be crooked, not straight.
- Colour: flat bright fills only (#e02020, #2050e0, #f0d000, #20a040, #f08020) and let some colour spill past an outline.
- Proportions must be wrong. Parts can float, overlap or point the wrong way. The subject must still be identifiable after a second of squinting.
- Keep every shape roughly inside the 320x240 canvas.
- CAPTION: at most 6 words, plain uppercase text, no quotes, no explanation of quality.

EXAMPLE 1
User: Draw: a horse
Assistant:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240"><rect x="0" y="0" width="320" height="240" fill="#ffffff"/><ellipse cx="150" cy="140" rx="80" ry="40" fill="#e02020" stroke="#000000" stroke-width="6"/><line x1="100" y1="160" x2="88" y2="212" stroke="#000000" stroke-width="7" stroke-linecap="round"/><line x1="130" y1="170" x2="126" y2="216" stroke="#000000" stroke-width="7" stroke-linecap="round"/><line x1="180" y1="170" x2="184" y2="214" stroke="#000000" stroke-width="7" stroke-linecap="round"/><line x1="206" y1="158" x2="216" y2="208" stroke="#000000" stroke-width="7" stroke-linecap="round"/><path d="M222 132 L264 88 L278 120 L244 150 Z" fill="#e02020" stroke="#000000" stroke-width="6" stroke-linejoin="round"/><circle cx="252" cy="108" r="4" fill="#000000"/><path d="M72 124 L40 96 L44 132" fill="none" stroke="#000000" stroke-width="6" stroke-linecap="round"/></svg>
CAPTION: HORSE. PROBABLY.

EXAMPLE 2
User: Draw: a rocket
Assistant:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240"><rect x="0" y="0" width="320" height="240" fill="#ffffff"/><path d="M160 24 C128 64 130 138 142 182 L178 182 C192 136 192 66 160 24 Z" fill="#d0d0d0" stroke="#000000" stroke-width="6" stroke-linejoin="round"/><circle cx="160" cy="92" r="20" fill="#2050e0" stroke="#000000" stroke-width="5"/><polygon points="140,172 160,228 182,172" fill="#f08020" stroke="#000000" stroke-width="5" stroke-linejoin="round"/><path d="M136 158 L106 202 L142 192" fill="#e02020" stroke="#000000" stroke-width="5" stroke-linejoin="round"/><path d="M184 158 L214 202 L178 192" fill="#e02020" stroke="#000000" stroke-width="5" stroke-linejoin="round"/></svg>
CAPTION: IT GOES UP.

EXAMPLE 3
User: Draw: my mum
Assistant:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240"><rect x="0" y="0" width="320" height="240" fill="#ffffff"/><circle cx="160" cy="98" r="46" fill="#f0c0a0" stroke="#000000" stroke-width="6"/><circle cx="144" cy="90" r="4" fill="#000000"/><circle cx="178" cy="88" r="5" fill="#000000"/><path d="M146 118 Q160 132 178 116" fill="none" stroke="#000000" stroke-width="5" stroke-linecap="round"/><path d="M114 62 Q160 10 208 64" fill="none" stroke="#7a4a20" stroke-width="9" stroke-linecap="round"/><path d="M122 150 L98 228 L222 228 L198 150 Z" fill="#2050e0" stroke="#000000" stroke-width="6" stroke-linejoin="round"/></svg>
CAPTION: SHE IS TALLER THAN THIS.

Now draw the requested subject in the same style.`;


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

function checkMemoryRateLimit(ip, max, scope) {
  const now = Date.now();
  const key = `${scope}:${ip}`;

  // Opportunistic cleanup so the map cannot grow forever in a hot isolate.
  if (buckets.size > 5_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) buckets.delete(bucketKey);
    }
  }

  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, retryAfter: 0 };
  }

  if (bucket.count >= max) {
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

function checkMemoryDaily(weight) {
  const day = utcDay();
  if (memoryDay.day !== day) memoryDay = { day, count: 0 };
  memoryDay.count += weight;

  if (memoryDay.count > GLOBAL_DAILY_MAX) {
    return {
      allowed: false,
      scope: "global",
      retryAfter: secondsUntilUtcMidnight(),
    };
  }

  return { allowed: true, retryAfter: 0 };
}

async function incrementKv(env, key, expirationTtl, by = 1) {
  const current = Number(await env.RATE_LIMIT.get(key)) || 0;
  const next = current + by;
  await env.RATE_LIMIT.put(key, String(next), { expirationTtl });
  return next;
}

async function checkRateLimit(env, ip, { draw = false } = {}) {
  const scope = draw ? "draw" : "chat";
  const ipMax = draw ? DRAW_RATE_LIMIT_MAX : RATE_LIMIT_MAX;
  const weight = draw ? DRAW_DAILY_WEIGHT : 1;

  // Always run the in-isolate counters. KV propagation can lag by up to a
  // minute, so this is what makes a rapid burst fail fast on one isolate.
  const memory = checkMemoryRateLimit(ip, ipMax, scope);
  if (!memory.allowed) return memory;

  const dailyMemory = checkMemoryDaily(weight);
  if (!dailyMemory.allowed) return dailyMemory;

  if (env.RATE_LIMIT) {
    try {
      const day = utcDay();
      const globalKey = `rl:global:${day}`;
      const ipKey =
        `rl:${scope}:${ip}:${Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS)}`;

      // Count every accepted request against the daily spend guard first.
      // Drawings cost more, so they consume two units of the daily budget.
      const globalCount = await incrementKv(env, globalKey, 172_800, weight);
      if (globalCount > GLOBAL_DAILY_MAX) {
        return {
          allowed: false,
          scope: "global",
          retryAfter: secondsUntilUtcMidnight(),
        };
      }

      const ipCount = await incrementKv(env, ipKey, 120);
      if (ipCount > ipMax) {
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
  if (!env.DEEPSEEK_API_KEY) {
    console.error("HAL95: DEEPSEEK_API_KEY is not configured");
    return json({ error: ERRORS.image }, 500, origin);
  }

  const parsed = await readJson(request);
  if (parsed.error) return json({ error: ERRORS.corrupt }, 400, origin);

  const rawPrompt = parsed.value?.prompt;
  if (typeof rawPrompt !== "string") {
    return json({ error: ERRORS.corrupt }, 400, origin);
  }

  const prompt = rawPrompt.replace(/\s+/g, " ").trim();
  if (prompt.length === 0 || prompt.length > MAX_DRAW_PROMPT_CHARS) {
    return json({ error: ERRORS.corrupt }, 400, origin);
  }

  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt += 1) {
    const reminder =
      attempt === 0
        ? ""
        : "\n\nYour previous file was corrupt. Return only a valid SVG, then one CAPTION line.";

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
            { role: "system", content: DRAW_SYSTEM_PROMPT },
            { role: "user", content: `Draw: ${prompt}${reminder}` },
          ],
          thinking: { type: "disabled" },
          max_tokens: MAX_DRAW_TOKENS,
          temperature: 1.0,
          stream: false,
        }),
        signal: AbortSignal.timeout(DRAW_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("HAL95: draw request failed", error?.name ?? "unknown", attempt);
      continue;
    }

    if (upstream.status === 429) {
      console.error("HAL95: DeepSeek rate limited the draw route");
      return json({ error: ERRORS.busy }, 429, origin);
    }

    if (!upstream.ok) {
      console.error("HAL95: DeepSeek draw responded", upstream.status, attempt);
      continue;
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      console.error("HAL95: draw response was not JSON", attempt);
      continue;
    }

    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || raw.length > MAX_DRAW_REPLY_CHARS) {
      console.error("HAL95: draw response was missing or oversized", attempt);
      continue;
    }

    const drawing = parseDrawResponse(raw);
    if (drawing.error) {
      console.error("HAL95: draw response rejected", drawing.error, attempt);
      continue;
    }

    return json(
      {
        svg: drawing.svg,
        caption: drawing.caption,
        prompt,
      },
      200,
      origin,
    );
  }

  return json({ error: ERRORS.image }, 502, origin);
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

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path !== "/" && path !== "/draw") {
      return json({ error: ERRORS.notFound }, 404, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const limit = await checkRateLimit(env, ip, { draw: path === "/draw" });
    if (!limit.allowed) {
      console.error("HAL95: rate limited", limit.scope, path);
      return rateLimitReply(limit, origin);
    }

    if (path === "/draw") return handleDraw(request, env, origin);
    return handleChat(request, env, origin);
  },
};
