// Compatibility adapter for the pre-decoupling entries and for poster state
// saved by older versions. The strict AxisSpace reports numeric strings as
// invalid (so bad input is never silently masked); old posters, however, may
// carry axis values as strings or under legacy keys. Migration is explicit,
// confined to this adapter, and then re-validated through the normal axis
// pipeline — the variable-font engine itself stays strict.

import { layoutPoster } from "./layout.js";

const LEGACY_LOCATION_KEYS = ["axes", "variations", "location"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Accept a numeric string as an old poster value. Everything else is passed
// through untouched so AxisSpace can reject it with a reason.
function coerceLegacyValue(value) {
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

// Old posters stored the axis map directly, or nested it under one of a few
// legacy keys. Returns a plain {tag: value} map; unknown shapes yield {}.
export function migrateLegacyLocation(source) {
  if (!isPlainObject(source)) return {};
  let map = source;
  for (const key of LEGACY_LOCATION_KEYS) {
    if (isPlainObject(source[key])) {
      map = source[key];
      break;
    }
  }
  const out = {};
  for (const [tag, value] of Object.entries(map)) {
    out[tag] = coerceLegacyValue(value);
  }
  return out;
}

// Read a saved poster state from an older version. Only fields the poster
// actually needs are migrated; unknown fields are ignored rather than
// copied into the current state.
export function readLegacyPosterState(state = {}) {
  const location = migrateLegacyLocation(
    state.location ?? state.axes ?? state.variations ?? {}
  );
  return {
    text: typeof state.text === "string" ? state.text : "",
    location,
    options: {
      fontSize: state.fontSize,
      lineHeightFactor: state.lineHeightFactor,
      letterSpacing: state.letterSpacing,
      align: state.align,
    },
  };
}

// The old combined axis-layout entry. It still resolves the location through
// the shared AxisSpace (via FontSet/layoutPoster) after migrating legacy
// values; results keep the original result shape.
export function layoutLegacyPoster(fontSet, text, legacyLocation, options = {}) {
  return layoutPoster(fontSet, text, migrateLegacyLocation(legacyLocation), options);
}

// Legacy single-font normalize entry: same three fields the old Font.normalize
// returned, with the new diagnostics passed through additively.
export function normalizeLegacyLocation(font, legacyLocation = {}) {
  const resolved = font.normalize(migrateLegacyLocation(legacyLocation));
  return {
    clamped: resolved.clamped,
    normalized: resolved.normalized,
    unsupported: resolved.unsupported,
    invalid: resolved.invalid,
    adjusted: resolved.adjusted,
  };
}
