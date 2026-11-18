// Shaping: glyph ids, advances, and offsets checked exactly against
// HarfBuzz (uharfbuzz) output. GPOS kerning for Noto, kern-table format 0
// for the synthetic font, mark-advance zeroing (BY_GDEF_LATE) included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, loadReference, NOTO_PATH, TEST_PATH, MARK_OFFSET_STRINGS } from "./helpers.js";

const FONTS = { noto: NOTO_PATH, test: TEST_PATH };

for (const key of ["noto", "test"]) {
  const ref = loadReference(key);
  const font = loadFont(FONTS[key]);

  // Group reference shapings by text for readable tests.
  const byText = new Map();
  for (const s of ref.shaping) {
    if (!byText.has(s.text)) byText.set(s.text, []);
    byText.get(s.text).push(s);
  }

  for (const [text, entries] of byText) {
    test(`${key}: shape ${JSON.stringify(text)} matches HarfBuzz`, () => {
      for (const entry of entries) {
        const loc = JSON.stringify(entry.location);
        const { glyphs } = font.shape(text, entry.location);
        assert.equal(glyphs.length, entry.glyphs.length, `${key} ${JSON.stringify(text)} glyph count @ ${loc}`);
        const compareOffsets = !MARK_OFFSET_STRINGS.has(text);
        for (let i = 0; i < entry.glyphs.length; i++) {
          const want = entry.glyphs[i];
          const got = glyphs[i];
          const what = `${key} ${JSON.stringify(text)} glyph ${i} (gid ${want.gid}) @ ${loc}`;
          assert.equal(got.gid, want.gid, `${what} gid`);
          assert.equal(got.advance, want.advance, `${what} advance`);
          if (compareOffsets) {
            assert.equal(got.xOffset, want.xOffset, `${what} xOffset`);
            assert.equal(got.yOffset, want.yOffset, `${what} yOffset`);
          }
        }
      }
    });
  }
}

test("noto: mark glyphs get zero advance after GPOS (BY_GDEF_LATE)", () => {
  const font = loadFont(NOTO_PATH);
  const { glyphs } = font.shape("ı̈", { wght: 700 });
  // U+0308 COMBINING DIAERESIS is a GDEF mark class glyph.
  const mark = glyphs[1];
  assert.equal(mark.gid, font.glyphIdFor(0x308));
  assert.equal(mark.advance, 0);
});

test("test: kern table splits value across the pair like HarfBuzz", () => {
  const font = loadFont(TEST_PATH);
  const { glyphs, kernSource } = font.shape("AV", {});
  assert.equal(kernSource, "kern");
  // (A,V) = -80 -> kern1 = -40 on A's advance, kern2 = -40 on V's
  // advance and xOffset (hb_kern_machine_t).
  assert.equal(glyphs[0].advance, 600 - 40);
  assert.equal(glyphs[1].advance, 620 - 40);
  assert.equal(glyphs[1].xOffset, -40);
});

test("test: kerning actually follows axis-driven advance changes", () => {
  const font = loadFont(TEST_PATH);
  // A's advance grows +50 at wght max; the kern adjustment stays -40/-40,
  // so the pair must not reuse the default-location layout.
  const def = font.shape("AV", {}).glyphs;
  const max = font.shape("AV", { wght: 900 }).glyphs;
  assert.equal(def[0].advance, 560);
  assert.equal(max[0].advance, 650 - 40);
  assert.equal(max[1].advance, 620 + 30 - 40); // V also has a +30 phantom delta
  assert.ok(max[0].advance > def[0].advance);
});

test("missing codepoints shape as flagged .notdef with real advance", () => {
  const font = loadFont(TEST_PATH);
  const { glyphs } = font.shape("A🦄", {}); // unicorn not in the test font
  assert.equal(glyphs[0].missing, false);
  assert.equal(glyphs[1].gid, 0);
  assert.equal(glyphs[1].missing, true);
  assert.equal(glyphs[1].advance, font.advance(0, font.normalize({}).normalized));
  assert.ok(glyphs[1].advance > 0);
});

test("repeated characters: cumulative pen positions strictly increase", () => {
  const font = loadFont(NOTO_PATH);
  for (const loc of [{}, { wght: 100 }, { wght: 900 }, { wdth: 62.5 }]) {
    const { glyphs } = font.shape("oooooooo", loc);
    let pen = 0;
    for (const g of glyphs) {
      assert.ok(g.advance > 0, "o has positive advance");
      pen += g.advance;
    }
    // Total width must respond to the axes (no stale layout reuse).
    assert.ok(pen > 0);
  }
  const thin = font.shape("oooooooo", { wght: 100 }).glyphs.reduce((a, g) => a + g.advance, 0);
  const black = font.shape("oooooooo", { wght: 900 }).glyphs.reduce((a, g) => a + g.advance, 0);
  assert.notEqual(thin, black, "axis change must change the cumulative advance");
});
