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

    // 3. Moving wght to an endpoint changes the rendered pixels AND the
    //    applied-coordinates readout.
    const wghtSlider = page.locator("#axes .axis").nth(0).locator(".axis-slider");
    const tag0 = await page.locator("#axes .axis").nth(0).locator(".axis-tag").textContent();
    const coordBefore = await page.locator("#coordTable tbody").textContent();
    await wghtSlider.fill(tag0.includes("wght") ? "900" : "62.5");
    await page.waitForTimeout(200);
    const stats2 = await canvasStats(page);
    const coordAfter = await page.locator("#coordTable tbody").textContent();
    assert.notEqual(coordBefore, coordAfter, "applied coords readout must follow the slider");
    assert.ok(
      Math.abs(stats2.ink - stats1.ink) > 100,
      `axis change must re-render outlines (ink ${stats1.ink} -> ${stats2.ink})`
    );

    // 4. Both axis extremes produce different ink than default.
    const wghtSlider2 = page.locator("#axes .axis").nth(0).locator(".axis-slider");
    await wghtSlider2.fill(tag0.includes("wght") ? "100" : "100");
    await page.waitForTimeout(200);
    const stats3 = await canvasStats(page);
    assert.ok(Math.abs(stats3.ink - stats2.ink) > 100, "opposite endpoint differs again");

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
