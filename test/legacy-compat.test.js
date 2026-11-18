// Legacy variable-font compatibility: old posters/states and the old
// combined axis-layout entry must keep working, through the shared axis
// validation rather than a parallel implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, loadReference, NOTO_PATH, TEST_PATH } from "./helpers.js";
import { FontSet } from "../src/font/fontset.js";
import { layoutPoster } from "../src/font/layout.js";
import {
  migrateLegacyLocation,
  readLegacyPosterState,
  layoutLegacyPoster,
  normalizeLegacyLocation,
} from "../src/font/compat.js";

test("legacy location migration accepts numeric strings and nested keys", () => {
  assert.deepEqual(migrateLegacyLocation({ wght: "700", wdth: 80 }), { wght: 700, wdth: 80 });
  assert.deepEqual(migrateLegacyLocation({ axes: { wght: "550" } }), { wght: 550 });
  assert.deepEqual(migrateLegacyLocation({ variations: { wdth: 62.5 } }), { wdth: 62.5 });
  assert.deepEqual(migrateLegacyLocation({ location: { wght: 400 } }), { wght: 400 });
  // Non-numeric strings pass through so the strict pipeline can flag them.
  assert.deepEqual(migrateLegacyLocation({ wght: "bold" }), { wght: "bold" });
  assert.deepEqual(migrateLegacyLocation(null), {});
});

test("old poster state reads text/axes/options and ignores the rest", () => {
  const state = readLegacyPosterState({
    text: "旧海报",
    axes: { wght: "900", wdth: "62.5" },
    fontSize: 88,
    lineHeightFactor: 1.4,
    letterSpacing: 3,
    align: "center",
    unknownField: { should: "not leak" },
  });
  assert.equal(state.text, "旧海报");
  assert.deepEqual(state.location, { wght: 900, wdth: 62.5 });
  assert.equal(state.options.fontSize, 88);
  assert.equal(state.options.align, "center");
  assert.ok(!("unknownField" in state.options));
});

test("old combined entry matches the current entry for equal locations", () => {
  const set = new FontSet([loadFont(NOTO_PATH)]);
  const modern = layoutPoster(set, "AVATAR", { wght: 550, wdth: 80 }, { fontSize: 120 });
  const legacy = layoutLegacyPoster(set, "AVATAR", { wght: "550", wdth: "80" }, { fontSize: 120 });
  assert.equal(legacy.lines.length, modern.lines.length);
  assert.equal(legacy.lines[0].width, modern.lines[0].width);
  assert.deepEqual(
    legacy.lines[0].glyphs.map((g) => [g.gid, g.x, g.advance]),
    modern.lines[0].glyphs.map((g) => [g.gid, g.x, g.advance])
  );
});

test("legacy normalize entry keeps clamped/normalized/unsupported and adds diagnostics", () => {
  const font = loadFont(NOTO_PATH);
  const legacy = normalizeLegacyLocation(font, { wght: "700", ZZZZ: 1 });
  assert.equal(legacy.clamped.wght, 700);
  assert.deepEqual(legacy.unsupported, ["ZZZZ"]);
  assert.deepEqual(legacy.invalid, []);
  assert.deepEqual(legacy.adjusted, []);
  // A genuinely bad legacy value is still surfaced, not defaulted silently.
  const bad = normalizeLegacyLocation(font, { wght: "bold" });
  assert.equal(bad.invalid.length, 1);
  assert.equal(bad.invalid[0].reason, "not-a-number");
});

test("legacy entries still match fontTools/HarfBuzz references", () => {
  for (const [key, path] of [["noto", NOTO_PATH], ["test", TEST_PATH]]) {
    const ref = loadReference(key);
    const font = loadFont(path);
    const set = new FontSet([font]);
    for (const entry of ref.normalize) {
      const legacy = normalizeLegacyLocation(font, entry.user);
      for (const [tag, want] of Object.entries(entry.normalized)) {
        assert.ok(Math.abs(legacy.normalized[tag] - want) < 1e-5, `${key} ${tag}`);
      }
    }
    // Shape through the legacy entry and compare glyph ids + advances to
    // HarfBuzz at the same (migrated) location.
    for (const shaping of ref.shaping) {
      const layout = layoutLegacyPoster(set, shaping.text, shaping.location, {
        fontSize: 100,
        padding: 0,
      });
      const glyphs = layout.lines.flatMap((line) => line.glyphs);
      assert.equal(glyphs.length, shaping.glyphs.length,
        `${key} ${JSON.stringify(shaping.text)} glyph count`);
      for (let i = 0; i < glyphs.length; i++) {
        assert.equal(glyphs[i].gid, shaping.glyphs[i].gid,
          `${key} ${JSON.stringify(shaping.text)} gid ${i}`);
        assert.equal(glyphs[i].advance, shaping.glyphs[i].advance,
          `${key} ${JSON.stringify(shaping.text)} advance ${i} @ ${JSON.stringify(shaping.location)}`);
      }
    }
  }
});
