// Refactor equivalence: the frozen snapshot in fixtures/engine-baseline.json
// was generated from the pre-refactor engine. Regenerating it after the
// split (axes/glyph/shaping/layout) must reproduce the same outlines,
// advances, metrics and layout extents for every sampled axis location and
// text, including a primary+fallback set and a missing-glyph string.
//
// An axis layout change that alters these numbers is a behavior change, not
// a refactor. Regenerate deliberately with `node tools/snapshot-engine.mjs`
// only when the change is intended and reviewed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSnapshot } from "../tools/snapshot-engine.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/engine-baseline.json"), "utf8")
);

function deepDiff(a, b, path = "") {
  const diffs = [];
  if (typeof a !== typeof b) {
    diffs.push(`${path}: type ${typeof a} vs ${typeof b}`);
    return diffs;
  }
  if (a === null || b === null || typeof a !== "object") {
    if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return diffs;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      diffs.push(`${path}: array length ${a.length} vs ${b?.length}`);
      return diffs;
    }
    for (let i = 0; i < a.length; i++) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffs.push(...deepDiff(a[k], b[k], path ? `${path}.${k}` : k));
  return diffs;
}

test("refactor equivalence: outlines and layout ranges match frozen baseline", () => {
  const after = buildSnapshot();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(BASELINE).sort());
  for (const key of Object.keys(BASELINE)) {
    const diffs = deepDiff(after[key], BASELINE[key], key);
    // Report the first few differences so a failure points at the scenario.
    assert.equal(diffs.length, 0, `${diffs.length} differences:\n${diffs.slice(0, 8).join("\n")}`);
  }
});

test("refactor equivalence: every sampled location produced real outlines", () => {
  for (const [key, scenario] of Object.entries(BASELINE)) {
    for (const loc of scenario.locations) {
      for (const textEntry of loc.texts) {
        for (const line of textEntry.lines) {
          for (const g of line.glyphs) {
            // Non-empty glyphs must have at least one contour; .notdef may be
            // empty in some fonts but space is expected empty too.
            if (g.cp !== 0x20 && !g.missing) {
              assert.ok(
                g.outline.contours.length > 0,
                `${key} cp U+${g.cp.toString(16)} @ ${JSON.stringify(loc.location)} has no outline`
              );
            }
          }
        }
      }
    }
  }
});
