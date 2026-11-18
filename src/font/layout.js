// Text layout, split into two independent stages so callers can see what an
// axis change invalidates:
//
//   shapeText()  text + axis location -> shaped glyph runs and metrics
//                (invalidated by axis location or text)
//   placeLines() shaped runs + options -> positioned lines
//                (invalidated by options; axis changes re-enter via shape)
//   layoutPoster() the original combined entry point (kept as a thin wrapper
//                so existing callers, including the poster UI, keep working).
//
// Pen positions are derived from the actual (variation-adjusted) advances
// and kerning of each glyph — nothing is reused across axis changes, so
// glyphs never collide because of stale metrics.

export function resolveLayoutOptions(options = {}) {
  const {
    fontSize = 120,
    lineHeight = null, // px; null -> derived from font metrics * lineHeightFactor
    lineHeightFactor = 1.2,
    letterSpacing = 0, // px, added after each glyph
    padding = 60,
    align = "left", // left | center | right
    width = 1200,
    height = 800,
  } = options;
  return { fontSize, lineHeight, lineHeightFactor, letterSpacing, padding, align, width, height };
}

// Shape each paragraph separately so kerning never crosses a line break and
// the newline itself is never shaped as a (missing) glyph.
export function shapeText(fontSet, text, userLocation = {}) {
  const primary = fontSet.primary;
  const paragraphs = text.split("\n");
  const shapedLines = paragraphs.map((p) => fontSet.shape(p, userLocation));
  const shaped = mergeShaped(shapedLines);
  const metrics = primary.metricsFor(shaped.normalized);
  return { shapedLines, shaped, metrics };
}

export function placeLines(fontSet, shapedLines, shaped, metrics, options = {}) {
  const {
    fontSize,
    lineHeight,
    lineHeightFactor,
    letterSpacing,
    padding,
    align,
    width,
    height,
  } = resolveLayoutOptions(options);

  const scaleOf = (fontIndex) => fontSize / fontSet.fonts[fontIndex].unitsPerEm;
  const primaryScale = scaleOf(0);

  const emHeight = (metrics.ascent - metrics.descent) * primaryScale;
  const naturalLine = (metrics.ascent - metrics.descent + metrics.lineGap) * primaryScale;
  const lineHeightPx = lineHeight ?? Math.max(naturalLine * lineHeightFactor, fontSize * 1.05);

  const lines = [];
  let baselineY = padding + metrics.ascent * primaryScale + (lineHeightPx - emHeight) / 2;

  for (const sl of shapedLines) {
    // Measure first (alignment needs the real width).
    const widths = sl.glyphs.map((g) => g.advance * scaleOf(g.fontIndex));
    const lineWidth =
      widths.reduce((a, b) => a + b, 0) + letterSpacing * Math.max(0, sl.glyphs.length - 1);
    let penX = padding;
    if (align === "center") penX = padding + Math.max(0, (width - padding * 2 - lineWidth) / 2);
    else if (align === "right") penX = padding + Math.max(0, width - padding * 2 - lineWidth);

    const placed = sl.glyphs.map((g, i) => {
      const s = scaleOf(g.fontIndex);
      const x = penX + g.xOffset * s;
      const y = baselineY - g.yOffset * s;
      penX += widths[i] + (i < sl.glyphs.length - 1 ? letterSpacing : 0);
      return { ...g, x, y, advancePx: widths[i], scale: s };
    });
    lines.push({ glyphs: placed, width: lineWidth, baselineY });
    baselineY += lineHeightPx;
  }

  return {
    lines,
    shaped, // full-text shape result (unsupported axes, counts)
    metrics,
    lineHeightPx,
    width,
    height,
    padding,
    fontSize,
    options: { ...resolveLayoutOptions(options) },
  };
}

// Combined entry point: shape then place.
export function layoutPoster(fontSet, text, userLocation, options = {}) {
  const { shapedLines, shaped, metrics } = shapeText(fontSet, text, userLocation);
  return placeLines(fontSet, shapedLines, shaped, metrics, options);
}

// Combine per-paragraph shape results into one full-text result.
function mergeShaped(shapedLines) {
  const first = shapedLines[0];
  const glyphs = [];
  const byFont = new Map();
  const invalid = [];
  const adjusted = [];
  let missingCount = 0;
  let fallbackCount = 0;
  for (const sl of shapedLines) {
    glyphs.push(...sl.glyphs);
    missingCount += sl.missingCount;
    fallbackCount += sl.fallbackCount;
    invalid.push(...(sl.invalid ?? []));
    adjusted.push(...(sl.adjusted ?? []));
    for (const entry of sl.unsupportedByFont) {
      if (!byFont.has(entry.fontIndex)) byFont.set(entry.fontIndex, new Set());
      for (const t of entry.tags) byFont.get(entry.fontIndex).add(t);
    }
  }
  return {
    glyphs,
    clamped: first.clamped,
    normalized: first.normalized,
    unsupported: first.unsupported,
    invalid,
    adjusted,
    unsupportedByFont: [...byFont.entries()].map(([fontIndex, tags]) => ({
      fontIndex,
      tags: [...tags],
    })),
    missingCount,
    fallbackCount,
  };
}
