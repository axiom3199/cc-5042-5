// fvar (axes + named instances) and avar (axis value mapping) table parsing.
// The normalization/avar pipeline lives in axes.js (AxisSpace), which owns
// the shared range validation used by every entry point.

export function parseFvar(reader, tableOffset, nameTable) {
  const r = reader.sub(tableOffset);
  r.u16(); // majorVersion
  r.u16(); // minorVersion
  const axesArrayOffset = r.u16();
  r.u16(); // reserved
  const axisCount = r.u16();
  const axisSize = r.u16();
  const instanceCount = r.u16();
  const instanceSize = r.u16();

  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const ar = reader.sub(tableOffset + axesArrayOffset + i * axisSize);
    const tag = ar.tag();
    const min = ar.fixed();
    const def = ar.fixed();
    const max = ar.fixed();
    const flags = ar.u16();
    const nameID = ar.u16();
    axes.push({
      tag,
      min,
      default: def,
      max,
      flags,
      nameID,
      name: nameTable?.get(nameID) ?? tag,
      hidden: (flags & 1) !== 0,
    });
  }

  const instances = [];
  for (let i = 0; i < instanceCount; i++) {
    const ir = reader.sub(tableOffset + axesArrayOffset + axisCount * axisSize + i * instanceSize);
    const subfamilyNameID = ir.u16();
    ir.u16(); // flags
    const coords = {};
    for (const axis of axes) coords[axis.tag] = ir.fixed();
    instances.push({
      name: nameTable?.get(subfamilyNameID) ?? `instance ${i}`,
      coords,
    });
  }

  return { axes, instances };
}

export function parseAvar(reader, tableOffset) {
  const r = reader.sub(tableOffset);
  r.u16(); // majorVersion
  r.u16(); // minorVersion
  r.u16(); // reserved
  const axisCount = r.u16();
  const segments = new Map(); // axisIndex -> [{from, to}...]
  for (let axis = 0; axis < axisCount; axis++) {
    const count = r.u16();
    const segs = [];
    for (let i = 0; i < count; i++) {
      segs.push({ from: r.f2dot14(), to: r.f2dot14() });
    }
    segs.sort((a, b) => a.from - b.from);
    segments.set(axis, segs);
  }
  return { segments };
}
