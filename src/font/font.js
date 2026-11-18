// Font: high-level facade over all parsed tables. Real variable-font engine:
// fvar/avar normalization, gvar outline interpolation (with IUP), HVAR
// advance deltas, GPOS/kern kerning, MVAR metrics, composite resolution.

import { Reader, otRound } from "./reader.js";
import { openSfnt, tableReader } from "./sfnt.js";
import { parseCmap } from "./cmap.js";
import { parseName } from "./name.js";
import { parseFvar, parseAvar, normalizeLocation, applyAvar } from "./fvar.js";
import { GvarTable, gvarDeltas } from "./gvar.js";
import { GlyfTable, COMP_SCALED_OFFSET, COMP_UNSCALED_OFFSET, COMP_USE_MY_METRICS } from "./glyf.js";
import { parseHhea, parseHmtx, parseHvar, parseMvar } from "./metrics.js";
import { GposTable, parseGdef, parseKern } from "./gpos.js";
import { VarStoreInstancer } from "./varstore.js";

export class Font {
  constructor(buffer, { collectionIndex = 0 } = {}) {
    const reader = Reader.from(buffer);
    const { tables } = openSfnt(reader, collectionIndex);
    this.reader = reader;
    this.tables = tables;

    // head
    const head = tableReader(reader, tables, "head");
    head.skip(18);
    this.unitsPerEm = head.u16();
    head.seek(50);
    this.indexToLocFormat = head.i16();

    // maxp / loca / glyf
    const maxpRec = tables.get("maxp");
    const locaRec = tables.get("loca");
    const glyfRec = tables.get("glyf");
    const { offsets: locaOffsets, numGlyphs } = GlyfTable.parseLoca(
      reader,
      tables.get("head").offset,
      maxpRec.offset,
      locaRec.offset
    );
    this.numGlyphs = numGlyphs;
    this.glyf = new GlyfTable(reader, glyfRec.offset, locaOffsets);

    // metrics
    this.hhea = parseHhea(reader, tables.get("hhea").offset);
    this.hmtx = parseHmtx(reader, tables.get("hmtx").offset, this.hhea.numberOfHMetrics, numGlyphs);

    // cmap / name
    this.cmap = parseCmap(reader, tables.get("cmap").offset);
    this.name = parseName(reader, tables.get("name").offset);

    // variations
    const fvarRec = tables.get("fvar");
    this.isVariable = !!fvarRec;
    this.axes = [];
    this.instances = [];
    this.avar = null;
    if (fvarRec) {
      const fvar = parseFvar(reader, fvarRec.offset, this.name);
      this.axes = fvar.axes;
      this.instances = fvar.instances;
      const avarRec = tables.get("avar");
      if (avarRec) this.avar = parseAvar(reader, avarRec.offset);
    }
    this.axisTags = this.axes.map((a) => a.tag);

    const gvarRec = tables.get("gvar");
    this.gvar = gvarRec ? new GvarTable(reader, gvarRec.offset, this.axisTags, numGlyphs) : null;

    const hvarRec = tables.get("HVAR");
    this.hvar = hvarRec ? parseHvar(reader, hvarRec.offset, this.axisTags) : null;

    const mvarRec = tables.get("MVAR");
    this.mvar = mvarRec ? parseMvar(reader, mvarRec.offset, this.axisTags) : null;

    const gdefRec = tables.get("GDEF");
    this.gdef = gdefRec ? parseGdef(reader, gdefRec.offset, this.axisTags) : null;

    const gposRec = tables.get("GPOS");
    this.gpos = gposRec ? new GposTable(reader, gposRec.offset, this.gdef, this.axisTags) : null;

    const kernRec = tables.get("kern");
    this.kern = kernRec ? parseKern(reader, kernRec.offset) : null;

    // Per-location caches, keyed by normalized-coords string.
    this.locationCache = new Map();
    this.outlineCache = new Map(); // locKey -> Map(gid -> outline)
  }

  get familyName() {
    return this.name.get(16) ?? this.name.get(1) ?? "unknown";
  }

  // --- variation coordinates ---

  // userLocation: {tag: value}. Returns {clamped, normalized, unsupported}.
  normalize(userLocation = {}) {
    const unsupported = [];
    const supported = {};
    for (const [tag, value] of Object.entries(userLocation)) {
      if (this.axisTags.includes(tag)) supported[tag] = value;
      else unsupported.push(tag);
    }
    const { clamped, normalized } = normalizeLocation(supported, this.axes);
    const mapped = applyAvar(normalized, this.axes, this.avar);
    return { clamped, normalized: mapped, unsupported };
  }

  locationKey(normalized) {
    return this.axisTags.map((t) => (normalized[t] ?? 0).toFixed(6)).join(",");
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

  glyphIdFor(cp) {
    return this.cmap.glyphIdFor(cp);
  }

  // Returns {contours: [[{x,y,onCurve}...]...], bbox, endPts, phantoms}
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
      // Simple glyph (or empty).
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

  // --- shaping ---

  // Shape a single run of text with this font only.
  // Returns {glyphs, clamped, normalized, unsupported}.
  shape(text, userLocation = {}) {
    const { clamped, normalized, unsupported } = this.normalize(userLocation);
    const state = this.locationState(normalized);
    const cps = [...text].map((ch) => ch.codePointAt(0));
    const gids = cps.map((cp) => this.glyphIdFor(cp));

    const n = cps.length;
    let adj = { xAdvance: new Float64Array(n), xPlacement: new Float64Array(n), yPlacement: new Float64Array(n), yAdvance: new Float64Array(n) };
    let kernSource = null;
    if (this.gpos && this.gpos.kernLookups.length > 0) {
      adj = this.gpos.applyKerning(gids, state.gdefInstancer);
      kernSource = "GPOS";
    } else if (this.kern && this.kern.pairs.size > 0) {
      kernSource = "kern";
      // HarfBuzz hb_kern_machine_t: pairs are formed between non-mark
      // glyphs (IgnoreMarks), the value is split kern>>1 / kern-(kern>>1)
      // between the two advances, and the second half is also added to the
      // right glyph's xOffset.
      const isMark = (gid) =>
        this.gdef?.glyphClassDef ? this.gdef.glyphClassDef.get(gid) === 3 : false;
      let prev = -1;
      for (let j = 0; j < n; j++) {
        if (isMark(gids[j])) continue;
        if (prev >= 0) {
          const kern = this.kern.pairs.get((gids[prev] << 16) | gids[j]);
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
      advance: this.advance(gids[i], normalized) + adj.xAdvance[i],
      xOffset: adj.xPlacement[i],
      yOffset: adj.yPlacement[i],
    }));

    // HarfBuzz default shaper zeroes mark advances after GPOS
    // (zero_mark_widths_by_gdef, BY_GDEF_LATE).
    if (this.gdef?.glyphClassDef) {
      for (const g of glyphs) {
        if (this.gdef.glyphClassDef.get(g.gid) === 3) g.advance = 0;
      }
    }
    return { glyphs, clamped, normalized, unsupported, kernSource };
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
