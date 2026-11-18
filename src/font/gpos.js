// GPOS (SinglePos / PairPos / ChainedContextPos / ExtensionPos), GDEF
// (glyph classes, mark glyph sets, variation store) and legacy kern tables.
// Application semantics follow HarfBuzz (apply_forward, skipping iterators,
// idx advancement rules) so positioning matches hb_shape output.

import { parseItemVariationStore, VarStoreInstancer } from "./varstore.js";
import { otRound } from "./reader.js";

// ---------- shared structures ----------

export function parseCoverage(reader, offset) {
  const r = reader.sub(offset);
  const format = r.u16();
  if (format === 1) {
    const count = r.u16();
    const glyphs = [];
    for (let i = 0; i < count; i++) glyphs.push(r.u16());
    return {
      count,
      indexOf(gid) {
        let lo = 0, hi = glyphs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (glyphs[mid] < gid) lo = mid + 1;
          else if (glyphs[mid] > gid) hi = mid - 1;
          else return mid;
        }
        return -1;
      },
      gidAt(i) { return glyphs[i]; },
    };
  }
  if (format === 2) {
    const count = r.u16();
    const ranges = [];
    for (let i = 0; i < count; i++) ranges.push({ start: r.u16(), end: r.u16(), startIndex: r.u16() });
    return {
      count: ranges.length ? ranges[ranges.length - 1].startIndex + (ranges[ranges.length - 1].end - ranges[ranges.length - 1].start + 1) : 0,
      indexOf(gid) {
        let lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const rg = ranges[mid];
          if (rg.end < gid) lo = mid + 1;
          else if (rg.start > gid) hi = mid - 1;
          else return rg.startIndex + (gid - rg.start);
        }
        return -1;
      },
      gidAt(i) {
        for (const rg of ranges) {
          if (i >= rg.startIndex && i < rg.startIndex + (rg.end - rg.start + 1)) {
            return rg.start + (i - rg.startIndex);
          }
        }
        return -1;
      },
    };
  }
  throw new Error(`Coverage format ${format} not supported`);
}

export function parseClassDef(reader, offset) {
  const r = reader.sub(offset);
  const format = r.u16();
  if (format === 1) {
    const startGlyph = r.u16();
    const count = r.u16();
    const classes = [];
    for (let i = 0; i < count; i++) classes.push(r.u16());
    return { get: (gid) => (gid >= startGlyph && gid < startGlyph + count ? classes[gid - startGlyph] : 0) };
  }
  if (format === 2) {
    const count = r.u16();
    const ranges = [];
    for (let i = 0; i < count; i++) ranges.push({ start: r.u16(), end: r.u16(), cls: r.u16() });
    return {
      get(gid) {
        let lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const rg = ranges[mid];
          if (rg.end < gid) lo = mid + 1;
          else if (rg.start > gid) hi = mid - 1;
          else return rg.cls;
        }
        return 0;
      },
    };
  }
  throw new Error(`ClassDef format ${format} not supported`);
}

// ---------- value records ----------

const VF_X_PLACEMENT = 0x01;
const VF_Y_PLACEMENT = 0x02;
const VF_X_ADVANCE = 0x04;
const VF_Y_ADVANCE = 0x08;
const VF_X_PLA_DEVICE = 0x10;
const VF_Y_PLA_DEVICE = 0x20;
const VF_X_ADV_DEVICE = 0x40;
const VF_Y_ADV_DEVICE = 0x80;

function readValueRecord(r, valueFormat, subtableStart) {
  const v = { xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0, devices: null };
  if (valueFormat & VF_X_PLACEMENT) v.xPlacement = r.i16();
  if (valueFormat & VF_Y_PLACEMENT) v.yPlacement = r.i16();
  if (valueFormat & VF_X_ADVANCE) v.xAdvance = r.i16();
  if (valueFormat & VF_Y_ADVANCE) v.yAdvance = r.i16();
  const deviceOffsets = [];
  for (const bit of [VF_X_PLA_DEVICE, VF_Y_PLA_DEVICE, VF_X_ADV_DEVICE, VF_Y_ADV_DEVICE]) {
    if (valueFormat & bit) deviceOffsets.push(r.u16());
  }
  if (deviceOffsets.length) {
    v.devices = {};
    const keys = [];
    if (valueFormat & VF_X_PLA_DEVICE) keys.push("xPlacement");
    if (valueFormat & VF_Y_PLA_DEVICE) keys.push("yPlacement");
    if (valueFormat & VF_X_ADV_DEVICE) keys.push("xAdvance");
    if (valueFormat & VF_Y_ADV_DEVICE) keys.push("yAdvance");
    for (let i = 0; i < keys.length; i++) {
      const off = deviceOffsets[i];
      if (off === 0) continue;
      const dr = r.sub(subtableStart + off);
      const a = dr.u16(), b = dr.u16(), fmt = dr.u16();
      if (fmt === 0x8000) {
        // VariationIndex table: a = outer index, b = inner index.
        v.devices[keys[i]] = (a << 16) | b;
      }
      // DeltaFormat 1..3 are hinting device tables: not applied (like HarfBuzz).
    }
  }
  return v;
}

function valueRecordSize(valueFormat) {
  let n = 0;
  for (let bit = 1; bit <= 0x80; bit <<= 1) if (valueFormat & bit) n++;
  return n * 2;
}

function applyValue(v, varInstancer, out, glyphIndex) {
  // HarfBuzz keeps positions integral: each device delta is rounded (half up)
  // before being added to the static value.
  let dx = v.xPlacement, dy = v.yPlacement, dxa = v.xAdvance, dya = v.yAdvance;
  if (v.devices && varInstancer) {
    if (v.devices.xPlacement !== undefined) dx += otRound(varInstancer.delta(v.devices.xPlacement));
    if (v.devices.yPlacement !== undefined) dy += otRound(varInstancer.delta(v.devices.yPlacement));
    if (v.devices.xAdvance !== undefined) dxa += otRound(varInstancer.delta(v.devices.xAdvance));
    if (v.devices.yAdvance !== undefined) dya += otRound(varInstancer.delta(v.devices.yAdvance));
  }
  out.xPlacement[glyphIndex] += dx;
  out.yPlacement[glyphIndex] += dy;
  out.xAdvance[glyphIndex] += dxa;
  out.yAdvance[glyphIndex] += dya;
}

// ---------- subtables ----------

function parseSinglePos(reader, offset) {
  const r = reader.sub(offset);
  const format = r.u16();
  const coverageOffset = r.u16();
  const valueFormat = r.u16();
  const coverage = parseCoverage(reader, offset + coverageOffset);
  if (format === 1) {
    const value = readValueRecord(r, valueFormat, offset);
    return {
      applyAt(gid, varInstancer, out, glyphIndex) {
        if (coverage.indexOf(gid) < 0) return false;
        applyValue(value, varInstancer, out, glyphIndex);
        return true;
      },
    };
  }
  if (format === 2) {
    const count = r.u16();
    const values = [];
    for (let i = 0; i < count; i++) values.push(readValueRecord(r, valueFormat, offset));
    return {
      applyAt(gid, varInstancer, out, glyphIndex) {
        const idx = coverage.indexOf(gid);
        if (idx < 0 || idx >= values.length) return false;
        applyValue(values[idx], varInstancer, out, glyphIndex);
        return true;
      },
    };
  }
  throw new Error(`SinglePos format ${format} not supported`);
}

function parsePairPos(reader, offset) {
  const r = reader.sub(offset);
  const format = r.u16();
  const coverageOffset = r.u16();
  const valueFormat1 = r.u16();
  const valueFormat2 = r.u16();
  const coverage = parseCoverage(reader, offset + coverageOffset);

  if (format === 1) {
    const pairSetCount = r.u16();
    const pairSetOffsets = [];
    for (let i = 0; i < pairSetCount; i++) pairSetOffsets.push(r.u16());
    // Map: firstGid -> Map(secondGid -> [v1, v2])
    const pairs = new Map();
    for (let i = 0; i < pairSetCount; i++) {
      const firstGid = coverage.gidAt(i);
      if (firstGid < 0) continue;
      const pr = reader.sub(offset + pairSetOffsets[i]);
      const pairValueCount = pr.u16();
      const inner = new Map();
      for (let k = 0; k < pairValueCount; k++) {
        const secondGlyph = pr.u16();
        const v1 = readValueRecord(pr, valueFormat1, offset);
        const v2 = readValueRecord(pr, valueFormat2, offset);
        inner.set(secondGlyph, [v1, v2]);
      }
      pairs.set(firstGid, inner);
    }
    return {
      findPair(firstGid, secondGid) {
        const inner = pairs.get(firstGid);
        return inner ? inner.get(secondGid) ?? null : null;
      },
    };
  }

  if (format === 2) {
    const classDef1Offset = r.u16();
    const classDef2Offset = r.u16();
    const class1Count = r.u16();
    const class2Count = r.u16();
    const classDef1 = parseClassDef(reader, offset + classDef1Offset);
    const classDef2 = parseClassDef(reader, offset + classDef2Offset);
    const matrix = [];
    for (let c1 = 0; c1 < class1Count; c1++) {
      const row = [];
      for (let c2 = 0; c2 < class2Count; c2++) {
        const v1 = readValueRecord(r, valueFormat1, offset);
        const v2 = readValueRecord(r, valueFormat2, offset);
        row.push([v1, v2]);
      }
      matrix.push(row);
    }
    return {
      findPair(firstGid, secondGid) {
        if (coverage.indexOf(firstGid) < 0) return null;
        const c1 = classDef1.get(firstGid);
        const c2 = classDef2.get(secondGid);
        if (c1 >= class1Count || c2 >= class2Count) return null;
        const rec = matrix[c1][c2];
        const [v1, v2] = rec;
        const empty = (v) =>
          v.xPlacement === 0 && v.yPlacement === 0 && v.xAdvance === 0 && v.yAdvance === 0 && !v.devices;
        if (empty(v1) && empty(v2)) return null;
        return rec;
      },
    };
  }
  throw new Error(`PairPos format ${format} not supported`);
}

function parseChainedContextPos(reader, offset) {
  const r = reader.sub(offset);
  const format = r.u16();
  if (format !== 3) throw new Error(`ChainedContextPos format ${format} not supported`);
  const backtrackCount = r.u16();
  const backtrackOffsets = [];
  for (let i = 0; i < backtrackCount; i++) backtrackOffsets.push(r.u16());
  const inputCount = r.u16();
  const inputOffsets = [];
  for (let i = 0; i < inputCount; i++) inputOffsets.push(r.u16());
  const lookaheadCount = r.u16();
  const lookaheadOffsets = [];
  for (let i = 0; i < lookaheadCount; i++) lookaheadOffsets.push(r.u16());
  const posCount = r.u16();
  const records = [];
  for (let i = 0; i < posCount; i++) records.push({ sequenceIndex: r.u16(), lookupListIndex: r.u16() });
  return {
    backtrack: backtrackOffsets.map((o) => parseCoverage(reader, offset + o)),
    input: inputOffsets.map((o) => parseCoverage(reader, offset + o)),
    lookahead: lookaheadOffsets.map((o) => parseCoverage(reader, offset + o)),
    records,
  };
}

// ---------- lookups ----------

function parseLookup(reader, offset, lookupReaders) {
  const r = reader.sub(offset);
  const lookupType = r.u16();
  const lookupFlag = r.u16();
  const subTableCount = r.u16();
  const subTableOffsets = [];
  for (let i = 0; i < subTableCount; i++) subTableOffsets.push(r.u16());
  let markFilteringSet = null;
  if (lookupFlag & 0x10) markFilteringSet = r.u16();

  const subtables = subTableOffsets.map((o) => {
    const abs = offset + o;
    switch (lookupType) {
      case 1: return { kind: "single", data: parseSinglePos(reader, abs) };
      case 2: return { kind: "pair", data: parsePairPos(reader, abs) };
      case 8: return { kind: "chained", data: parseChainedContextPos(reader, abs) };
      case 9: {
        const er = reader.sub(abs);
        er.u16(); // format = 1
        const extType = er.u16();
        const extOffset = er.u32();
        return parseLookupSubtable(reader, abs + extOffset, extType);
      }
      default:
        return { kind: "unsupported", type: lookupType };
    }
  });

  return { lookupType, lookupFlag, markFilteringSet, subtables };
}

function parseLookupSubtable(reader, abs, type) {
  switch (type) {
    case 1: return { kind: "single", data: parseSinglePos(reader, abs) };
    case 2: return { kind: "pair", data: parsePairPos(reader, abs) };
    case 8: return { kind: "chained", data: parseChainedContextPos(reader, abs) };
    default: return { kind: "unsupported", type };
  }
}

// ---------- GDEF ----------

export function parseGdef(reader, tableOffset, axisTags) {
  const r = reader.sub(tableOffset);
  const major = r.u16();
  const minor = r.u16();
  const glyphClassDefOffset = r.u16();
  r.u16(); // attachListOffset
  r.u16(); // ligCaretListOffset
  const markAttachClassDefOffset = r.u16();
  let markGlyphSetsOffset = 0;
  let varStoreOffset = 0;
  if (minor >= 2) markGlyphSetsOffset = r.u16();
  if (minor >= 3) varStoreOffset = r.u32();

  const glyphClassDef = glyphClassDefOffset
    ? parseClassDef(reader, tableOffset + glyphClassDefOffset)
    : null;
  const markAttachClassDef = markAttachClassDefOffset
    ? parseClassDef(reader, tableOffset + markAttachClassDefOffset)
    : null;

  let markGlyphSets = null;
  if (markGlyphSetsOffset) {
    const mr = reader.sub(tableOffset + markGlyphSetsOffset);
    mr.u16(); // format
    const count = mr.u16();
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(mr.u32());
    markGlyphSets = offsets.map((o) =>
      o ? parseCoverage(reader, tableOffset + markGlyphSetsOffset + o) : null
    );
  }

  const varStore = varStoreOffset
    ? parseItemVariationStore(reader, tableOffset + varStoreOffset, axisTags)
    : null;

  return { glyphClassDef, markAttachClassDef, markGlyphSets, varStore };
}

// ---------- GPOS ----------

export class GposTable {
  constructor(reader, tableOffset, gdef, axisTags) {
    this.gdef = gdef;
    const r = reader.sub(tableOffset);
    r.u16(); // major
    r.u16(); // minor
    const scriptListOffset = r.u16();
    const featureListOffset = r.u16();
    const lookupListOffset = r.u16();

    // Scripts: tag -> default langsys feature indices.
    const scripts = new Map();
    const sr = reader.sub(tableOffset + scriptListOffset);
    const scriptCount = sr.u16();
    for (let i = 0; i < scriptCount; i++) {
      const tag = sr.tag();
      const scriptOffset = sr.u16();
      const scr = reader.sub(tableOffset + scriptListOffset + scriptOffset);
      const defaultLangSysOffset = scr.u16();
      if (defaultLangSysOffset) {
        const lr = reader.sub(tableOffset + scriptListOffset + scriptOffset + defaultLangSysOffset);
        lr.u16(); // lookupOrder
        lr.u16(); // reqFeatureIndex
        const count = lr.u16();
        const indices = [];
        for (let k = 0; k < count; k++) indices.push(lr.u16());
        scripts.set(tag, indices);
      } else {
        scripts.set(tag, []);
      }
    }

    // Features: index -> {tag, lookupIndices}
    const features = [];
    const fr = reader.sub(tableOffset + featureListOffset);
    const featureCount = fr.u16();
    for (let i = 0; i < featureCount; i++) {
      const tag = fr.tag();
      const featureOffset = fr.u16();
      const fr2 = reader.sub(tableOffset + featureListOffset + featureOffset);
      fr2.u16(); // params
      const count = fr2.u16();
      const lookupIndices = [];
      for (let k = 0; k < count; k++) lookupIndices.push(fr2.u16());
      features.push({ tag, lookupIndices });
    }

    // Lookups.
    const lr = reader.sub(tableOffset + lookupListOffset);
    const lookupCount = lr.u16();
    const lookupOffsets = [];
    for (let i = 0; i < lookupCount; i++) lookupOffsets.push(lr.u16());
    this.lookups = lookupOffsets.map((o) => parseLookup(reader, tableOffset + lookupListOffset + o));

    // Collect 'kern' feature lookups for DFLT and latn (feature order, deduped).
    const kernIndices = [];
    for (const scriptTag of ["DFLT", "latn"]) {
      const featureIndices = scripts.get(scriptTag) ?? [];
      for (const fi of featureIndices) {
        const feat = features[fi];
        if (feat && feat.tag === "kern") {
          for (const li of feat.lookupIndices) {
            if (!kernIndices.includes(li)) kernIndices.push(li);
          }
        }
      }
    }
    this.kernLookups = kernIndices.map((i) => this.lookups[i]).filter(Boolean);
    this.axisTags = axisTags;
  }

  glyphProps(gid) {
    if (!this.gdef?.glyphClassDef) return 0;
    const cls = this.gdef.glyphClassDef.get(gid);
    if (cls === 1) return 0x02; // base
    if (cls === 2) return 0x04; // ligature
    if (cls === 3) return 0x08; // mark
    return 0;
  }

  // HarfBuzz check_glyph_property.
  checkGlyph(gid, lookup) {
    const props = this.glyphProps(gid);
    const flags = lookup.lookupFlag;
    if (props & flags & 0x000e) return false;
    if (flags & 0x10) {
      if (!(props & 0x08)) return false;
      const sets = this.gdef?.markGlyphSets;
      if (sets && lookup.markFilteringSet !== null) {
        const cov = sets[lookup.markFilteringSet];
        if (cov && cov.indexOf(gid) < 0) return false;
      }
    }
    if (flags & 0xff00) {
      if (props & 0x08) {
        const attach = this.gdef?.markAttachClassDef?.get(gid) ?? 0;
        if (attach !== (flags >> 8)) return false;
      }
    }
    return true;
  }

  nextRelevant(gids, from, lookup) {
    let i = from;
    while (i < gids.length && !this.checkGlyph(gids[i], lookup)) i++;
    return i < gids.length ? i : -1;
  }

  prevRelevant(gids, from, lookup) {
    let i = from;
    while (i >= 0 && !this.checkGlyph(gids[i], lookup)) i--;
    return i;
  }

  // Apply all kern lookups to the glyph run. gids: number[].
  // Returns {xAdvance, xPlacement, yPlacement, yAdvance} arrays (font units).
  applyKerning(gids, varInstancer) {
    const n = gids.length;
    const out = {
      xAdvance: new Float64Array(n),
      xPlacement: new Float64Array(n),
      yPlacement: new Float64Array(n),
      yAdvance: new Float64Array(n),
    };

    for (const lookup of this.kernLookups) {
      let idx = 0;
      while (idx >= 0 && idx < n) {
        if (!this.checkGlyph(gids[idx], lookup)) {
          idx++;
          continue;
        }
        const result = this.applyLookupAt(lookup, gids, idx, varInstancer, out);
        if (result === null) idx++;
        else idx = result; // pair: second glyph pos; chained: end of input; single: idx+1
      }
    }
    return out;
  }

  // Returns next scan index, or null if the lookup did not apply at idx.
  applyLookupAt(lookup, gids, idx, varInstancer, out) {
    for (const sub of lookup.subtables) {
      if (sub.kind === "single") {
        if (sub.data.applyAt(gids[idx], varInstancer, out, idx)) return idx + 1;
      } else if (sub.kind === "pair") {
        const next = this.nextRelevant(gids, idx + 1, lookup);
        if (next < 0) return null;
        const rec = sub.data.findPair(gids[idx], gids[next]);
        if (rec) {
          applyValue(rec[0], varInstancer, out, idx);
          if (rec[1]) applyValue(rec[1], varInstancer, out, next);
          return next;
        }
      } else if (sub.kind === "chained") {
        const end = this.matchChained(sub.data, gids, idx, lookup);
        if (end !== null) {
          for (const rec of sub.data.records) {
            const pos = this.inputPosition(sub.data, gids, idx, lookup, rec.sequenceIndex);
            if (pos === null) continue;
            const nested = this.lookups[rec.lookupListIndex];
            if (nested) this.applyNestedOnce(nested, gids, pos, varInstancer, out);
          }
          return end;
        }
      }
    }
    return null;
  }

  // Position of the k-th relevant glyph from idx (0 = idx itself).
  inputPosition(chain, gids, idx, lookup, k) {
    let pos = idx;
    for (let i = 0; i < k; i++) {
      pos = this.nextRelevant(gids, pos + 1, lookup);
      if (pos < 0) return null;
    }
    return pos;
  }

  matchChained(chain, gids, idx, lookup) {
    // Input sequence: chain.input[0] matches glyph at idx.
    const inputPositions = [idx];
    if (chain.input[0].indexOf(gids[idx]) < 0) return null;
    let pos = idx;
    for (let i = 1; i < chain.input.length; i++) {
      pos = this.nextRelevant(gids, pos + 1, lookup);
      if (pos < 0 || chain.input[i].indexOf(gids[pos]) < 0) return null;
      inputPositions.push(pos);
    }
    // Backtrack: chain.backtrack[0] is the glyph immediately before idx.
    let bpos = idx;
    for (let i = 0; i < chain.backtrack.length; i++) {
      bpos = this.prevRelevant(gids, bpos - 1, lookup);
      if (bpos < 0 || chain.backtrack[i].indexOf(gids[bpos]) < 0) return null;
    }
    // Lookahead after last input glyph.
    let lpos = inputPositions[inputPositions.length - 1];
    for (let i = 0; i < chain.lookahead.length; i++) {
      lpos = this.nextRelevant(gids, lpos + 1, lookup);
      if (lpos < 0 || chain.lookahead[i].indexOf(gids[lpos]) < 0) return null;
    }
    // HarfBuzz continues scanning right after the matched input sequence.
    return inputPositions[inputPositions.length - 1] + 1;
  }

  applyNestedOnce(lookup, gids, pos, varInstancer, out) {
    for (const sub of lookup.subtables) {
      if (sub.kind === "single") {
        if (sub.data.applyAt(gids[pos], varInstancer, out, pos)) return;
      } else if (sub.kind === "pair") {
        const next = this.nextRelevant(gids, pos + 1, lookup);
        if (next < 0) return;
        const rec = sub.data.findPair(gids[pos], gids[next]);
        if (rec) {
          applyValue(rec[0], varInstancer, out, pos);
          if (rec[1]) applyValue(rec[1], varInstancer, out, next);
          return;
        }
      }
    }
  }
}

// ---------- legacy kern table ----------

export function parseKern(reader, tableOffset) {
  const r = reader.sub(tableOffset);
  const version = r.u16();
  const pairs = new Map(); // (left << 16) | right -> value
  if (version !== 0) return { pairs }; // kern v1 (Apple) unsupported
  const nTables = r.u16();
  for (let t = 0; t < nTables; t++) {
    r.u16(); // subtable version
    const length = r.u16();
    const coverage = r.u16();
    const format = coverage >> 8;
    const horizontal = (coverage & 1) !== 0;
    if (format === 0 && horizontal) {
      const nPairs = r.u16();
      r.skip(6); // searchRange, entrySelector, rangeShift
      for (let i = 0; i < nPairs; i++) {
        const left = r.u16();
        const right = r.u16();
        const value = r.i16();
        pairs.set((left << 16) | right, value);
      }
    } else {
      r.seek(r.tell() - 6 + length - 6);
    }
  }
  return { pairs };
}
