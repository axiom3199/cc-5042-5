// ItemVariationStore (shared by HVAR / GDEF / MVAR) + DeltaSetIndexMap,
// and the OpenType region scalar function (same semantics as
// fontTools.varLib.models.supportScalar with ot=True).

export function supportScalar(location, support) {
  // support: Map tag -> [lower, peak, upper]
  let scalar = 1;
  for (const [axis, [lower, peak, upper]] of support) {
    if (peak === 0) continue;
    if (lower > peak || peak > upper) continue;
    if (lower < 0 && upper > 0) continue;
    const v = location[axis] ?? 0;
    if (v === peak) continue;
    if (v <= lower || upper <= v) return 0;
    if (v < peak) scalar *= (v - lower) / (peak - lower);
    else scalar *= (v - upper) / (peak - upper);
  }
  return scalar;
}

export function parseItemVariationStore(reader, storeOffset, axisTags) {
  const r = reader.sub(storeOffset);
  const format = r.u16();
  if (format !== 1) throw new Error(`Unsupported ItemVariationStore format ${format}`);
  const regionListOffset = r.u32();
  const varDataCount = r.u16();
  const varDataOffsets = [];
  for (let i = 0; i < varDataCount; i++) varDataOffsets.push(r.u32());

  const rl = reader.sub(storeOffset + regionListOffset);
  const axisCount = rl.u16();
  const regionCount = rl.u16();
  const regions = [];
  for (let i = 0; i < regionCount; i++) {
    const start = [], peak = [], end = [];
    const support = new Map();
    for (let a = 0; a < axisCount; a++) {
      const s = rl.f2dot14(), p = rl.f2dot14(), e = rl.f2dot14();
      start.push(s); peak.push(p); end.push(e);
      if (s !== 0 || p !== 0 || e !== 0) support.set(axisTags[a], [s, p, e]);
    }
    regions.push({ start, peak, end, support });
  }

  const varData = [];
  for (let i = 0; i < varDataCount; i++) {
    const vd = reader.sub(storeOffset + varDataOffsets[i]);
    const itemCount = vd.u16();
    const numShortsRaw = vd.u16();
    const longWords = (numShortsRaw & 0x8000) !== 0;
    const wordCount = numShortsRaw & 0x7fff;
    const regionIndexCount = vd.u16();
    const regionIndexes = [];
    for (let j = 0; j < regionIndexCount; j++) regionIndexes.push(vd.u16());
    const items = [];
    for (let item = 0; item < itemCount; item++) {
      const row = [];
      const bigCount = Math.min(regionIndexCount, wordCount);
      const smallCount = Math.max(regionIndexCount, wordCount) - bigCount;
      for (let j = 0; j < bigCount; j++) row.push(longWords ? vd.i32() : vd.i16());
      for (let j = 0; j < smallCount; j++) row.push(longWords ? vd.i16() : vd.i8());
      row.length = regionIndexCount; // drop padding when wordCount > regionIndexCount
      items.push(row);
    }
    varData.push({ itemCount, regionIndexes, items });
  }

  return { regions, varData };
}

export class VarStoreInstancer {
  constructor(store, location) {
    this.store = store;
    this.scalars = store.regions.map((region) => supportScalar(location, region.support));
  }

  // varIdx: (outer << 16) | inner. NO_VARIATION_INDEX = 0xFFFFFFFF.
  delta(varIdx) {
    if (varIdx === 0xffffffff) return 0;
    const outer = varIdx >>> 16;
    const inner = varIdx & 0xffff;
    const vd = this.store.varData[outer];
    if (!vd || inner >= vd.items.length) return 0;
    const row = vd.items[inner];
    let d = 0;
    for (let j = 0; j < vd.regionIndexes.length; j++) {
      const s = this.scalars[vd.regionIndexes[j]];
      if (s !== 0) d += row[j] * s;
    }
    return d;
  }
}

export function parseDeltaSetIndexMap(reader, mapOffset) {
  const r = reader.sub(mapOffset);
  const format = r.u8();
  const entryFormat = r.u8();
  const count = format === 0 ? r.u16() : r.u32();
  const innerBits = 1 + (entryFormat & 0x0f);
  const innerMask = (1 << innerBits) - 1;
  const entrySize = 1 + ((entryFormat & 0x30) >> 4);
  const map = [];
  for (let i = 0; i < count; i++) {
    let raw;
    if (entrySize === 1) raw = r.u8();
    else if (entrySize === 2) raw = r.u16();
    else if (entrySize === 3) raw = r.u24();
    else raw = r.u32();
    map.push(((raw >>> innerBits) << 16) | (raw & innerMask));
  }
  return map;
}
