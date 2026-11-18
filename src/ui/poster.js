// Canvas renderer for the laid-out poster. Draws real glyph outlines
// (quadratic TrueType contours) at the positions computed by layout.js,
// with explicit visual marking for missing glyphs and fallback fonts.

export const COLORS = {
  primary: "#182233",
  fallback: "#c2571a",
  missing: "#d21f3c",
  background: "#faf8f4",
  baseline: "rgba(214, 40, 40, 0.55)",
  ascender: "rgba(40, 90, 214, 0.45)",
  advanceBox: "rgba(24, 34, 51, 0.14)",
  offsetMark: "rgba(40, 90, 214, 0.8)",
};

// Append a TrueType contour (on/off-curve points, implied midpoints) to a
// Path2D, mapping font units through (x0, y0, scale) with y-down canvas.
function contourToPath(path, contour, x0, y0, scale) {
  const n = contour.length;
  if (!n) return;
  const X = (x) => x0 + x * scale;
  const Y = (y) => y0 - y * scale;
  const P = (i) => contour[(i + n) % n];
  let start;
  let i0;
  if (contour[0].onCurve) {
    start = contour[0];
    i0 = 1;
  } else if (contour[n - 1].onCurve) {
    start = contour[n - 1];
    i0 = 0;
  } else {
    start = {
      x: (contour[n - 1].x + contour[0].x) / 2,
      y: (contour[n - 1].y + contour[0].y) / 2,
    };
    i0 = 0;
  }
  path.moveTo(X(start.x), Y(start.y));
  let pending = null; // off-curve control point awaiting its target
  for (let k = 0; k < n; k++) {
    const p = P(i0 + k);
    if (p.onCurve) {
      if (pending) {
        path.quadraticCurveTo(X(pending.x), Y(pending.y), X(p.x), Y(p.y));
        pending = null;
      } else {
        path.lineTo(X(p.x), Y(p.y));
      }
    } else if (pending) {
      const mx = (pending.x + p.x) / 2;
      const my = (pending.y + p.y) / 2;
      path.quadraticCurveTo(X(pending.x), Y(pending.y), X(mx), Y(my));
      pending = p;
    } else {
      pending = p;
    }
  }
  if (pending) path.quadraticCurveTo(X(pending.x), Y(pending.y), X(start.x), Y(start.y));
  path.closePath();
}

export function outlinePath(outline, x0, y0, scale) {
  const path = new Path2D();
  for (const contour of outline.contours) contourToPath(path, contour, x0, y0, scale);
  return path;
}

// Render the full poster. Returns hit boxes for the glyph inspector.
export function renderPoster(canvas, layout, fontSet, options = {}) {
  const { showMetrics = false } = options;
  const dpr = globalThis.devicePixelRatio || 1;
  const { width, height } = layout;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  const primaryScale = layout.fontSize / fontSet.primary.unitsPerEm;
  const hits = [];
  for (const line of layout.lines) {
    if (showMetrics) {
      drawLineMetrics(ctx, line, layout, primaryScale, width);
    }
    for (const g of line.glyphs) {
      const font = fontSet.fonts[g.fontIndex];
      const outline = font.getOutline(g.gid, g.normalized);
      const path = outlinePath(outline, g.x, g.y, g.scale);
      if (g.missing) {
        // Missing glyph: dashed red advance box + red .notdef outline.
        ctx.save();
        ctx.strokeStyle = COLORS.missing;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
          g.x,
          g.y - layout.metrics.ascent * primaryScale,
          g.advancePx,
          (layout.metrics.ascent - layout.metrics.descent) * primaryScale
        );
        ctx.restore();
        ctx.strokeStyle = COLORS.missing;
        ctx.lineWidth = 1.5;
        ctx.stroke(path);
      } else {
        ctx.fillStyle = g.fallback ? COLORS.fallback : COLORS.primary;
        ctx.fill(path);
      }
      if (showMetrics) drawGlyphMetrics(ctx, g, line, layout, primaryScale);
      hits.push({
        glyph: g,
        x0: g.x,
        y0: line.baselineY - layout.metrics.ascent * primaryScale,
        x1: g.x + Math.max(g.advancePx, 2),
        y1: line.baselineY - layout.metrics.descent * primaryScale,
      });
    }
  }
  return hits;
}

function drawLineMetrics(ctx, line, layout, primaryScale, width) {
  const { baselineY } = line;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.baseline;
  ctx.beginPath();
  ctx.moveTo(0, baselineY);
  ctx.lineTo(width, baselineY);
  ctx.stroke();
  ctx.strokeStyle = COLORS.ascender;
  ctx.setLineDash([3, 4]);
  for (const v of [layout.metrics.ascent, layout.metrics.descent]) {
    ctx.beginPath();
    ctx.moveTo(0, baselineY - v * primaryScale);
    ctx.lineTo(width, baselineY - v * primaryScale);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGlyphMetrics(ctx, g, line, layout, primaryScale) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.advanceBox;
  ctx.strokeRect(
    g.x,
    line.baselineY - layout.metrics.ascent * primaryScale,
    g.advancePx,
    (layout.metrics.ascent - layout.metrics.descent) * primaryScale
  );
  if (g.xOffset || g.yOffset) {
    // Mark where the unadjusted pen position would have put this glyph.
    ctx.strokeStyle = COLORS.offsetMark;
    ctx.beginPath();
    ctx.moveTo(g.x - g.xOffset * g.scale - 4, g.y + g.yOffset * g.scale);
    ctx.lineTo(g.x - g.xOffset * g.scale + 4, g.y + g.yOffset * g.scale);
    ctx.moveTo(g.x - g.xOffset * g.scale, g.y + g.yOffset * g.scale - 4);
    ctx.lineTo(g.x - g.xOffset * g.scale, g.y + g.yOffset * g.scale + 4);
    ctx.stroke();
  }
  ctx.restore();
}
