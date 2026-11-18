/**
 * Headless smoke test for the static site.
 *
 * Run with the site served on http://localhost:8000:
 *   python3 -m http.server 8000
 *   npm run test:ui
 *
 * It talks to the real deployed Worker, so the chat and draw steps need the
 * Worker secrets to be configured. Screenshots land in docs/.
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const SITE = process.env.HAL95_SITE ?? "http://localhost:8000";
const results = [];
const errors = [];
let failed = false;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (message) => {
  // The draw test deliberately exercises the Worker's 502 path. Chrome logs
  // every non-2xx fetch as a console error; that is not an app error.
  if (message.type() === "error" && !message.text().includes("status of 502")) {
    errors.push(`console: ${message.text()}`);
  }
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => {
  const reason = request.failure()?.errorText ?? "";
  // Aborts are normal when the test navigates while an image is loading.
  if (request.url().endsWith("/draw") || reason === "net::ERR_ABORTED") return;
  errors.push(`requestfailed: ${request.url()} ${reason}`);
});

try {
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#boot:not([hidden])", { timeout: 10_000 });
  await page.click("#boot-skip");
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10_000 });

  const avatarLoaded = await page.$eval(
    "#avatar",
    (img) => img.complete && img.naturalWidth > 0,
  );
  check("avatar PNG loads", avatarLoaded);

  const before = await page.$$eval(".hal-line--bot", (nodes) => nodes.length);
  await page.fill("#input", "why are you smiling?");
  await page.press("#input", "Enter");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".hal-line--bot").length > count,
    before,
    { timeout: 45_000 },
  );
  await page.waitForFunction(() => !document.querySelector("#input").disabled, {
    timeout: 45_000,
  });
  // The controller re-enables input before the typewriter finishes.
  await page.waitForFunction(
    () => !document.querySelector(".hal-line__text.is-typing"),
    undefined,
    { timeout: 45_000 },
  );

  const reply = await page.$$eval(".hal-line--bot .hal-line__text", (nodes) =>
    (nodes.at(-1)?.textContent ?? "").trim(),
  );
  check("chat reply renders", reply.trim().length > 0, reply);
  check("reply has no raw mood tag", !/^\[[a-z]+\]/i.test(reply), reply);

  const mood = await page.$eval("#mood-label", (node) => node.textContent);
  check("mood label updates", mood !== "neutral", mood);

  const avatarMood = await page.$eval("#avatar", (img) => ({
    src: img.getAttribute("src"),
    ok: img.complete && img.naturalWidth > 0,
  }));
  check("avatar swaps to a mood PNG", avatarMood.ok && /smiling|confused|processing|creepy/.test(avatarMood.src ?? ""), JSON.stringify(avatarMood));

  await mkdir("docs", { recursive: true });
  await page.screenshot({ path: "docs/desktop-1440.png" });

  await page.click("#log-btn");
  await page.waitForSelector("#log-modal:not([hidden])");
  const transcript = await page.$eval("#transcript", (node) => node.textContent ?? "");
  check("Log modal shows the transcript", transcript.includes("You: why are you smiling?"));

  await page.keyboard.press("Escape");
  await page.waitForSelector("#log-modal", { state: "hidden" });

  const beforeNew = await page.$$eval(".hal-line", (nodes) => nodes.length);
  await page.click("#new-btn");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".hal-line").length < count,
    beforeNew,
  );
  const afterNew = await page.$$eval(".hal-line", (nodes) =>
    nodes.map((node) => node.textContent ?? "").join("\n"),
  );
  check("New clears the log", !afterNew.includes("why are you smiling?"));

  await page.click("#draw-btn");
  await page.waitForSelector("#paint-modal:not([hidden])");
  await page.waitForFunction(
    () =>
      !document.querySelector("#paint-image").hidden ||
      !document.querySelector("#paint-error").hidden,
    undefined,
    { timeout: 90_000 },
  );
  const paint = await page.evaluate(() => ({
    image: !document.querySelector("#paint-image").hidden,
    error: document.querySelector("#paint-error").hidden
      ? ""
      : document.querySelector("#paint-error").textContent,
  }));
  check(
    "Draw shows an image or the in-character failure",
    paint.image || paint.error.includes("PRINTER IS ON FIRE"),
    JSON.stringify(paint),
  );
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#boot:not([hidden])", { timeout: 10_000 });
  await page.click("#boot-skip");
  await page.waitForSelector("#boot", { state: "hidden" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check("no horizontal overflow at 375px", overflow <= 1, `overflow ${overflow}px`);
  await page.screenshot({ path: "docs/mobile-375.png" });
} catch (error) {
  check("smoke test completed", false, error.message);
  await page.screenshot({ path: "docs/failure.png" }).catch(() => {});
} finally {
  await browser.close();
}

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
if (errors.length) {
  console.log("\nBrowser errors:");
  for (const error of errors) console.log(`  ${error}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
