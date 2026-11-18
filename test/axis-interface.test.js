// Axis interface contract: one shared range validation used by every entry
// point, explicit (not silent) handling of bad values, and evidence that
// axis changes are real axis evaluation rather than uniform scaling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, NOTO_PATH, TEST_PATH, DEJAVU_PATH } from "./helpers.js";
import { FontSet } from "../src/font/fontset.js";
import { layoutPoster, shapeText, placeLines } from "../src/font/layout.js";
import { AxisSpace } from "../src/font/axes.js";

test("axis interface: Font.normalize and AxisSpace.resolve agree", () => {
  const font = loadFont(NOTO_PATH);
  const samples = [
    {},
    { wght: 700 },
    { wght: 50, wdth: 200 }, // both out of range
    { wght: NaN, wdth: "x" },
    { wght: Infinity, wdth: -Infinity },
    { wght: 333.3, wdth: 75.7, XXXX: 5 },
  ];
  for (const sample of samples) {
    const a = font.normalize(sample);
    const b = font.axisSpace.resolve(sample);
    assert.deepEqual(a.clamped, b.clamped);
    assert.deepEqual(a.normalized, b.normalized);
    assert.deepEqual(a.unsupported, b.unsupported);
    assert.deepEqual(a.invalid, b.invalid);
    assert.deepEqual(a.adjusted, b.adjusted);
  }
});

test("axis interface: range validation is shared by shape and layout", () => {
  const font = loadFont(NOTO_PATH);
  const set = new FontSet([font]);
  const loc = { wght: 12345, wdth: -50 };
  const direct = font.normalize(loc);
  const shaped = set.shape("AV", loc);
  const layout = layoutPoster(set, "AV", loc, { fontSize: 100 });
  for (const entry of [shaped, layout.shaped]) {
    assert.deepEqual(entry.clamped, direct.clamped, "same clamped values everywhere");
    assert.deepEqual(entry.normalized, direct.normalized, "same normalized values everywhere");
    assert.deepEqual(entry.adjusted.map((e) => e.tag).sort(), ["wdth", "wght"]);
    assert.deepEqual(entry.unsupported, []);
  }
  // The UI copy comes from the same resolution record.
  assert.equal(shaped.adjusted.length, 2);
});

test("axis interface: bad values are reported, never silently defaulted", () => {
  const font = loadFont(NOTO_PATH);
  const r = font.normalize({ wght: "bold", wdth: NaN, XXXX: 1 });
  assert.deepEqual(r.unsupported, ["XXXX"]);
  const reasons = Object.fromEntries(r.invalid.map((e) => [e.tag, e.reason]));
  assert.equal(reasons.wght, "not-a-number");
  assert.equal(reasons.wdth, "nan");
  // Applied values are still finite defaults, but they are flagged.
  assert.equal(r.clamped.wght, 400);
  assert.equal(r.clamped.wdth, 100);
  // A clamped-but-finite value is reported separately from invalid input.
  const c = font.normalize({ wght: 5000 });
  assert.deepEqual(c.invalid, []);
  assert.deepEqual(c.adjusted, [{ tag: "wght", raw: 5000, reason: "out-of-range", applied: 900 }]);
});

test("axis interface: Font.shape and FontSet.shape report the same diagnostics", () => {
  const font = loadFont(NOTO_PATH);
  const set = new FontSet([font]);
  const loc = { wght: 900, ZZZZ: 4 };
  const a = font.shape("AV", loc);
  const b = set.shape("AV", loc);
  assert.deepEqual(a.unsupported, b.unsupported);
  assert.deepEqual(a.clamped, b.clamped);
  assert.deepEqual(a.normalized, b.normalized);
  assert.deepEqual(b.invalid, []);
});

test("axis interface: AxisSpace alone can validate without shaping", () => {
  const font = loadFont(NOTO_PATH);
  const space = font.axisSpace;
  assert.ok(space instanceof AxisSpace);
  assert.equal(space.hasAxis("wght"), true);
  assert.equal(space.hasAxis("ital"), false);
  assert.equal(space.validateValue("wght", 50).reason, "out-of-range");
  assert.equal(space.validateValue("ital", 1).reason, "unsupported-axis");
  // Default values are visible to callers (controls initialise from here).
  for (const axis of space.axes) {
    assert.equal(space.validateValue(axis.tag, undefined).value, axis.default);
  }
});

test("multi-axis coupling: wdth+wght change outline shape, not a uniform scale", () => {
  const font = loadFont(NOTO_PATH);
  const gidA = font.glyphIdFor(0x41);
  const gidO = font.glyphIdFor(0x6f);
  const at = (loc) => font.normalize(loc).normalized;

  const defaultA = font.getOutline(gidA, at({ wght: 400, wdth: 100 }));
  const narrowBlackA = font.getOutline(gidA, at({ wght: 900, wdth: 62.5 }));
  const defaultO = font.getOutline(gidO, at({ wght: 400, wdth: 100 }));
  const narrowBlackO = font.getOutline(gidO, at({ wght: 900, wdth: 62.5 }));

  const width = (o) => o.bbox.xMax - o.bbox.xMin;
  const height = (o) => o.bbox.yMax - o.bbox.yMin;

  // Two different glyphs must not scale by the same factor; a global
  // transform could not produce different ratios for A and o.
  const ratioA = width(narrowBlackA) / width(defaultA);
  const ratioO = width(narrowBlackO) / width(defaultO);
  assert.notEqual(ratioA.toFixed(4), ratioO.toFixed(4));
  // Height and width respond independently (condensing is not scaling).
  assert.notEqual(
    (height(narrowBlackA) / height(defaultA)).toFixed(4),
    ratioA.toFixed(4)
  );

  // Point counts are identical (same outline topology), coordinates differ.
  assert.equal(defaultA.contours[0].length, narrowBlackA.contours[0].length);
  let moved = 0;
  for (let i = 0; i < defaultA.contours[0].length; i++) {
    const p = defaultA.contours[0][i];
    const q = narrowBlackA.contours[0][i];
    if (Math.abs(p.x - q.x) > 0.01 || Math.abs(p.y - q.y) > 0.01) moved++;
  }
  assert.ok(moved > 0, "axis evaluation moved outline points");
});

test("multi-axis coupling: layout extents differ per axis and glyph mix", () => {
  const set = new FontSet([loadFont(NOTO_PATH)]);
  const texts = ["AV", "Ao", "oo"];
  const locations = [
    { wght: 400, wdth: 100 },
    { wght: 900, wdth: 100 },
    { wght: 400, wdth: 62.5 },
    { wght: 900, wdth: 62.5 },
  ];
  const widths = new Map();
  for (const text of texts) {
    const row = locations.map((loc) => {
      const layout = layoutPoster(set, text, loc, { fontSize: 100, padding: 0 });
      return layout.lines[0].width;
    });
    // Every sampled location gives a distinct line width for these strings.
    assert.equal(new Set(row.map((w) => w.toFixed(3))).size, row.length,
      `${text} widths at ${JSON.stringify(locations)}: ${row.join(", ")}`);
    widths.set(text, row);
  }
  // Weight and width act in the same direction on advances, but the layout
  // responds to both; the combined corner is not equal to either single axis.
  const [def, bold, narrow, narrowBold] = widths.get("AV");
  assert.ok(bold > def, "bolder is wider");
  assert.ok(narrow < def, "narrower is tighter");
  assert.notEqual(narrowBold.toFixed(3), narrow.toFixed(3));
  assert.notEqual(narrowBold.toFixed(3), bold.toFixed(3));
});

test("missing and fallback glyphs are distinguishable under axis changes", () => {
  const set = new FontSet([loadFont(NOTO_PATH), loadFont(DEJAVU_PATH)]);
  // ♥ exists only in the fallback; 🦄 exists in neither.
  const shaped = set.shape("A♥🦄", { wght: 900, wdth: 62.5 });
  assert.equal(shaped.fallbackCount, 1);
  assert.equal(shaped.missingCount, 1);
  const [a, heart, unicorn] = shaped.glyphs;
  assert.equal(a.fontIndex, 0);
  assert.equal(heart.fontIndex, 1);
  assert.equal(heart.fallback, true);
  assert.equal(heart.missing, false);
  assert.equal(unicorn.missing, true);
  assert.equal(unicorn.gid, 0);
  // Fallback font has no variable axes, so its advance must equal the
  // default-location advance despite the wght/wdth request.
  const dejavu = set.fonts[1];
  assert.equal(heart.advance, dejavu.advance(heart.gid, dejavu.normalize({}).normalized));
  // .notdef still varies with the primary font's axes.
  const def = set.shape("A🦄", {}).glyphs[1].advance;
  const varied = shaped.glyphs[2].advance;
  assert.notEqual(def, varied, "primary .notdef advance follows the axes");
});

test("layout stages are separable: same shaping reused with different placement", () => {
  const set = new FontSet([loadFont(NOTO_PATH)]);
  const { shapedLines, shaped, metrics } = shapeText(set, "AV", { wght: 700 });
  const a = layoutPoster(set, "AV", { wght: 700 }, { fontSize: 100, padding: 10 });
  // shapeText does the axis-dependent work; placement only consumes it.
  assert.deepEqual(shaped.normalized, a.shaped.normalized);
  assert.deepEqual(metrics, a.metrics);
  // The same shape object can be placed twice with different options.
  const p1 = placeLines(set, shapedLines, shaped, metrics, { fontSize: 100, padding: 10 });
  const p2 = placeLines(set, shapedLines, shaped, metrics, { fontSize: 200, padding: 10 });
  assert.equal(p1.lines[0].width * 2, p2.lines[0].width);
  assert.deepEqual(
    p1.lines[0].glyphs.map((g) => g.gid),
    p2.lines[0].glyphs.map((g) => g.gid)
  );
});
