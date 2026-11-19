/**
 * Sanitizer and draw-response tests. No network, no secrets.
 *
 *   npm run test:sanitizer
 *
 * The hostile cases mirror the things a model (or a prompt-injected model)
 * might emit: script tags, event handlers, external references, CSS injection,
 * XML entities and oversized output.
 */

import assert from "node:assert/strict";
import {
  MAX_SVG_BYTES,
  parseDrawResponse,
  sanitizeCaption,
  sanitizeSvg,
} from "../worker/sanitize.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

const VALID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">
  <rect x="0" y="0" width="320" height="240" fill="#ffffff"/>
  <ellipse cx="150" cy="140" rx="80" ry="40" fill="#e02020" stroke="#000000" stroke-width="6"/>
  <line x1="100" y1="160" x2="88" y2="212" stroke="#000000" stroke-width="7" stroke-linecap="round"/>
  <path d="M222 132 L264 88 L278 120 Z" fill="#e02020" stroke="#000000" stroke-width="6"/>
</svg>
CAPTION: HORSE. PROBABLY.`;

test("valid drawing is rebuilt with a fixed canvas", () => {
  const result = parseDrawResponse(VALID);
  assert.equal(result.error, undefined);
  assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 320 240"/);
  assert.match(result.svg, /width="320" height="240"/);
  assert.match(result.svg, /<rect x="0" y="0" width="320" height="240" fill="#ffffff"\/>/);
  assert.match(result.svg, /<ellipse /);
  assert.equal(result.caption, "HORSE. PROBABLY.");
});

test("markdown fences are tolerated", () => {
  const result = parseDrawResponse("```svg\n" + VALID + "\n```");
  assert.equal(result.error, undefined);
  assert.equal(result.caption, "HORSE. PROBABLY.");
});

test("script, event handlers and foreign objects are removed", () => {
  const hostile = `<svg viewBox="0 0 320 240" onload="alert(1)">
    <script>alert(1)</script>
    <foreignObject><div>owned</div></foreignObject>
    <rect x="1" y="2" width="30" height="40" fill="red" onload="x()" onclick="y()"/>
    <image href="https://evil.example/x.png"/>
    <text x="10" y="10">owned</text>
    <a xlink:href="javascript:alert(1)"><circle cx="20" cy="20" r="5" fill="#000"/></a>
  </svg>
  CAPTION: <b>bad</b> input with far too many words in it`;

  const result = parseDrawResponse(hostile);
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.svg, /script|onload|onclick|foreignObject|<image|<text|xlink|href|javascript|owned/i);
  assert.match(result.svg, /<rect x="1" y="2" width="30" height="40" fill="red"\/>/);
  assert.match(result.svg, /<circle cx="20" cy="20" r="5" fill="#000"\/>/);
  assert.ok(result.caption.split(" ").length <= 6, result.caption);
});

test("external paints, CSS and data URLs are rejected", () => {
  const result = sanitizeSvg(`<svg viewBox="0 0 320 240">
    <path d="M0 0 L100 100" fill="url(https://evil.example/x)" stroke="#000" stroke-width="6"/>
    <rect x="0" y="0" width="10" height="10" fill="data:text/html,<script>alert(1)</script>"/>
    <circle cx="10" cy="10" r="9" style="background:url(javascript:alert(1))" class="x"/>
    <line x1="0" y1="0" x2="10" y2="10" stroke="expression(alert(1))"/>
  </svg>`);
  assert.ok(result);
  assert.doesNotMatch(result.svg, /url\(|data:|style=|class=|expression|javascript/i);
  assert.match(result.svg, /<path d="M0 0 L100 100" stroke="#000" stroke-width="6"\/>/);
});

test("unknown elements are dropped but allowed children survive", () => {
  const result = sanitizeSvg(`<svg><g transform="translate(10 10)"><rect x="0" y="0" width="8" height="8" fill="#f0d000"/></g></svg>`);
  assert.ok(result);
  assert.doesNotMatch(result.svg, /<g/);
  assert.match(result.svg, /<rect x="0" y="0" width="8" height="8" fill="#f0d000"\/>/);
});

test("empty or text-only SVG is rejected", () => {
  assert.equal(sanitizeSvg("<svg></svg>"), null);
  assert.equal(sanitizeSvg("<svg><text>hello</text></svg>"), null);
  assert.equal(sanitizeSvg("not an svg"), null);
  assert.equal(sanitizeSvg(null), null);
});

test("too many elements are rejected", () => {
  const shapes = Array.from(
    { length: 30 },
    (_, index) => `<rect x="${index}" y="0" width="4" height="4" fill="#000"/>`,
  ).join("");
  assert.equal(sanitizeSvg(`<svg>${shapes}</svg>`), null);
});

test("oversized SVG is rejected", () => {
  const longPath = `M0 0${" L1 1".repeat(900)}`;
  const shapes = Array.from(
    { length: 10 },
    () => `<path d="${longPath}" stroke="#000"/>`,
  ).join("");
  const svg = `<svg>${shapes}</svg>`;
  assert.ok(new TextEncoder().encode(svg).length > MAX_SVG_BYTES);
  assert.equal(sanitizeSvg(svg), null);
});

test("captions are short plain text", () => {
  assert.equal(sanitizeCaption("<b>HELLO</b> world, this is much too long"), "HELLO world, this is much too");
  assert.equal(sanitizeCaption(""), "UNTITLED");
  assert.equal(sanitizeCaption(null), "UNTITLED");
});

test("missing output never leaks a raw reply", () => {
  const result = parseDrawResponse("I cannot draw that.");
  assert.deepEqual(result, { error: "invalid_svg" });
});

console.log(`\n${passed}/${passed + failed} sanitizer checks passed`);
process.exit(failed ? 1 : 0);
