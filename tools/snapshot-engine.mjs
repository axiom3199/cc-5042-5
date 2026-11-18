// Freeze the variable-font engine's externally visible output into a JSON
// baseline. The refactor-equivalence test regenerates this data and compares
// outlines (bbox + coordinate checksum) and layout extents per scenario.
//
// Usage: node tools/snapshot-engine.mjs [outPath]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadFont, NOTO_PATH, TEST_PATH, DEJAVU_PATH } from "../test/helpers.js";
import { FontSet } from "../src/font/fontset.js";
import { layoutPoster } from "../src/font/layout.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LOCATIONS = [
  {},
  { wght: 100, wdth: 62.5 },
  { wght: 900, wdth: 62.5 },
  { wght: 900, wdth: 100 },
  { wght: 333.3, wdth: 75.7 },
  { wght: 1000, wdth: 10 }, // out of range: must clamp, not error
];

const SCENARIOS = [
  { key: "noto", fontPaths: [NOTO_PATH], texts: ["AVATAR", "To oooo AVA", "A🦄B"] },
  { key: "test", fontPaths: [TEST_PATH], texts: ["AV", "A😀B", "To"] },
  // Primary + fallback: exercises a glyph from a second font and a glyph
  // missing from every font, so extents include fallback advances.
  { key: "noto+dejavu", fontPaths: [NOTO_PATH, DEJAVU_PATH], texts: ["AVATAR ♥ A🦄B", "To ♥"] },
];

const LAYOUT_OPTIONS = {
  fontSize: 100,
  lineHeightFactor: 1.2,
  letterSpacing: 2,
  align: "center",
  width: 1400,
  padding: 12,
  height: 800,
};

function round(v, digits = 6) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// FNV-1a over all rounded points. A checksum keeps the baseline small while
// still detecting any coordinate change; bbox covers the visible extent.
function checksum(outline) {
  let h = 0x811c9dc5;
  const mix = (n) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const contour of outline.contours) {
    for (const p of contour) {
      mix(Math.round(p.x * 1000));
      mix(Math.round(p.y * 1000));
      mix(p.onCurve ? 1 : 0);
    }
    mix(0xff); // contour separator
  }
  return h >>> 0;
}

function outlineSummary(outline) {
  return {
    contours: outline.contours.map((c) => c.length),
    bbox: Object.fromEntries(
      Object.entries(outline.bbox).map(([k, v]) => [k, round(v)])
    ),
    checksum: checksum(outline),
    composite: outline.composite,
  };
}

function snapshotScenario({ key, fontPaths, texts }) {
  const set = new FontSet(fontPaths.map((p) => loadFont(p)));
  const primary = set.primary;
  const results = [];
  for (const location of LOCATIONS) {
    const { clamped, normalized, unsupported } = primary.normalize(location);
    const textsOut = texts.map((text) => {
      const layout = layoutPoster(set, text, location, LAYOUT_OPTIONS);
      const lines = layout.lines.map((line) => ({
        width: round(line.width),
        baselineY: round(line.baselineY),
        glyphs: line.glyphs.map((g) => ({
          cp: g.cp,
          gid: g.gid,
          fontIndex: g.fontIndex,
          missing: g.missing,
          fallback: g.fallback,
          advance: round(g.advance),
          advancePx: round(g.advancePx),
          x: round(g.x),
          y: round(g.y),
          xOffset: round(g.xOffset),
          yOffset: round(g.yOffset),
          scale: round(g.scale),
          outline: outlineSummary(
            set.fonts[g.fontIndex].getOutline(g.gid, g.normalized)
          ),
        })),
      }));
      return {
        text,
        lines,
        metrics: {
          ascent: round(layout.metrics.ascent),
          descent: round(layout.metrics.descent),
          lineGap: round(layout.metrics.lineGap),
        },
        lineHeightPx: round(layout.lineHeightPx),
        missingCount: layout.shaped.missingCount,
        fallbackCount: layout.shaped.fallbackCount,
      };
    });
    results.push({
      location,
      clamped: Object.fromEntries(
        Object.entries(clamped).map(([k, v]) => [k, round(v)])
      ),
      normalized: Object.fromEntries(
        Object.entries(normalized).map(([k, v]) => [k, round(v)])
      ),
      unsupported: [...unsupported],
      texts: textsOut,
    });
  }
  return {
    fonts: set.fonts.map((font) => ({
      family: font.familyName,
      upm: font.unitsPerEm,
      numGlyphs: font.numGlyphs,
      axes: font.axes.map((a) => ({ tag: a.tag, min: a.min, default: a.default, max: a.max })),
    })),
    layoutOptions: LAYOUT_OPTIONS,
    locations: results,
  };
}

export function buildSnapshot() {
  return Object.fromEntries(SCENARIOS.map((scenario) => [scenario.key, snapshotScenario(scenario)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(ROOT, "test/fixtures/engine-baseline.json");
  const data = buildSnapshot();
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  const locs = Object.values(data).reduce((n, s) => n + s.locations.length, 0);
  console.log(`wrote ${out} (${locs} location sets)`);
}
