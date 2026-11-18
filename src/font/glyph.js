// Glyph evaluation: outlines, advances, metrics and their per-location
// caches. Everything that depends on normalized axis coordinates lives
// here, so callers can be explicit about what a change invalidates:
//
//   normalized location change -> outline cache, advance/metrics and all
//                                  layout positions must be recomputed
//   text change              -> outlines/advances are reused from the
//                               location cache; only placement changes
//   option change            -> placement changes only (no glyph work)
//
// Outlines are evaluated by real gvar interpolation (+ IUP and composite
// resolution). No synthetic axes and no uniform scaling stand in for axis
// evaluation here.

import { otRound } from "./reader.js";
import { gvarDeltas } from "./gvar.js";
import { COMP_SCALED_OFFSET, COMP_UNSCALED_OFFSET } from "./glyf.js";
import { VarStoreInstancer } from "./varstore.js";

export class GlyphEvaluator {
  constructor({ glyf, hmtx, hhea, gvar = null, hvar = null, mvar = null, gdef = null, axisSpace }) {
    this.glyf = glyf;
    this.hmtx = hmtx;
    this.hhea = hhea;
    this.gvar = gvar;
    this.hvar = hvar;
    this.mvar = mvar;
    this.gdef = gdef;
    this.axisSpace = axisSpace;

    // Keyed by AxisSpace.locationKey(normalized): all four instancers share
    // one entry, so repeated lookups at the same location reuse work.
    this.locationCache = new Map();
    this.outlineCache = new Map(); // locKey -> Map(gid -> outline)
  }

  locationKey(normalized) {
    return this.axisSpace.locationKey(normalized);
  }

  locationState(normalized) {
    const key = this.locationKey(normalized);
    let state = this.locationCache.get(key);
    if (!state) {
      state = {
        key,
        normalized,
        hvarInstancer: this.hvar ? new VarStoreInstancer(this.hvar.store, normalized) : null,
        gdefInstancer: this.gdef?.varStore ? new VarStoreInstancer(this.gdef.varStore, normalized) : null,
        mvarInstancer: this.mvar ? new VarStoreInstancer(this.mvar.store, normalized) : null,
      };
      this.locationCache.set(key, state);
    }
    return state;
  }

  // --- metrics ---

  metricsFor(normalized) {
    let { ascent, descent, lineGap } = this.hhea;
    if (this.mvar) {
      const inst = this.locationState(normalized).mvarInstancer;
      for (const rec of this.mvar.records) {
        const delta = otRound(inst.delta(rec.varIdx));
        if (rec.tag === "hasc") ascent += delta;
        else if (rec.tag === "hdsc") descent += delta;
        else if (rec.tag === "hlgp") lineGap += delta;
      }
    }
    return { ascent, descent, lineGap };
  }

  advance(gid, normalized) {
    const base = this.hmtx.advances[gid];
    if (this.hvar) {
      const inst = this.locationState(normalized).hvarInstancer;
      return otRound(base + inst.delta(this.hvar.varIdxFor(gid)));
    }
    if (this.gvar) {
      const ph = this.phantomPoints(gid, normalized);
      return Math.max(0, otRound(ph[1][0] - ph[0][0]));
    }
    return base;
  }

  // Phantom points at a location (default hmtx + gvar deltas).
  phantomPoints(gid, normalized) {
    const raw = this.glyf.getRaw(gid);
    const advance = this.hmtx.advances[gid];
    const lsb = this.hmtx.lsbs[gid];
    const leftX = raw.xMin - lsb;
    const ph = [
      [leftX, 0],
      [leftX + advance, 0],
      [0, 0],
      [0, 0],
    ];
    if (this.gvar) {
      const pointCount = this.gvarPointCount(gid, raw);
      const tuples = this.gvar.getGlyphVariations(gid, pointCount);
      if (tuples.length) {
        const coords = this.gvarDefaultCoords(gid, raw, ph);
        const endPts = this.gvarEndPts(raw);
        const deltas = gvarDeltas(tuples, coords, endPts, normalized);
        if (deltas) {
          for (let i = 0; i < 4; i++) {
            const d = deltas[coords.length - 4 + i];
            ph[i][0] += d[0];
            ph[i][1] += d[1];
          }
        }
      }
    }
    return ph;
  }

  gvarPointCount(gid, raw) {
    if (raw.components) return raw.components.length + 4;
    return raw.points.length + 4;
  }

  gvarDefaultCoords(gid, raw, phantoms) {
    const pts = raw.components
      ? raw.components.map((c) => [c.x, c.y])
      : raw.points.map((p) => [p[0], p[1]]);
    return [...pts, ...phantoms.map((p) => [p[0], p[1]])];
  }

  gvarEndPts(raw) {
    if (raw.components) return raw.components.map((_, i) => i);
    return raw.endPts;
  }

  // --- outlines ---

  // Returns {contours: [[{x,y,onCurve}...]...], bbox, phantoms}
  getOutline(gid, normalized) {
    const locKey = this.locationKey(normalized);
    let perLoc = this.outlineCache.get(locKey);
    if (!perLoc) {
      perLoc = new Map();
      this.outlineCache.set(locKey, perLoc);
    }
    if (perLoc.has(gid)) return perLoc.get(gid);
    const outline = this.buildOutline(gid, normalized, new Set());
    perLoc.set(gid, outline);
    return outline;
  }

  buildOutline(gid, normalized, resolving) {
    if (resolving.has(gid)) throw new Error("Composite glyph cycle");
    const raw = this.glyf.getRaw(gid);
    const phantoms = this.phantomPoints(gid, normalized);

    if (!raw.components) {
      const points = raw.points.map((p) => [p[0], p[1]]);
      if (this.gvar && points.length) {
        const coords = this.gvarDefaultCoords(gid, raw, this.defaultPhantoms(gid, raw));
        const tuples = this.gvar.getGlyphVariations(gid, coords.length);
        const deltas = gvarDeltas(tuples, coords, raw.endPts, normalized);
        if (deltas) {
          for (let i = 0; i < points.length; i++) {
            points[i][0] += deltas[i][0];
            points[i][1] += deltas[i][1];
          }
        }
      }
      const contours = [];
      let start = 0;
      for (const end of raw.endPts) {
        const contour = [];
        for (let i = start; i <= end; i++) {
          contour.push({ x: points[i][0], y: points[i][1], onCurve: raw.onCurve[i] });
        }
        contours.push(contour);
        start = end + 1;
      }
      return { contours, bbox: bboxOf(contours), phantoms, composite: false };
    }

    // Composite glyph: gvar deltas adjust component offsets.
    resolving.add(gid);
    const compOffsets = raw.components.map((c) => [c.x, c.y]);
    if (this.gvar) {
      const coords = [...compOffsets.map((o) => [o[0], o[1]]), ...this.defaultPhantoms(gid, raw).map((p) => [p[0], p[1]])];
      const tuples = this.gvar.getGlyphVariations(gid, coords.length);
      const endPts = raw.components.map((_, i) => i);
      const deltas = gvarDeltas(tuples, coords, endPts, normalized);
      if (deltas) {
        for (let i = 0; i < compOffsets.length; i++) {
          compOffsets[i][0] += deltas[i][0];
          compOffsets[i][1] += deltas[i][1];
        }
      }
    }

    const contours = [];
    const flatParentPoints = [];
    raw.components.forEach((comp, ci) => {
      const sub = this.buildOutline(comp.gid, normalized, resolving);
      const t = comp.transform ?? [[1, 0], [0, 1]];
      let dx, dy;
      if (comp.xyValues) {
        [dx, dy] = compOffsets[ci];
        if ((comp.flags & COMP_SCALED_OFFSET) && !(comp.flags & COMP_UNSCALED_OFFSET)) {
          const ndx = t[0][0] * dx + t[0][1] * dy;
          const ndy = t[1][0] * dx + t[1][1] * dy;
          dx = ndx;
          dy = ndy;
        }
      } else {
        // Point matching: align component point secondPt to parent point firstPt.
        const subFlat = [];
        for (const c of sub.contours) for (const p of c) subFlat.push(p);
        const sp = subFlat[comp.secondPt];
        const pp = flatParentPoints[comp.firstPt];
        if (sp && pp) {
          const tx = t[0][0] * sp.x + t[0][1] * sp.y;
          const ty = t[1][0] * sp.x + t[1][1] * sp.y;
          dx = pp.x - tx;
          dy = pp.y - ty;
        } else {
          dx = 0;
          dy = 0;
        }
      }
      for (const contour of sub.contours) {
        const placed = contour.map((p) => {
          const x = t[0][0] * p.x + t[0][1] * p.y + dx;
          const y = t[1][0] * p.x + t[1][1] * p.y + dy;
          return { x, y, onCurve: p.onCurve };
        });
        contours.push(placed);
        for (const p of placed) flatParentPoints.push(p);
      }
    });
    resolving.delete(gid);
    return { contours, bbox: bboxOf(contours), phantoms, composite: true };
  }

  defaultPhantoms(gid, raw) {
    const advance = this.hmtx.advances[gid];
    const lsb = this.hmtx.lsbs[gid];
    const leftX = raw.xMin - lsb;
    return [
      [leftX, 0],
      [leftX + advance, 0],
      [0, 0],
      [0, 0],
    ];
  }
}

function bboxOf(contours) {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < xMin) xMin = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.x > xMax) xMax = p.x;
      if (p.y > yMax) yMax = p.y;
    }
  }
  if (xMin === Infinity) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  return { xMin, yMin, xMax, yMax };
}
