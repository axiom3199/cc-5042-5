// Outline interpolation (gvar + IUP + composites) and advances (HVAR /
// phantom-derived) checked against fontTools varLib.instancer output.
// fontTools rounds glyph coordinates to integers; the engine keeps floats,
// so coordinates are compared with a 0.6 tolerance. Advances must match
// exactly (both pipelines otRound).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, loadReference, NOTO_PATH, TEST_PATH, approxEqual } from "./helpers.js";

const FONTS = { noto: NOTO_PATH, test: TEST_PATH };
const COORD_TOL = 0.6;

for (const key of ["noto", "test"]) {
  const ref = loadReference(key);
  const font = loadFont(FONTS[key]);

  test(`${key}: cmap maps codepoints to the reference glyph ids`, () => {
    for (const [ch, gid] of Object.entries(ref.meta.glyphIds)) {
      assert.equal(font.glyphIdFor(ch.codePointAt(0)), gid, `U+${ch.codePointAt(0).toString(16)}`);
    }
  });

  test(`${key}: unmapped codepoints resolve to gid 0`, () => {
    assert.equal(font.glyphIdFor(0x10FFFE), 0);
    assert.equal(font.glyphIdFor(0xE000), 0); // private use, unassigned in both fonts
  });

  for (const entry of ref.outlines) {
    const loc = JSON.stringify(entry.location);
    const { normalized } = font.normalize(entry.location);

    test(`${key}: outlines @ ${loc}`, () => {
      for (const [ch, g] of Object.entries(entry.glyphs)) {
        const outline = font.getOutline(g.gid, normalized);
        assert.equal(outline.contours.length, g.contours.length, `${key} ${JSON.stringify(ch)} contour count @ ${loc}`);
        for (let c = 0; c < g.contours.length; c++) {
          const mine = outline.contours[c];
          const theirs = g.contours[c];
          assert.equal(mine.length, theirs.length, `${key} ${JSON.stringify(ch)} contour ${c} point count @ ${loc}`);
          for (let p = 0; p < theirs.length; p++) {
            assert.equal(mine[p].onCurve, theirs[p].onCurve,
              `${key} ${JSON.stringify(ch)} contour ${c} point ${p} onCurve @ ${loc}`);
            approxEqual(mine[p].x, theirs[p].x, COORD_TOL,
              `${key} ${JSON.stringify(ch)} c${c}p${p} x @ ${loc}`);
            approxEqual(mine[p].y, theirs[p].y, COORD_TOL,
              `${key} ${JSON.stringify(ch)} c${c}p${p} y @ ${loc}`);
          }
        }
        approxEqual(outline.bbox.xMin, g.bbox.xMin, COORD_TOL, `${key} ${JSON.stringify(ch)} bbox.xMin @ ${loc}`);
        approxEqual(outline.bbox.yMin, g.bbox.yMin, COORD_TOL, `${key} ${JSON.stringify(ch)} bbox.yMin @ ${loc}`);
        approxEqual(outline.bbox.xMax, g.bbox.xMax, COORD_TOL, `${key} ${JSON.stringify(ch)} bbox.xMax @ ${loc}`);
        approxEqual(outline.bbox.yMax, g.bbox.yMax, COORD_TOL, `${key} ${JSON.stringify(ch)} bbox.yMax @ ${loc}`);
      }
    });

    test(`${key}: advances @ ${loc}`, () => {
      for (const g of Object.values(entry.glyphs)) {
        assert.equal(font.advance(g.gid, normalized), g.advance,
          `${key} gid ${g.gid} advance @ ${loc}`);
      }
    });
  }
}

test("test: intermediate gvar region is inactive outside its range", () => {
  const font = loadFont(TEST_PATH);
  // The intermediate tuple spans wght (0.2, 0.5, 0.8) post-avar. At the
  // default location its scalar must be exactly 0 (no x-shift).
  const def = font.normalize({});
  const gid = font.glyphIdFor(0x41); // A
  const atDefault = font.getOutline(gid, def.normalized);
  assert.equal(atDefault.contours[0][0].x, 20);
  // wght=500 maps through avar to 0.1 — still below the region, no shift.
  const below = font.normalize({ wght: 500 });
  assert.equal(font.getOutline(gid, below.normalized).contours[0][0].x, 20);
  // wght=733 maps through avar to ~0.5, the region peak: full +50 shift.
  const mid = font.normalize({ wght: 733 });
  const atMid = font.getOutline(gid, mid.normalized);
  assert.ok(atMid.contours[0][0].x > 60, "intermediate tuple shifts apex inside its region");
});

test("test: composite glyph inherits component variations and own deltas", () => {
  const font = loadFont(TEST_PATH);
  const gidA = font.glyphIdFor(0x41);
  const gidAcute = font.glyphIdFor(0xb4);
  const gidAacute = font.glyphIdFor(0xc1);
  const { normalized } = font.normalize({ wght: 900 });
  const a = font.getOutline(gidA, normalized);
  const aacute = font.getOutline(gidAacute, normalized);
  assert.ok(aacute.composite, "Aacute resolves as composite");
  // Aacute advance gets its own phantom delta (+60 at wght max), not A's +50.
  assert.equal(font.advance(gidAacute, normalized), 600 + 60);
  assert.equal(font.advance(gidA, normalized), 600 + 50);
  // First contour of Aacute == A's contour (component 1 has zero offset).
  assert.equal(aacute.contours[0].length, a.contours[0].length);
  approxEqual(aacute.contours[0][0].x, a.contours[0][0].x, 1e-9, "composite inherits varied A outline");
  // Acute component offset varied by gvar: default (220, -100) + (0, 30) at wght max.
  const acuteDefault = font.getOutline(gidAcute, font.normalize({}).normalized);
  approxEqual(aacute.contours[1][0].x - acuteDefault.contours[0][0].x, 220, 1e-9, "acute x offset");
  approxEqual(aacute.contours[1][0].y - acuteDefault.contours[0][0].y, -100 + 30, 1e-9, "acute y offset varied");
});

test("test: repeated characters share identical outlines and advances", () => {
  const font = loadFont(TEST_PATH);
  const { normalized } = font.normalize({ wght: 733, wdth: 88 });
  const gid = font.glyphIdFor(0x41);
  const o1 = font.getOutline(gid, normalized);
  const o2 = font.getOutline(gid, normalized);
  assert.equal(o1, o2, "outline cache returns the same object");
  assert.equal(font.advance(gid, normalized), font.advance(gid, normalized));
});
