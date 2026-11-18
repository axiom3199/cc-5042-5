// hhea / hmtx / HVAR / MVAR: horizontal metrics and their variation deltas.

import { parseItemVariationStore, parseDeltaSetIndexMap } from "./varstore.js";

export function parseHhea(reader, tableOffset) {
  const r = reader.sub(tableOffset);
  r.u32(); // version
  const ascent = r.i16();
  const descent = r.i16();
  const lineGap = r.i16();
  r.skip(24);
  const numberOfHMetrics = r.u16();
  return { ascent, descent, lineGap, numberOfHMetrics };
}

export function parseHmtx(reader, tableOffset, numberOfHMetrics, numGlyphs) {
  const r = reader.sub(tableOffset);
  const advances = [];
  const lsbs = [];
  let lastAdvance = 0;
  for (let i = 0; i < numberOfHMetrics; i++) {
    lastAdvance = r.u16();
    advances.push(lastAdvance);
    lsbs.push(r.i16());
  }
  for (let i = numberOfHMetrics; i < numGlyphs; i++) {
    advances.push(lastAdvance);
    lsbs.push(r.i16());
  }
  return { advances, lsbs };
}

export function parseHvar(reader, tableOffset, axisTags) {
  const r = reader.sub(tableOffset);
  r.u16(); // majorVersion
  r.u16(); // minorVersion
  const varStoreOffset = r.u32();
  const advWidthMapOffset = r.u32();
  r.u32(); // lsbMapOffset
  r.u32(); // rsbMapOffset
  const store = parseItemVariationStore(reader, tableOffset + varStoreOffset, axisTags);
  const advWidthMap = advWidthMapOffset
    ? parseDeltaSetIndexMap(reader, tableOffset + advWidthMapOffset)
    : null;
  return {
    store,
    varIdxFor(gid) {
      return advWidthMap ? advWidthMap[gid] : gid;
    },
  };
}

export function parseMvar(reader, tableOffset, axisTags) {
  const r = reader.sub(tableOffset);
  r.u16(); // majorVersion
  r.u16(); // minorVersion
  r.u16(); // reserved
  const valueRecordSize = r.u16();
  const valueRecordCount = r.u16();
  const itemVariationStoreOffset = r.u16();
  const records = [];
  for (let i = 0; i < valueRecordCount; i++) {
    const rec = reader.sub(tableOffset + 10 + i * valueRecordSize);
    const tag = rec.tag();
    const outer = rec.u16();
    const inner = rec.u16();
    records.push({ tag, varIdx: (outer << 16) | inner });
  }
  const store = parseItemVariationStore(reader, tableOffset + itemVariationStoreOffset, axisTags);
  return { records, store };
}
