// FontSet: shapes text across a primary (variable) font plus ordered
// fallback fonts. Every glyph records which font actually produced it;
// missing glyphs (no coverage anywhere) use the primary font's .notdef
// and are flagged explicitly.
//
// Coordinate validation is delegated to each font's AxisSpace. The primary
// font's resolution is the one reported to the UI, and every font reports
// the axes it does not declare (unsupported) rather than silently folding
// them into defaults.

export class FontSet {
  constructor(fonts) {
    this.fonts = fonts; // [primary, ...fallbacks]
  }

  get primary() {
    return this.fonts[0];
  }

  // Shape text. userLocation applies to every font, but each font only
  // honors the axes it actually supports (others are reported as ignored
  // for that font).
  shape(text, userLocation = {}) {
    const cps = [...text].map((ch) => ch.codePointAt(0));
    const primary = this.primary;

    // Resolve coordinates once per font (cheap, cached by AxisSpace key).
    const resolved = this.fonts.map((font) => font.normalize(userLocation));

    // Assign each codepoint to the first font that covers it.
    const assignments = cps.map((cp) => {
      for (let fi = 0; fi < this.fonts.length; fi++) {
        const gid = this.fonts[fi].glyphIdFor(cp);
        if (gid !== 0) return { fontIndex: fi, gid };
      }
      return { fontIndex: -1, gid: 0 }; // missing everywhere
    });

    // Group consecutive same-font glyphs into runs so kerning applies
    // within a run only (never across different fonts).
    const glyphs = new Array(cps.length);
    let i = 0;
    const unsupportedByFont = new Map();
    while (i < cps.length) {
      const fi = assignments[i].fontIndex;
      let j = i;
      while (j < cps.length && assignments[j].fontIndex === fi) j++;
      if (fi === -1) {
        // Missing run: use primary font's .notdef.
        const primaryNorm = resolved[0];
        for (let k = i; k < j; k++) {
          glyphs[k] = {
            cp: cps[k],
            char: String.fromCodePoint(cps[k]),
            gid: 0,
            fontIndex: 0,
            missing: true,
            fallback: false,
            advance: primary.advance(0, primaryNorm.normalized),
            xOffset: 0,
            yOffset: 0,
            normalized: primaryNorm.normalized,
          };
        }
      } else {
        const font = this.fonts[fi];
        const runText = cps.slice(i, j).map((cp) => String.fromCodePoint(cp)).join("");
        const shaped = font.shape(runText, userLocation);
        if (shaped.unsupported.length && !unsupportedByFont.has(fi)) {
          unsupportedByFont.set(fi, shaped.unsupported);
        }
        shaped.glyphs.forEach((g, k) => {
          glyphs[i + k] = {
            ...g,
            fontIndex: fi,
            missing: false,
            fallback: fi !== 0,
            normalized: shaped.normalized,
          };
        });
      }
      i = j;
    }

    const primaryNorm = resolved[0];
    return {
      glyphs,
      clamped: primaryNorm.clamped,
      normalized: primaryNorm.normalized,
      unsupported: primaryNorm.unsupported,
      invalid: primaryNorm.invalid,
      adjusted: primaryNorm.adjusted,
      unsupportedByFont: [...unsupportedByFont.entries()].map(([fi, tags]) => ({
        fontIndex: fi,
        tags,
      })),
      missingCount: glyphs.filter((g) => g.missing).length,
      fallbackCount: glyphs.filter((g) => g.fallback).length,
    };
  }
}
