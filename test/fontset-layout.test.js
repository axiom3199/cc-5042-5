// FontSet (fallback + missing-glyph marking) and layoutPoster (positions
// derived from real advances, line metrics from real font metrics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, NOTO_PATH, DEJAVU_PATH } from "./helpers.js";
import { FontSet } from "../src/font/fontset.js";
import { layoutPoster } from "../src/font/layout.js";

function makeSet() {
  return new FontSet([loadFont(NOTO_PATH), loadFont(DEJAVU_PATH)]);
}

// Find a codepoint covered by DejaVu but not by Noto Sans (latin) so the
// fallback path is exercised with real coverage data.
function fallbackCodepoint(primary, fallback) {
  for (let cp = 0x20; cp < 0x3000; cp++) {
    if (primary.glyphIdFor(cp) === 0 && fallback.glyphIdFor(cp) !== 0) return cp;
  }
  throw new Error("no fallback codepoint found");
}

test("fallback glyphs are marked and keep their own font's metrics", () => {
  const set = makeSet();
  const cp = fallbackCodepoint(set.fonts[0], set.fonts[1]);
  const ch = String.fromCodePoint(cp);
  const shaped = set.shape(`A${ch}A`, { wght: 700 });
  assert.equal(shaped.fallbackCount, 1);
  const g = shaped.glyphs[1];
  assert.equal(g.fallback, true);
  assert.equal(g.missing, false);
  assert.equal(g.fontIndex, 1);
  assert.equal(g.gid, set.fonts[1].glyphIdFor(cp));
  // Advance comes from the fallback font at the same user location.
  const norm = set.fonts[1].normalize({ wght: 700 });
  assert.equal(g.advance, set.fonts[1].advance(g.gid, norm.normalized));
  // Neighboring glyphs come from the primary font.
  assert.equal(shaped.glyphs[0].fontIndex, 0);
  assert.equal(shaped.glyphs[2].fontIndex, 0);
});

test("glyphs missing from every font use .notdef and are flagged", () => {
  const set = makeSet();
  const shaped = set.shape("A🦄B", {});
  assert.equal(shaped.missingCount, 1);
  const g = shaped.glyphs[1];
  assert.equal(g.missing, true);
  assert.equal(g.gid, 0);
  assert.equal(g.fontIndex, 0, "notdef rendered from the primary font");
  assert.ok(g.advance > 0);
});

test("kerning stays within a single-font run, never across fonts", () => {
  const set = makeSet();
  const cp = fallbackCodepoint(set.fonts[0], set.fonts[1]);
  const ch = String.fromCodePoint(cp);
  // "AV" kerns in Noto; inserting a fallback glyph between A and V must
  // break the pair.
  const pair = set.shape("AV", { wght: 900 });
  const split = set.shape(`A${ch}V`, { wght: 900 });
  const aInPair = pair.glyphs[0];
  const aSplit = split.glyphs[0];
  assert.ok(aInPair.advance < aSplit.advance, "kern pair adjustment absent across font boundary");
});

test("unsupported axes are reported per font and not faked", () => {
  const set = makeSet();
  const shaped = set.shape("Hello", { wght: 700, ZZZZ: 3 });
  assert.deepEqual(shaped.unsupported, ["ZZZZ"]);
  // DejaVu has no wght axis at all: shaping a fallback run with wght set
  // must surface wght as unsupported for that font (not silently applied).
  const cp = fallbackCodepoint(set.fonts[0], set.fonts[1]);
  const shaped2 = set.shape(String.fromCodePoint(cp), { wght: 700 });
  const entry = shaped2.unsupportedByFont.find((e) => e.fontIndex === 1);
  assert.ok(entry, "fallback font reports its unsupported axes");
  assert.ok(entry.tags.includes("wght"), "DejaVu has no wght axis");
  // The fallback glyph's advance must equal DejaVu's default advance —
  // the wght setting cannot have leaked into it.
  const g = shaped2.glyphs[0];
  const defNorm = set.fonts[1].normalize({});
  assert.equal(g.advance, set.fonts[1].advance(g.gid, defNorm.normalized));
});

test("layout: pen positions accumulate real advances", () => {
  const set = makeSet();
  const layout = layoutPoster(set, "AVATAR", { wght: 900 }, { fontSize: 100, width: 2000, padding: 10 });
  const line = layout.lines[0];
  let pen = 10;
  for (const g of line.glyphs) {
    assert.ok(Math.abs(g.x - pen) < 1e-9, "glyph x == pen (no xOffset in this string)");
    pen += g.advancePx;
  }
  assert.ok(Math.abs(line.width - (pen - 10)) < 1e-9);
  // And the advances really moved vs another axis setting.
  const thin = layoutPoster(set, "AVATAR", { wght: 100 }, { fontSize: 100, width: 2000, padding: 10 });
  assert.ok(thin.lines[0].width < line.width, "heavier weight widens the line");
});

test("layout: baseline and line height derive from font metrics", () => {
  const set = makeSet();
  const layout = layoutPoster(set, "Ag\nAg", {}, { fontSize: 100, padding: 0 });
  const primary = set.fonts[0];
  const metrics = primary.metricsFor(primary.normalize({}).normalized);
  const scale = 100 / primary.unitsPerEm;
  assert.equal(layout.lines.length, 2);
  const dy = layout.lines[1].baselineY - layout.lines[0].baselineY;
  assert.ok(dy > 0, "second line sits below the first");
  const natural = (metrics.ascent - metrics.descent + metrics.lineGap) * scale;
  assert.ok(Math.abs(dy - Math.max(natural * 1.2, 105)) < 1e-9);
  // First baseline leaves room for the ascender above it.
  assert.ok(layout.lines[0].baselineY >= metrics.ascent * scale - 1e-9);
});

test("layout: letterSpacing and alignment use measured widths", () => {
  const set = makeSet();
  const noLs = layoutPoster(set, "AV", {}, { fontSize: 100, width: 1000, padding: 0 });
  const withLs = layoutPoster(set, "AV", {}, { fontSize: 100, width: 1000, padding: 0, letterSpacing: 25 });
  assert.ok(Math.abs(withLs.lines[0].width - (noLs.lines[0].width + 25)) < 1e-9);
  assert.ok(Math.abs(withLs.lines[0].glyphs[1].x - (noLs.lines[0].glyphs[1].x + 25)) < 1e-9);

  const centered = layoutPoster(set, "AV", {}, { fontSize: 100, width: 1000, padding: 0, align: "center" });
  assert.ok(Math.abs(centered.lines[0].glyphs[0].x - (1000 - centered.lines[0].width) / 2) < 1e-9);
});

test("layout: fallback glyphs scale with their own font's upm", () => {
  const set = makeSet();
  const cp = fallbackCodepoint(set.fonts[0], set.fonts[1]);
  const layout = layoutPoster(set, String.fromCodePoint(cp), {}, { fontSize: 100, padding: 0 });
  const g = layout.lines[0].glyphs[0];
  assert.equal(g.fontIndex, 1);
  assert.equal(g.scale, 100 / set.fonts[1].unitsPerEm);
  assert.equal(g.advancePx, g.advance * g.scale);
});
