/**
 * HAL95 — SVG sanitiser for model-generated drawings.
 *
 * The model is untrusted input even though it runs on our account. We rebuild a
 * fresh document from whitelisted shape elements and attributes, discard all
 * text and non-shape tags, and reject anything oversized. The result can be
 * placed in an <img> data URL without ever executing script.
 */

export const VIEW_BOX = "0 0 320 240";
export const MAX_SVG_BYTES = 8 * 1024;
const MAX_ELEMENTS = 24;
const MAX_CAPTION_CHARS = 48;
const MAX_CAPTION_WORDS = 6;

const ALLOWED_TAGS = new Set([
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
]);

const ALLOWED_ATTRS = new Set([
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "width",
  "height",
  "x1",
  "y1",
  "x2",
  "y2",
  "transform",
  "stroke-linecap",
  "stroke-linejoin",
]);

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+\-.,\s]+$/;
const POINTS = /^[0-9eE+\-.,\s]+$/;
const PAINT = /^[#a-zA-Z0-9(),.%\s+-]+$/;
const TRANSFORM =
  /^(?:(?:translate|scale|rotate|skewX|skewY|matrix)\s*\([0-9eE+\-.,\s]+\)\s*)+$/;

function validAttribute(name, value) {
  if (!value || /[<>"'`&\\]/.test(value)) return false;
  if (/url\s*\(|javascript:|expression|data:/i.test(value)) return false;

  switch (name) {
    case "fill":
    case "stroke":
      return PAINT.test(value);
    case "stroke-width":
      return NUMERIC.test(value);
    case "d":
      return PATH_DATA.test(value);
    case "points":
      return POINTS.test(value);
    case "transform":
      return TRANSFORM.test(value);
    case "stroke-linecap":
      return /^(butt|round|square)$/i.test(value);
    case "stroke-linejoin":
      return /^(miter|round|bevel)$/i.test(value);
    default:
      return NUMERIC.test(value);
  }
}

function cleanAttributes(raw) {
  const attributes = [];
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;

  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();

    // Anything not on the list (style, class, href, xlink:href, onload, …) is
    // dropped. Attribute values are restricted again by validAttribute().
    if (!ALLOWED_ATTRS.has(name) || !validAttribute(name, value)) continue;
    attributes.push(`${name}="${value}"`);
  }

  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function stripDangerousBlocks(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<![^>]*>/g, "");
}

/**
 * Extract, whitelist and rebuild an SVG.
 * @param {unknown} source
 * @returns {{svg: string, elementCount: number} | null}
 */
export function sanitizeSvg(source) {
  if (typeof source !== "string") return null;

  const text = stripDangerousBlocks(source);
  const start = text.search(/<svg\b/i);
  if (start < 0) return null;

  const openEnd = text.indexOf(">", start);
  const close = text.toLowerCase().lastIndexOf("</svg>");
  if (openEnd < 0 || close <= openEnd) return null;

  // The root <svg> tag is discarded and rebuilt, so its attributes (including
  // any onload or external namespaces) can never reach the output.
  const inner = text.slice(openEnd + 1, close);
  const tagPattern = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)\s*>/g;
  const elements = [];
  let match;

  while ((match = tagPattern.exec(inner)) !== null) {
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();

    // Closing tags and the root are ignored. Shapes are emitted self-closing,
    // which flattens disallowed wrappers while keeping their children.
    if (closing || name === "svg") continue;
    if (!ALLOWED_TAGS.has(name)) continue;

    if (elements.length >= MAX_ELEMENTS) return null;
    elements.push(`<${name}${cleanAttributes(match[3])}/>`);
  }

  if (elements.length === 0) return null;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" ` +
    `width="320" height="240">` +
    `<rect x="0" y="0" width="320" height="240" fill="#ffffff"/>` +
    `${elements.join("")}</svg>`;

  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > MAX_SVG_BYTES) return null;

  return { svg, elementCount: elements.length };
}

/** Turn the model's title into a short, plain-text caption. */
export function sanitizeCaption(source) {
  if (typeof source !== "string") return "UNTITLED";

  const words = source
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-zA-Z0-9 .,'!?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, MAX_CAPTION_WORDS);

  const caption = words.join(" ").slice(0, MAX_CAPTION_CHARS).trim();
  return caption || "UNTITLED";
}

/**
 * Parse a full model response containing an SVG and a CAPTION line.
 * @param {string} raw
 * @returns {{svg: string, caption: string} | {error: string}}
 */
export function parseDrawResponse(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: "empty_response" };
  }

  // Models occasionally wrap the answer in a markdown fence despite the prompt.
  const text = raw.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  const captionMatch = /CAPTION\s*:\s*([^\n\r]+)/i.exec(text);
  const cleaned = sanitizeSvg(text);

  if (!cleaned) return { error: "invalid_svg" };

  return {
    svg: cleaned.svg,
    caption: sanitizeCaption(captionMatch?.[1] ?? ""),
  };
}
