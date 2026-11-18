// Shared test helpers: load fonts and reference JSON produced by
// fontTools/HarfBuzz (test/reference/gen_reference.py).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Font } from "../src/font/font.js";
import { FontSet } from "../src/font/fontset.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadFontBuffer(rel) {
  const buf = readFileSync(join(ROOT, rel));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export function loadFont(rel) {
  return new Font(loadFontBuffer(rel));
}

export function loadReference(key) {
  return JSON.parse(readFileSync(join(ROOT, `test/reference/reference-${key}.json`), "utf8"));
}

export const NOTO_PATH = "assets/fonts/NotoSans-wdth-wght.ttf";
export const TEST_PATH = "test/fixtures/TestAxes.ttf";
export const DEJAVU_PATH = "assets/fonts/DejaVuSans.ttf";

// Strings whose HarfBuzz offsets come from MarkToBase ('mark' feature),
// which this engine deliberately does not implement. For these we compare
// glyph ids and advances only.
export const MARK_OFFSET_STRINGS = new Set(["ı̈)", "ı̈̂)"]);

export function approxEqual(a, b, tol, what) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`${what}: ${a} vs ${b} (diff ${Math.abs(a - b)} > ${tol})`);
  }
}
