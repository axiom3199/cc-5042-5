// Axis definitions, normalization, clamping, and avar mapping — checked
// against fontTools' models.normalizeLocation + piecewiseLinearMap output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, loadReference, NOTO_PATH, TEST_PATH } from "./helpers.js";

const FONTS = { noto: NOTO_PATH, test: TEST_PATH };

for (const key of ["noto", "test"]) {
  const ref = loadReference(key);
  const font = loadFont(FONTS[key]);

  test(`${key}: fvar axes parsed from font (labels, ranges, defaults)`, () => {
    assert.equal(font.axes.length, ref.meta.axes.length);
    for (let i = 0; i < ref.meta.axes.length; i++) {
      const r = ref.meta.axes[i];
      const a = font.axes[i];
      assert.equal(a.tag, r.tag);
      assert.equal(a.min, r.min);
      assert.equal(a.default, r.default);
      assert.equal(a.max, r.max);
      assert.equal(a.nameID, r.nameID);
      assert.equal(a.name, r.name, `axis ${r.tag} label from name table`);
    }
  });

  test(`${key}: named instances parsed`, () => {
    assert.equal(font.instances.length, ref.meta.instances.length);
    for (let i = 0; i < ref.meta.instances.length; i++) {
      assert.equal(font.instances[i].name, ref.meta.instances[i].name);
      for (const [tag, v] of Object.entries(ref.meta.instances[i].coords)) {
        assert.ok(Math.abs(font.instances[i].coords[tag] - v) < 1e-6, `instance ${i} ${tag}`);
      }
    }
  });

  test(`${key}: unitsPerEm / hhea / numGlyphs`, () => {
    assert.equal(font.unitsPerEm, ref.meta.upm);
    assert.equal(font.numGlyphs, ref.meta.numGlyphs);
    assert.equal(font.hhea.ascent, ref.meta.hhea.ascent);
    assert.equal(font.hhea.descent, ref.meta.hhea.descent);
    assert.equal(font.hhea.lineGap, ref.meta.hhea.lineGap);
  });

  test(`${key}: normalization incl. clamping and avar matches fontTools`, () => {
    for (const entry of ref.normalize) {
      const { clamped, normalized } = font.normalize(entry.user);
      for (const [tag, v] of Object.entries(entry.clamped)) {
        assert.ok(Math.abs(clamped[tag] - v) < 1e-6,
          `${key} clamp ${tag} @ ${JSON.stringify(entry.user)}: ${clamped[tag]} vs ${v}`);
      }
      for (const [tag, v] of Object.entries(entry.normalized)) {
        assert.ok(Math.abs(normalized[tag] - v) < 1e-5,
          `${key} normalize ${tag} @ ${JSON.stringify(entry.user)}: ${normalized[tag]} vs ${v}`);
      }
    }
  });
}

test("abnormal axis values fall back or clamp, never produce NaN", () => {
  const font = loadFont(NOTO_PATH);
  for (const bad of [NaN, undefined, null, "bold", {}, Infinity, -Infinity, 1e300]) {
    const { clamped, normalized } = font.normalize({ wght: bad, wdth: bad });
    for (const axis of font.axes) {
      assert.ok(Number.isFinite(clamped[axis.tag]), `clamped finite for ${String(bad)}`);
      assert.ok(clamped[axis.tag] >= axis.min && clamped[axis.tag] <= axis.max,
        `clamped in range for ${String(bad)}`);
      assert.ok(Number.isFinite(normalized[axis.tag]), `normalized finite for ${String(bad)}`);
      assert.ok(normalized[axis.tag] >= -1 && normalized[axis.tag] <= 1);
    }
  }
  // Non-finite strings/NaN -> default; Infinity clamps to the endpoint.
  assert.equal(font.normalize({ wght: "x" }).clamped.wght, 400);
  assert.equal(font.normalize({ wght: Infinity }).clamped.wght, 900);
  assert.equal(font.normalize({ wght: -Infinity }).clamped.wght, 100);
});

test("unsupported axes are reported, not silently applied", () => {
  const font = loadFont(NOTO_PATH);
  const r = font.normalize({ wght: 700, XXXX: 1, ital: 12 });
  assert.deepEqual([...r.unsupported].sort(), ["XXXX", "ital"]);
  assert.equal(r.clamped.wght, 700);
  // Unsupported axis must not leak into normalized coords.
  assert.ok(!("XXXX" in r.normalized));
  assert.ok(!("ital" in r.normalized));
});
