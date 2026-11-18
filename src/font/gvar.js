// gvar: per-glyph tuple variation data, packed points/deltas, IUP inference.
// Semantics mirror fontTools (TupleVariation + varLib.iup) so results match
// fontTools.varLib.instancer bit-for-bit before final rounding.

import { supportScalar } from "./varstore.js";

const EMBEDDED_PEAK_TUPLE = 0x8000;
const INTERMEDIATE_REGION = 0x4000;
const PRIVATE_POINT_NUMBERS = 0x2000;
const TUPLES_SHARE_POINT_NUMBERS = 0x8000;
const TUPLE_COUNT_MASK = 0x0fff;
const TUPLE_INDEX_MASK = 0x0fff;
const POINTS_ARE_WORDS = 0x80;
const POINT_RUN_COUNT_MASK = 0x7f;
const DELTAS_ARE_ZERO = 0x80;
const DELTAS_ARE_WORDS = 0x40;
const DELTAS_ARE_LONGS = 0xc0;
const DELTAS_SIZE_MASK = 0xc0;
const DELTA_RUN_COUNT_MASK = 0x3f;

function decompilePoints(r, pointCount) {
  let numPoints = r.u8();
  if (numPoints & POINTS_ARE_WORDS) {
    numPoints = ((numPoints & POINT_RUN_COUNT_MASK) << 8) | r.u8();
  }
  if (numPoints === 0) {
    // All points of the glyph.
    return { all: true, points: null };
  }
  const points = [];
  while (points.length < numPoints) {
    const header = r.u8();
    const runCount = (header & POINT_RUN_COUNT_MASK) + 1;
    if (header & POINTS_ARE_WORDS) {
      for (let i = 0; i < runCount; i++) points.push(r.u16());
    } else {
      for (let i = 0; i < runCount; i++) points.push(r.u8());
    }
  }
  // Delta-encoded -> absolute.
  let current = 0;
  for (let i = 0; i < points.length; i++) {
    current += points[i];
    points[i] = current;
  }
  return { all: false, points };
}

function decompileDeltas(r, count) {
  const deltas = [];
  while (deltas.length < count) {
    const header = r.u8();
    const runCount = (header & DELTA_RUN_COUNT_MASK) + 1;
    const size = header & DELTAS_SIZE_MASK;
    if (size === DELTAS_ARE_ZERO) {
      for (let i = 0; i < runCount; i++) deltas.push(0);
    } else if (size === DELTAS_ARE_WORDS) {
      for (let i = 0; i < runCount; i++) deltas.push(r.i16());
    } else if (size === DELTAS_ARE_LONGS) {
      for (let i = 0; i < runCount; i++) deltas.push(r.i32());
    } else {
      for (let i = 0; i < runCount; i++) deltas.push(r.i8());
    }
  }
  return deltas;
}

// --- IUP (interpolate unreferenced points), port of fontTools.varLib.iup ---

function iupSegment(coords, rc1, rd1, rc2, rd2, out, j) {
  const x1 = rc1[j], x2 = rc2[j], d1 = rd1[j], d2 = rd2[j];
  if (x1 === x2) {
    const fill = d1 === d2 ? d1 : 0;
    for (const c of coords) out.push(fill);
    return;
  }
  let xa = x1, xb = x2, da = d1, db = d2;
  if (xa > xb) {
    [xa, xb] = [xb, xa];
    [da, db] = [db, da];
  }
  const scale = (db - da) / (xb - xa);
  for (const c of coords) {
    const x = c[j];
    let d;
    if (x <= xa) d = da;
    else if (x >= xb) d = db;
    else d = da + (x - xa) * scale;
    out.push(d);
  }
}

function iupContour(deltas, coords) {
  // deltas: array of [dx,dy] or null; coords: array of [x,y]
  const n = deltas.length;
  if (!deltas.includes(null)) return deltas;
  const indices = [];
  for (let i = 0; i < n; i++) if (deltas[i] !== null) indices.push(i);
  if (indices.length === 0) return deltas.map(() => [0, 0]);

  const out = new Array(n);
  const fillSegment = (i1, i2, ri1, ri2) => {
    const segCoords = coords.slice(i1, i2);
    const xs = [], ys = [];
    iupSegment(segCoords, coords[ri1], deltas[ri1], coords[ri2], deltas[ri2], xs, 0);
    iupSegment(segCoords, coords[ri1], deltas[ri1], coords[ri2], deltas[ri2], ys, 1);
    for (let k = 0; k < segCoords.length; k++) out[i1 + k] = [xs[k], ys[k]];
  };

  let start = indices[0];
  let pos = 0;
  if (start !== 0) {
    fillSegment(0, start, start, indices[indices.length - 1]);
    pos = start;
  }
  out[start] = deltas[start];
  pos = start + 1;
  for (let k = 1; k < indices.length; k++) {
    const end = indices[k];
    if (end - start > 1) fillSegment(start + 1, end, start, end);
    out[end] = deltas[end];
    start = end;
    pos = end + 1;
  }
  if (start !== n - 1) {
    fillSegment(start + 1, n, start, indices[0]);
  }
  return out;
}

export function iupDelta(deltas, coords, endPts) {
  // coords: all points including 4 phantoms; endPts: contour end indices.
  const n = coords.length;
  const ends = [...endPts, n - 4, n - 3, n - 2, n - 1];
  const out = [];
  let start = 0;
  for (const endRaw of ends) {
    const end = endRaw + 1;
    out.push(...iupContour(deltas.slice(start, end), coords.slice(start, end)));
    start = end;
  }
  return out;
}

// --- gvar table ---

export class GvarTable {
  constructor(reader, tableOffset, axisTags, glyphCount) {
    const r = reader.sub(tableOffset);
    r.u16(); // majorVersion
    r.u16(); // minorVersion
    const axisCount = r.u16();
    const sharedTupleCount = r.u16();
    const offsetToSharedTuples = r.u32();
    this.glyphCount = r.u16();
    const flags = r.u16();
    this.offsetToGlyphVariationData = r.u32();
    this.longOffsets = (flags & 1) !== 0;
    this.tableOffset = tableOffset;
    this.reader = reader;
    this.axisTags = axisTags;

    // Shared tuple peak coordinates.
    this.sharedTuples = [];
    const sr = reader.sub(tableOffset + offsetToSharedTuples);
    for (let i = 0; i < sharedTupleCount; i++) {
      const peak = [];
      for (let a = 0; a < axisCount; a++) peak.push(sr.f2dot14());
      this.sharedTuples.push(peak);
    }

    // Glyph variation data offsets.
    const offsetsPos = tableOffset + 20;
    this.offsets = [];
    const or = reader.sub(offsetsPos);
    for (let i = 0; i <= this.glyphCount; i++) {
      this.offsets.push(this.longOffsets ? or.u32() : or.u16() * 2);
    }

    this.cache = new Map(); // gid -> parsed tuples
  }

  // Returns list of tuples: {axes: Map tag->[start,peak,end], deltas: ( [dx,dy]|null )[]}
  getGlyphVariations(gid, pointCount) {
    if (this.cache.has(gid)) return this.cache.get(gid);
    const start = this.offsets[gid];
    const end = this.offsets[gid + 1];
    if (start === end) {
      this.cache.set(gid, []);
      return [];
    }
    const base = this.tableOffset + this.offsetToGlyphVariationData + start;
    const r = this.reader.sub(base);
    const countRaw = r.u16();
    const offsetToData = r.u16();
    const tupleCount = countRaw & TUPLE_COUNT_MASK;
    const hasSharedPoints = (countRaw & TUPLES_SHARE_POINT_NUMBERS) !== 0;

    // Tuple variation headers.
    const headers = [];
    for (let i = 0; i < tupleCount; i++) {
      const dataSize = r.u16();
      const tupleIndex = r.u16();
      let peak;
      if (tupleIndex & EMBEDDED_PEAK_TUPLE) {
        peak = [];
        for (let a = 0; a < this.axisTags.length; a++) peak.push(r.f2dot14());
      } else {
        peak = this.sharedTuples[tupleIndex & TUPLE_INDEX_MASK];
      }
      let startR = null, endR = null;
      if (tupleIndex & INTERMEDIATE_REGION) {
        startR = [];
        endR = [];
        for (let a = 0; a < this.axisTags.length; a++) startR.push(r.f2dot14());
        for (let a = 0; a < this.axisTags.length; a++) endR.push(r.f2dot14());
      }
      headers.push({ dataSize, privatePoints: (tupleIndex & PRIVATE_POINT_NUMBERS) !== 0, peak, startR, endR });
    }

    // Serialized data.
    const dr = this.reader.sub(base + offsetToData);
    let sharedPoints = null;
    if (hasSharedPoints) sharedPoints = decompilePoints(dr, pointCount);

    const tuples = [];
    for (const h of headers) {
      const tupleEnd = dr.tell() + h.dataSize;
      let pointsRef;
      if (h.privatePoints) pointsRef = decompilePoints(dr, pointCount);
      else pointsRef = sharedPoints;

      let pointIndices;
      if (!pointsRef) pointIndices = [];
      else if (pointsRef.all) pointIndices = null; // all points
      else pointIndices = pointsRef.points;

      const count = pointIndices === null ? pointCount : pointIndices.length;
      const deltasX = decompileDeltas(dr, count);
      const deltasY = decompileDeltas(dr, count);
      dr.seek(tupleEnd);

      // Build support map, dropping (0,0,0) regions (fontTools behavior).
      const axes = new Map();
      for (let a = 0; a < this.axisTags.length; a++) {
        const peak = h.peak[a];
        let s, e;
        if (h.startR) {
          s = h.startR[a];
          e = h.endR[a];
        } else {
          s = Math.min(peak, 0);
          e = Math.max(peak, 0);
        }
        if (s !== 0 || peak !== 0 || e !== 0) axes.set(this.axisTags[a], [s, peak, e]);
      }

      // Expand to per-point deltas (null = unreferenced).
      const deltas = new Array(pointCount).fill(null);
      if (pointIndices === null) {
        for (let p = 0; p < pointCount; p++) deltas[p] = [deltasX[p], deltasY[p]];
      } else {
        for (let k = 0; k < pointIndices.length; k++) {
          const p = pointIndices[k];
          if (p >= 0 && p < pointCount) deltas[p] = [deltasX[k], deltasY[k]];
        }
      }
      tuples.push({ axes, deltas, filled: null });
    }

    this.cache.set(gid, tuples);
    return tuples;
  }
}

// Compute summed deltas for all points of a glyph at a normalized location.
// coords: default outline points incl. 4 phantoms as [x,y]; endPts: contour ends
// (for composites: one "contour" per component, matching fontTools).
export function gvarDeltas(tuples, coords, endPts, location) {
  const n = coords.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = null;
  let any = false;
  for (const tuple of tuples) {
    const scalar = supportScalar(location, tuple.axes);
    if (scalar === 0) continue;
    let deltas = tuple.deltas;
    if (deltas.includes(null)) {
      if (!tuple.filled) tuple.filled = iupDelta(deltas, coords, endPts);
      deltas = tuple.filled;
    }
    for (let i = 0; i < n; i++) {
      const d = deltas[i];
      if (d === null || (d[0] === 0 && d[1] === 0)) continue;
      if (out[i] === null) out[i] = [scalar * d[0], scalar * d[1]];
      else {
        out[i][0] += scalar * d[0];
        out[i][1] += scalar * d[1];
      }
    }
    any = true;
  }
  if (!any) return null;
  for (let i = 0; i < n; i++) if (out[i] === null) out[i] = [0, 0];
  return out;
}
