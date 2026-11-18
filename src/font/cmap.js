// cmap parsing (formats 4 and 12) and codepoint -> glyph id lookup.

function parseFormat4(r, offset) {
  r.seek(offset);
  const length = r.u16();
  r.u16(); // language
  const segCount = r.u16() / 2;
  r.skip(6); // searchRange, entrySelector, rangeShift
  const endCodes = [];
  for (let i = 0; i < segCount; i++) endCodes.push(r.u16());
  r.u16(); // reservedPad
  const startCodes = [];
  for (let i = 0; i < segCount; i++) startCodes.push(r.u16());
  const idDeltas = [];
  for (let i = 0; i < segCount; i++) idDeltas.push(r.i16());
  const idRangeOffsetPos = r.tell();
  const idRangeOffsets = [];
  for (let i = 0; i < segCount; i++) idRangeOffsets.push(r.u16());

  return {
    format: 4,
    lookup(cp, reader) {
      if (cp > 0xffff) return 0;
      let lo = 0, hi = segCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (endCodes[mid] < cp) lo = mid + 1;
        else if (startCodes[mid] > cp) hi = mid - 1;
        else {
          const ro = idRangeOffsets[mid];
          if (ro === 0) return (cp + idDeltas[mid]) & 0xffff;
          const glyphPos = idRangeOffsetPos + mid * 2 + ro + (cp - startCodes[mid]) * 2;
          if (glyphPos + 2 > offset + length) return 0;
          const gid = reader.v.getUint16(glyphPos);
          return gid === 0 ? 0 : (gid + idDeltas[mid]) & 0xffff;
        }
      }
      return 0;
    },
  };
}

function parseFormat12(r, offset) {
  r.seek(offset + 2); // skip format
  r.u16(); // reserved
  r.u32(); // length
  r.u32(); // language
  const nGroups = r.u32();
  const groups = [];
  for (let i = 0; i < nGroups; i++) {
    groups.push({ start: r.u32(), end: r.u32(), startGid: r.u32() });
  }
  return {
    format: 12,
    lookup(cp) {
      let lo = 0, hi = groups.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = groups[mid];
        if (g.end < cp) lo = mid + 1;
        else if (g.start > cp) hi = mid - 1;
        else return g.startGid + (cp - g.start);
      }
      return 0;
    },
  };
}

export function parseCmap(reader, tableOffset) {
  const r = reader.sub(tableOffset);
  r.u16(); // version
  const numTables = r.u16();
  const subtables = [];
  for (let i = 0; i < numTables; i++) {
    const platformID = r.u16();
    const encodingID = r.u16();
    const offset = r.u32();
    const abs = tableOffset + offset;
    const format = reader.v.getUint16(abs);
    subtables.push({ platformID, encodingID, format, offset: abs });
  }

  // Preference: full-repertoire format 12, then Unicode BMP format 4.
  const rank = (s) => {
    if (s.format === 12 && ((s.platformID === 3 && s.encodingID === 10) || s.platformID === 0)) return 0;
    if (s.format === 12) return 1;
    if (s.format === 4 && ((s.platformID === 3 && (s.encodingID === 1 || s.encodingID === 0)) || s.platformID === 0)) return 2;
    if (s.format === 4) return 3;
    return 4;
  };
  subtables.sort((a, b) => rank(a) - rank(b));

  let chosen = null;
  for (const s of subtables) {
    if (s.format === 12) { chosen = parseFormat12(reader, s.offset); break; }
    if (s.format === 4) { chosen = parseFormat4(reader, s.offset); break; }
  }
  if (!chosen) throw new Error("cmap: no supported subtable (format 4/12)");

  return {
    format: chosen.format,
    glyphIdFor(cp) {
      return chosen.lookup(cp, reader) | 0;
    },
  };
}
