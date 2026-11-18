// name table parsing with platform-aware decoding.
const utf16 = new TextDecoder("utf-16be");
let mac = null;
try {
  mac = new TextDecoder("macintosh");
} catch {
  mac = null; // very old Node without full ICU; ASCII still works via latin1 fallback
}
const latin1 = new TextDecoder("latin1");

function decode(recordBytes, platformID) {
  if (platformID === 0 || platformID === 3) return utf16.decode(recordBytes);
  if (platformID === 1 && mac) return mac.decode(recordBytes);
  return latin1.decode(recordBytes);
}

export function parseName(reader, tableOffset) {
  const r = reader.sub(tableOffset);
  r.u16(); // format
  const count = r.u16();
  const stringOffset = r.u16();
  const entries = new Map(); // nameID -> Map("plat/enc/lang" -> string)
  for (let i = 0; i < count; i++) {
    const platformID = r.u16();
    const encodingID = r.u16();
    const languageID = r.u16();
    const nameID = r.u16();
    const length = r.u16();
    const offset = r.u16();
    const bytes = new Uint8Array(
      reader.v.buffer,
      reader.v.byteOffset + tableOffset + stringOffset + offset,
      length
    );
    const value = decode(bytes, platformID);
    if (!entries.has(nameID)) entries.set(nameID, new Map());
    entries.get(nameID).set(`${platformID}/${encodingID}/${languageID}`, value);
  }

  function get(nameID, { lang = null } = {}) {
    const variants = entries.get(nameID);
    if (!variants) return null;
    const wanted = [];
    if (lang) {
      // Windows zh / en preferences first when a language is requested.
      const langLower = lang.toLowerCase();
      for (const [key, value] of variants) {
        if (key.startsWith("3/") && key.toLowerCase().endsWith(langLower)) wanted.push(value);
      }
    }
    for (const [key, value] of variants) {
      if (key === "3/1/1033" || key.startsWith("0/")) wanted.push(value);
    }
    for (const value of variants.values()) wanted.push(value);
    return wanted[0] ?? null;
  }

  return { get, entries };
}
