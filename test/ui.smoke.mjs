// Browser smoke test: serves the workspace, drives the poster UI with
// Playwright, and verifies that axis changes really re-render glyph
// outlines (canvas pixels change), that readouts update, and that
// missing/fallback marking is visible. Run: node test/ui.smoke.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";

// This container lacks Chromium's system libraries; they were extracted
// (apt download + dpkg-deb -x) into /tmp/pwlibs. Pick them up if present.
const LOCAL_LIBS = [
  "/tmp/pwlibs/root/usr/lib/aarch64-linux-gnu",
  "/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu",
  "/tmp/pwlibs/root/lib/aarch64-linux-gnu",
  "/tmp/pwlibs/root/lib/x86_64-linux-gnu",
].filter((p) => existsSync(p));
if (LOCAL_LIBS.length) {
  process.env.LD_LIBRARY_PATH = [...LOCAL_LIBS, process.env.LD_LIBRARY_PATH ?? ""].join(":");
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function startServer() {
  // Port 0 -> OS assigns a free port; the server prints it.
  const proc = spawn(process.execPath, [join(ROOT, "tools/serve.js"), "0"], {
    stdio: "pipe",
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      const m = d.toString().match(/localhost:(\d+)/);
      if (m) resolve({ proc, port: Number(m[1]) });
    });
    proc.stderr.on("data", (d) => console.error("server:", d.toString()));
    proc.on("exit", (code) => reject(new Error(`server exited ${code}`)));
    setTimeout(() => reject(new Error("server start timeout")), 10000);
  });
}

async function canvasStats(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("poster");
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Set();
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      colors.add(key);
      if (key !== 0xfaf8f4) ink++; // not background
    }
    return { width: canvas.width, height: canvas.height, distinct: colors.size, ink };
  });
}

async function main() {
  const { proc: server, port } = await startServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("countPrimary").textContent !== "0");

    // 1. Glyphs are actually drawn (real outlines, non-trivial ink).
    const stats1 = await canvasStats(page);
    assert.ok(stats1.ink > 5000, `expected substantial ink, got ${stats1.ink}`);
    assert.ok(stats1.distinct > 2, "expected more than background+one color");

    // 2. Axis sliders exist, built from fvar (wght + wdth for Noto).
    const sliders = await page.locator("#axes .axis").count();
    assert.equal(sliders, 2, "Noto wdth,wght axes -> 2 sliders");

    // 3. Moving wght to an endpoint changes the rendered pixels, the
    //    applied-coordinates readout AND the measured line extent.
    const readLayout = () =>
      page.evaluate(() => {
        const l = globalThis.__posterState?.layout;
        return l
          ? {
              width: l.lines.map((line) => line.width),
              normalized: { ...l.shaped.normalized },
              advances: l.lines.flatMap((line) => line.glyphs.map((g) => g.advance)),
            }
          : null;
      });
    const wghtSlider = page.locator("#axes .axis").nth(0).locator(".axis-slider");
    const tag0 = await page.locator("#axes .axis").nth(0).locator(".axis-tag").textContent();
    const coordBefore = await page.locator("#coordTable tbody").textContent();
    const layout1 = await readLayout();
    await wghtSlider.fill(tag0.includes("wght") ? "900" : "62.5");
    await page.waitForTimeout(200);
    const stats2 = await canvasStats(page);
    const coordAfter = await page.locator("#coordTable tbody").textContent();
    const layout2 = await readLayout();
    assert.notEqual(coordBefore, coordAfter, "applied coords readout must follow the slider");
    assert.ok(
      Math.abs(stats2.ink - stats1.ink) > 100,
      `axis change must re-render outlines (ink ${stats1.ink} -> ${stats2.ink})`
    );
    assert.ok(layout1 && layout2, "layout is inspectable");
    assert.notDeepEqual(layout2.width, layout1.width, "axis change moves layout extents");
    assert.notDeepEqual(layout2.advances, layout1.advances, "axis change moves advances");

    // 4. Both axis extremes produce different ink than default.
    const wghtSlider2 = page.locator("#axes .axis").nth(0).locator(".axis-slider");
    await wghtSlider2.fill(tag0.includes("wght") ? "100" : "100");
    await page.waitForTimeout(200);
    const stats3 = await canvasStats(page);
    const layout3 = await readLayout();
    assert.ok(Math.abs(stats3.ink - stats2.ink) > 100, "opposite endpoint differs again");
    assert.notDeepEqual(layout3.advances, layout2.advances, "opposite endpoint moves advances");

    // 4b. Multi-axis coupling: the second axis also changes glyph shape and
    //     the layout readout, not just a uniform scale.
    const secondSlider = page.locator("#axes .axis").nth(1).locator(".axis-slider");
    const secondTag = await page.locator("#axes .axis").nth(1).locator(".axis-tag").textContent();
    const coords2Before = await page.locator("#coordTable tbody").textContent();
    await secondSlider.fill(secondTag.includes("wdth") ? "62.5" : "900");
    await page.waitForTimeout(200);
    const stats4 = await canvasStats(page);
    const coords2After = await page.locator("#coordTable tbody").textContent();
    const layout4 = await readLayout();
    assert.notEqual(coords2Before, coords2After, "second axis readout follows its slider");
    assert.ok(Math.abs(stats4.ink - stats3.ink) > 100, "second axis re-renders outlines");
    assert.notDeepEqual(layout4.width, layout3.width, "second axis moves layout extents");

    // 4c. Editing text after moving both axes still re-renders shape + layout.
    const textArea = page.locator("#text");
    const firstLineWidthBefore = layout4.width[0];
    await textArea.fill("VVVV");
    await page.waitForTimeout(250);
    const stats5 = await canvasStats(page);
    const layout5 = await readLayout();
    assert.ok(Math.abs(stats5.ink - stats4.ink) > 100, "text edit re-renders at the current axes");
    assert.notEqual(layout5.width[0], firstLineWidthBefore, "text edit changes measured layout width");
    assert.notDeepEqual(layout5.advances, layout4.advances, "text edit changes advanced glyphs");
    // The axis location survives the text edit (shape cache key includes text).
    assert.deepEqual(layout5.normalized, layout4.normalized, "axes stay applied after text edit");

    // 4d. Invalid axis input is reported visibly instead of silently applied.
    const wghtNum = page.locator("#axes .axis").nth(0).locator(".axis-value");
    await wghtNum.fill("5000");
    await wghtNum.dispatchEvent("change");
    await page.waitForTimeout(200);
    const warnings = await page.locator("#unsupported").textContent();
    assert.ok(warnings.includes("超出范围"), `out-of-range warning shown: ${warnings}`);
    const coords5 = await page.locator("#coordTable tbody").textContent();
    assert.ok(coords5.includes("900") || coords5.includes("62.5"), "clamped value is what was applied");

    // Restore default text for the remaining checks.
    await textArea.fill("AVATAR é ♥🦄\nTo oooo AVA");
    await page.waitForTimeout(250);

    // 5. Missing and fallback glyphs are counted and marked.
    const missing = Number(await page.locator("#countMissing").textContent());
    const fallback = Number(await page.locator("#countFallback").textContent());
    assert.ok(missing >= 1, "default text contains a missing glyph");
    assert.ok(fallback >= 1, "default text contains a fallback glyph");

    // 6. Glyph inspector: click the first glyph's ink and read its data.
    const hit = await page.evaluate(() => {
      const canvas = document.getElementById("poster");
      const ctx = canvas.getContext("2d");
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const i = (y * canvas.width + x) * 4;
          if (data[i] === 0x18 && data[i + 1] === 0x22 && data[i + 2] === 0x33) {
            return { x: x / dpr, y: y / dpr };
          }
        }
      }
      return null;
    });
    assert.ok(hit, "found a primary-ink pixel to click");
    const box = await page.locator("#poster").boundingBox();
    await page.mouse.click(box.x + hit.x, box.y + hit.y);
    await page.waitForTimeout(100);
    const inspector = await page.locator("#inspector").textContent();
    assert.ok(inspector.includes("glyph id"), "inspector shows glyph id");
    assert.ok(inspector.includes("前进量"), "inspector shows advance");

    // 7. No page errors throughout.
    assert.deepEqual(errors, [], "no console/page errors");
    console.log("ui smoke test: all assertions passed");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
