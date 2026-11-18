// sfnt container parsing: single fonts and TrueType collections.
export function openSfnt(reader, collectionIndex = 0) {
  const firstTag = reader.tag();
  if (firstTag === "ttcf") {
    reader.u32(); // version
    const numFonts = reader.u32();
    if (collectionIndex >= numFonts) throw new Error(`TTC has ${numFonts} fonts`);
    reader.seek(12 + collectionIndex * 4);
    reader.seek(reader.u32());
  } else {
    reader.seek(0);
  }

  const sfntVersion = reader.tag();
  if (!["\x00\x01\x00\x00", "OTTO", "true", "typ1"].includes(sfntVersion)) {
    throw new Error(`Unsupported sfnt version: ${JSON.stringify(sfntVersion)}`);
  }
  const numTables = reader.u16();
  reader.skip(6); // searchRange, entrySelector, rangeShift
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const tag = reader.tag();
    const checksum = reader.u32();
    const offset = reader.u32();
    const length = reader.u32();
    tables.set(tag, { offset, length, checksum });
  }
  return { sfntVersion, tables };
}

export function tableReader(reader, tables, tag, required = true) {
  const rec = tables.get(tag);
  if (!rec) {
    if (required) throw new Error(`Missing required table: ${tag}`);
    return null;
  }
  return reader.sub(rec.offset);
}
