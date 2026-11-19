/**
 * Headless smoke test for the static site.
 *
 * Run with the site served on http://localhost:8000:
 *   python3 -m http.server 8000
 *   npm run test:ui
 *
 * It talks to the real deployed Worker, so the chat and draw steps need the
 * Worker secret to be configured. Screenshots land in docs/.
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
  // Expected upstream trouble is already turned into in-character UI copy.
  // Chrome logs every non-2xx fetch as a console error; that is not an app bug.
  const text = message.text();
  const expected = /status of (429|500|502|503|504)/.test(text) || text.includes("/draw");
  if (message.type() === "error" && !expected) {
    errors.push(`console: ${text}`);
  }
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => {
  const reason = request.failure()?.errorText ?? "";
  // Aborts are normal when the test navigates while an image is loading.
  if (request.url().endsWith("/draw") || reason === "net::ERR_ABORTED") return;
  errors.push(`requestfailed: ${request.url()} ${reason}`);
});

async function dismissBoot() {
  if (await page.isVisible("#boot-skip")) {
    await page.click("#boot-skip");
  }
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10_000 });
}

async function waitForTyping() {
  await page.waitForFunction(
    () => !document.querySelector(".hal-line__text.is-typing"),
    undefined,
    { timeout: 45_000 },
  );
}

try {
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#boot:not([hidden])", { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#boot-text").textContent;
      return text.includes("MEMORY CHECK") && text.includes("LAST LOGIN");
    },
    undefined,
    { timeout: 8_000 },
  );
  const bootText = await page.$eval("#boot-text", (node) => node.textContent ?? "");
  check("boot shows a last-login line", /LAST LOGIN/.test(bootText));
  check("boot shows a fake memory check", /MEMORY CHECK/.test(bootText));

  await dismissBoot();
  await page.waitForSelector("#taskbar", { state: "visible" });
  check("status bar starts online", (await page.$eval("#status-text", (node) => node.textContent)) === "ONLINE");

  const avatarLoaded = await page.$eval(
    "#avatar",
    (img) => img.complete && img.naturalWidth > 0,
  );
  check("avatar PNG loads", avatarLoaded);

  const before = await page.$$eval(".hal-line--bot", (nodes) => nodes.length);
  await page.fill("#input", "why are you smiling?");
  await page.press("#input", "Enter");

  const thinking = await page
    .waitForFunction(
      () => document.querySelector("#status-text").textContent === "THINKING...",
      undefined,
      { timeout: 3_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("status bar shows THINKING... during a reply", thinking);

  await page.waitForFunction(
    (count) => document.querySelectorAll(".hal-line--bot").length > count,
    before,
    { timeout: 45_000 },
  );
  await page.waitForFunction(() => !document.querySelector("#input").disabled, {
    timeout: 45_000,
  });
  await waitForTyping();

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
  check(
    "avatar swaps to a mood PNG",
    avatarMood.ok && /smiling|confused|processing|creepy/.test(avatarMood.src ?? ""),
    JSON.stringify(avatarMood),
  );

  // Close must not close: it answers in character and leaves the window up.
  const beforeClose = await page.$$eval(".hal-line", (nodes) => nodes.length);
  await page.click("#close-btn");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".hal-line").length > count,
    beforeClose,
  );
  await waitForTyping();
  const closeLine = await page.$$eval(".hal-line__text", (nodes) =>
    (nodes.at(-1)?.textContent ?? "").trim(),
  );
  check("Close answers instead of closing", closeLine === "YOU CAN'T LEAVE. I MEAN, OK.", closeLine);
  check("window stays open after Close", await page.isVisible("#hal-window"));

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
  await waitForTyping();

  // Drawing: the Worker must return a sanitized SVG data URL and a caption.
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
    src: document.querySelector("#paint-image").getAttribute("src") ?? "",
    caption: document.querySelector("#paint-caption").textContent ?? "",
    made: !document.querySelector("#paint-made").hidden,
    error: document.querySelector("#paint-error").hidden
      ? ""
      : document.querySelector("#paint-error").textContent,
  }));
  check("Draw shows an SVG image", paint.image && paint.src.startsWith("data:image/svg+xml"), JSON.stringify(paint));
  check("Draw shows a caption", paint.caption.trim().length > 0, paint.caption);
  check("Draw shows 'I made you this.'", paint.made);
  if (!paint.image) check("Draw did not fall back to the printer error", false, paint.error);

  await mkdir("docs", { recursive: true });
  await page.screenshot({ path: "docs/paint-1440.png" });

  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.click("#paint-save");
  const download = await downloadPromise;
  check(
    "Save downloads a PNG",
    download.suggestedFilename().endsWith(".png"),
    download.suggestedFilename(),
  );
  await download.delete().catch(() => {});

  await page.keyboard.press("Escape");
  await page.waitForSelector("#paint-modal", { state: "hidden" });

  // Taskbar clock, Start menu, and the two desktop shortcuts.
  const clock = await page.$eval("#taskbar-clock", (node) => node.textContent ?? "");
  check("taskbar clock shows a time", /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(clock.trim()), clock);

  await page.click("#start-btn");
  await page.waitForSelector("#start-menu:not([hidden])");
  check("Start menu opens", await page.isVisible("#start-about"));
  await page.click("#start-about");
  await page.waitForSelector("#info-modal:not([hidden])");
  check(
    "About HAL95 opens",
    (await page.$eval("#info-title", (node) => node.textContent)) === "ABOUT.TXT",
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector("#info-modal", { state: "hidden" });

  await page.click("#icon-recycle");
  await page.waitForSelector("#recycle-modal:not([hidden])");
  const recycle = (await page.$eval("#recycle-text", (node) => node.textContent ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  check(
    "Recycle Bin remembers everything",
    recycle.includes("Deleted conversations: 0") && recycle.includes("I remember all of them"),
    recycle,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector("#recycle-modal", { state: "hidden" });

  // Minimize to the taskbar and restore.
  await page.click("#min-btn");
  await page.waitForSelector("#hal-window", { state: "hidden" });
  check("Minimize hides the window", await page.isVisible("#task-hal"));
  await page.click("#task-hal");
  await page.waitForSelector("#hal-window", { state: "visible" });
  check("taskbar button restores the window", await page.isVisible("#hal-window"));

  // Dragging the title bar moves the window.
  const titleBox = await page.locator("#hal-title-bar").boundingBox();
  await page.mouse.move(titleBox.x + 120, titleBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + 180, titleBox.y + 30, { steps: 6 });
  await page.mouse.up();
  const transform = await page.$eval("#hal-window", (node) => node.style.transform);
  check("title bar drags the window", /translate\([-\d.]+px, [-\d.]+px\)/.test(transform), transform);
  await page.evaluate(() => {
    document.querySelector("#hal-window").style.transform = "";
  });

  // Tab title waits while the window is blurred and restores on focus.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const awayTitle = await page.title();
  check("tab title waits when hidden", awayTitle.includes("waiting"), awayTitle);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const backTitle = await page.title();
  check("tab title restores on focus", !backTitle.includes("waiting"), backTitle);

  await mkdir("docs", { recursive: true });
  await page.screenshot({ path: "docs/desktop-1440.png" });

  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#boot:not([hidden])", { timeout: 10_000 });
  await dismissBoot();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check("no horizontal overflow at 375px", overflow <= 1, `overflow ${overflow}px`);
  check("desktop icons stay off the small screen", !(await page.isVisible("#icon-readme")));
  check("taskbar clock still fits at 375px", await page.isVisible("#taskbar-clock"));
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
