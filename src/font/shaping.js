// Run shaping: codepoints -> glyph ids -> positioned advances. This module
// owns the part of glyph evaluation that depends on neighbouring glyphs
// (GPOS/kern and GDEF mark handling); pure outline/advance evaluation lives
// in glyph.js. Both consume an already-resolved normalized location: the
// axis pipeline is not re-entered here.

export function shapeRun(font, text, resolved) {
  const { normalized } = resolved;
  const cps = [...text].map((ch) => ch.codePointAt(0));
  const gids = cps.map((cp) => font.glyphIdFor(cp));

  const n = cps.length;
  let adj = {
    xAdvance: new Float64Array(n),
    xPlacement: new Float64Array(n),
    yPlacement: new Float64Array(n),
    yAdvance: new Float64Array(n),
  };
  let kernSource = null;
  if (font.gpos && font.gpos.kernLookups.length > 0) {
    adj = font.gpos.applyKerning(gids, font.glyph.locationState(normalized).gdefInstancer);
    kernSource = "GPOS";
  } else if (font.kern && font.kern.pairs.size > 0) {
    kernSource = "kern";
    // HarfBuzz hb_kern_machine_t: pairs are formed between non-mark
    // glyphs (IgnoreMarks), the value is split kern>>1 / kern-(kern>>1)
    // between the two advances, and the second half is also added to the
    // right glyph's xOffset.
    const isMark = (gid) =>
      font.gdef?.glyphClassDef ? font.gdef.glyphClassDef.get(gid) === 3 : false;
    let prev = -1;
    for (let j = 0; j < n; j++) {
      if (isMark(gids[j])) continue;
      if (prev >= 0) {
        const kern = font.kern.pairs.get((gids[prev] << 16) | gids[j]);
        if (kern) {
          const kern1 = kern >> 1;
          const kern2 = kern - kern1;
          adj.xAdvance[prev] += kern1;
          adj.xAdvance[j] += kern2;
          adj.xPlacement[j] += kern2;
        }
      }
      prev = j;
    }
  }

  const glyphs = cps.map((cp, i) => ({
    cp,
    char: String.fromCodePoint(cp),
    gid: gids[i],
    missing: gids[i] === 0 && cp !== 0,
    advance: font.glyph.advance(gids[i], normalized) + adj.xAdvance[i],
    xOffset: adj.xPlacement[i],
    yOffset: adj.yPlacement[i],
  }));

  // HarfBuzz default shaper zeroes mark advances after GPOS
  // (zero_mark_widths_by_gdef, BY_GDEF_LATE).
  if (font.gdef?.glyphClassDef) {
    for (const g of glyphs) {
      if (font.gdef.glyphClassDef.get(g.gid) === 3) g.advance = 0;
    }
  }

  return {
    glyphs,
    clamped: resolved.clamped,
    normalized,
    unsupported: resolved.unsupported,
    invalid: resolved.invalid,
    adjusted: resolved.adjusted,
    kernSource,
  };
}
