// End-to-end evidence for the old poster path: load a legacy saved state,
// migrate it through compat.js, and run it through the refactored engine to
// completion — outlines, advances, layout extents, missing and fallback
// glyphs all present. This is the "old sample still runs" check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadFont, NOTO_PATH, DEJAVU_PATH } from "./helpers.js";
import { FontSet } from "../src/font/fontset.js";
import { shapeText, placeLines } from "../src/font/layout.js";
import { readLegacyPosterState, layoutLegacyPoster } from "../src/font/compat.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const legacy = JSON.parse(readFileSync(join(ROOT, "test/fixtures/legacy-poster.json"), "utf8"));

function makeSet() {
  return new FontSet([loadFont(NOTO_PATH), loadFont(DEJAVU_PATH)]);
}

test("old poster runs to completion through the refactored pipeline", () => {
  const state = readLegacyPosterState(legacy);
  assert.equal(state.location.wght, 900);
  assert.equal(state.location.wdth, 62.5);

  const set = makeSet();
  const { shapedLines, shaped, metrics } = shapeText(set, state.text, state.location);
  const layout = placeLines(set, shapedLines, shaped, metrics, state.options);

  // Two paragraphs -> two lines, all glyphs placed.
  assert.equal(layout.lines.length, 2);
  const glyphs = layout.lines.flatMap((l) => l.glyphs);
  assert.ok(glyphs.length > 0);
  assert.equal(glyphs.length, shaped.glyphs.length);

  // Missing + fallback survive migration and axis evaluation.
  assert.ok(shaped.missingCount >= 1, "unicorn stays missing");
  assert.ok(shaped.fallbackCount >= 1, "heart renders from the fallback font");
  const missing = glyphs.filter((g) => g.missing);
  const fallback = glyphs.filter((g) => g.fallback);
  assert.ok(missing.every((g) => g.gid === 0 && g.fontIndex === 0));
  assert.ok(fallback.every((g) => g.fontIndex === 1 && !g.missing));

  // Layout extent equals the sum of real placed advances.
  for (const line of layout.lines) {
    const sum = line.glyphs.reduce((a, g) => a + g.advancePx, 0);
    assert.ok(Math.abs(line.width - sum) < 1e-9, "line width is the placed advance sum");
    assert.ok(line.width > 0);
  }

  // Outlines for every rendered glyph are available at the applied location.
  for (const g of glyphs) {
    const font = set.fonts[g.fontIndex];
    const outline = font.getOutline(g.gid, g.normalized);
    assert.ok(outline.contours.length >= 0);
    assert.ok(Number.isFinite(outline.bbox.xMin));
  }
});

test("old poster legacy entry equals migrated current entry", () => {
  const set = makeSet();
  const state = readLegacyPosterState(legacy);
  const a = layoutLegacyPoster(set, state.text, legacy.axes, state.options);
  const b = layoutLegacyPoster(set, state.text, state.location, state.options);
  assert.equal(a.lines.length, b.lines.length);
  for (let i = 0; i < a.lines.length; i++) {
    assert.equal(a.lines[i].width, b.lines[i].width);
    assert.deepEqual(
      a.lines[i].glyphs.map((g) => [g.gid, g.fontIndex, g.x, g.advance]),
      b.lines[i].glyphs.map((g) => [g.gid, g.fontIndex, g.x, g.advance])
    );
  }
});

test("old poster axis change produces different outlines and extents", () => {
  const set = makeSet();
  const state = readLegacyPosterState(legacy);
  const heavy = layoutLegacyPoster(set, state.text, state.location, state.options);
  const light = layoutLegacyPoster(set, state.text, { wght: "100", wdth: "100" }, state.options);
  assert.notEqual(heavy.lines[0].width, light.lines[0].width);

  const gh = heavy.lines[0].glyphs[0];
  const gl = light.lines[0].glyphs[0];
  const oh = set.fonts[0].getOutline(gh.gid, gh.normalized);
  const ol = set.fonts[0].getOutline(gl.gid, gl.normalized);
  assert.notDeepEqual(
    oh.contours.map((c) => c.map((p) => [p.x.toFixed(2), p.y.toFixed(2)])),
    ol.contours.map((c) => c.map((p) => [p.x.toFixed(2), p.y.toFixed(2)]))
  );
});
