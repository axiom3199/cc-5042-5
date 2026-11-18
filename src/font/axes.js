// Axis interface: one place that owns the fvar ranges, avar mapping and the
// user -> clamped -> normalized pipeline. Every entry point (Font.shape,
// FontSet.shape, layoutPoster, the axis controls) resolves coordinates
// through AxisSpace, so range validation cannot drift between them.
//
// Nothing here evaluates outlines or positions glyphs; it only answers:
// which axes exist, what is a valid user value, and what is the normalized
// location used to key the glyph caches.

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

export class AxisSpace {
  constructor(axes = [], { avar = null, instances = [] } = {}) {
    this.axes = axes;
    this.axisTags = axes.map((a) => a.tag);
    this.byTag = new Map(axes.map((a) => [a.tag, a]));
    this.avar = avar;
    this.instances = instances;
  }

  get isVariable() {
    return this.axes.length > 0;
  }

  hasAxis(tag) {
    return this.byTag.has(tag);
  }

  axis(tag) {
    return this.byTag.get(tag) ?? null;
  }

  // Validate one user value against the font's declared range. This is the
  // only range check in the system: the UI and Font.shape both use it.
  // `valid` is false only when the value could not be used as a number;
  // finite out-of-range values are usable but reported via `clamped`.
  validateValue(tag, raw) {
    const axis = this.byTag.get(tag);
    if (!axis) {
      return { tag, raw, supported: false, valid: false, value: raw, reason: "unsupported-axis" };
    }
    if (raw === undefined || raw === null) {
      return { tag, raw, supported: true, valid: true, value: axis.default, reason: "default", clamped: false };
    }
    if (typeof raw !== "number") {
      return { tag, raw, supported: true, valid: false, value: axis.default, reason: "not-a-number", clamped: true };
    }
    if (Number.isNaN(raw)) {
      return { tag, raw, supported: true, valid: false, value: axis.default, reason: "nan", clamped: true };
    }
    if (!Number.isFinite(raw)) {
      const value = raw > 0 ? axis.max : axis.min;
      return { tag, raw, supported: true, valid: false, value, reason: "non-finite", clamped: true };
    }
    const value = Math.min(axis.max, Math.max(axis.min, raw));
    return {
      tag,
      raw,
      supported: true,
      valid: true,
      value,
      reason: value === raw ? "in-range" : "out-of-range",
      clamped: value !== raw,
    };
  }

  // Resolve a complete user location. The result keeps unsupported axes and
  // unusable values visible instead of folding them silently into defaults:
  //   clamped     supported user values after range clamping
  //   normalized  post-avar coords in [-1,1] (glyph/layout cache key input)
  //   unsupported axes this font does not declare
  //   invalid     values replaced by a default/endpoint, with the reason
  //   adjusted    finite values that were clamped into range
  resolve(userLocation = {}) {
    const user = userLocation ?? {};
    const requested = {};
    const supported = {};
    const unsupported = [];
    const invalid = [];
    const adjusted = [];

    for (const [tag, raw] of Object.entries(user)) {
      requested[tag] = raw;
      const check = this.validateValue(tag, raw);
      if (!check.supported) {
        unsupported.push(tag);
        continue;
      }
      if (!check.valid) {
        invalid.push({ tag, raw, reason: check.reason, applied: check.value });
      } else if (check.clamped) {
        adjusted.push({ tag, raw, reason: check.reason, applied: check.value });
      }
      supported[tag] = check.value;
    }

    const { clamped, normalized } = normalizeLocation(supported, this.axes);
    const mapped = applyAvar(normalized, this.axes, this.avar);
    return { requested, clamped, normalized: mapped, unsupported, invalid, adjusted };
  }

  // Cache key for a normalized location. Only coordinates declared by this
  // font participate, in a stable order.
  locationKey(normalized) {
    return this.axisTags.map((t) => (normalized[t] ?? 0).toFixed(6)).join(",");
  }
}
