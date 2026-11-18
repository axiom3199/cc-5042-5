// fvar (axes + named instances), avar (axis value mapping), and the
// normalization pipeline: user coords -> clamped -> [-1,1] -> avar-mapped.

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

function piecewiseLinearMap(value, segs) {
  if (!segs || segs.length === 0) return value;
  if (value <= segs[0].from) return segs[0].to;
  if (value >= segs[segs.length - 1].from) return segs[segs.length - 1].to;
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    if (value >= a.from && value <= b.from) {
      if (b.from === a.from) return a.to;
      const t = (value - a.from) / (b.from - a.from);
      return a.to + t * (b.to - a.to);
    }
  }
  return value;
}

// Mirrors fontTools.models.normalizeLocation: clamp to [min,max], then scale
// to [-1,1] around the default. Returns {clamped, normalized}.
export function normalizeLocation(location, axes) {
  const clamped = {};
  const normalized = {};
  for (const axis of axes) {
    let v = location[axis.tag];
    if (typeof v !== "number" || Number.isNaN(v)) v = axis.default;
    v = Math.min(axis.max, Math.max(axis.min, v));
    clamped[axis.tag] = v;
    let n;
    if (v < axis.default) {
      n = axis.default === axis.min ? 0 : (v - axis.default) / (axis.default - axis.min);
    } else if (v > axis.default) {
      n = axis.max === axis.default ? 0 : (v - axis.default) / (axis.max - axis.default);
    } else {
      n = 0;
    }
    normalized[axis.tag] = Math.max(-1, Math.min(1, n));
  }
  return { clamped, normalized };
}

export function applyAvar(normalized, axes, avar) {
  if (!avar) return { ...normalized };
  const out = {};
  for (let i = 0; i < axes.length; i++) {
    const tag = axes[i].tag;
    const v = normalized[tag] ?? 0;
    out[tag] = piecewiseLinearMap(v, avar.segments.get(i));
  }
  return out;
}
