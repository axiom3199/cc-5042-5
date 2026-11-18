// Font: parses the sfnt tables and exposes the high-level facade. Axis
// resolution lives in axes.js, glyph/outline/advance evaluation in glyph.js,
// and neighbour-dependent shaping in shaping.js. This file only wires them
// together; keep it free of variation math.

import { Reader } from "./reader.js";
import { openSfnt, tableReader } from "./sfnt.js";
import { parseCmap } from "./cmap.js";
import { parseName } from "./name.js";
import { parseFvar, parseAvar } from "./fvar.js";
import { AxisSpace } from "./axes.js";
import { GvarTable } from "./gvar.js";
import { GlyfTable } from "./glyf.js";
import { parseHhea, parseHmtx, parseHvar, parseMvar } from "./metrics.js";
import { GposTable, parseGdef, parseKern } from "./gpos.js";
import { GlyphEvaluator } from "./glyph.js";
import { shapeRun } from "./shaping.js";

export class Font {
  constructor(buffer, { collectionIndex = 0 } = {}) {
    const reader = Reader.from(buffer);
    const { tables } = openSfnt(reader, collectionIndex);
    this.reader = reader;
    this.tables = tables;

    // head
    const head = tableReader(reader, tables, "head");
    head.skip(18);
    this.unitsPerEm = head.u16();
    head.seek(50);
    this.indexToLocFormat = head.i16();

    // maxp / loca / glyf
    const maxpRec = tables.get("maxp");
    const locaRec = tables.get("loca");
    const glyfRec = tables.get("glyf");
    const { offsets: locaOffsets, numGlyphs } = GlyfTable.parseLoca(
      reader,
      tables.get("head").offset,
      maxpRec.offset,
      locaRec.offset
    );
    this.numGlyphs = numGlyphs;
    this.glyf = new GlyfTable(reader, glyfRec.offset, locaOffsets);

    // metrics
    this.hhea = parseHhea(reader, tables.get("hhea").offset);
    this.hmtx = parseHmtx(reader, tables.get("hmtx").offset, this.hhea.numberOfHMetrics, numGlyphs);

    // cmap / name
    this.cmap = parseCmap(reader, tables.get("cmap").offset);
    this.name = parseName(reader, tables.get("name").offset);

    // variations
    const fvarRec = tables.get("fvar");
    this.isVariable = !!fvarRec;
    this.instances = [];
    this.axes = [];
    let avar = null;
    if (fvarRec) {
      const fvar = parseFvar(reader, fvarRec.offset, this.name);
      this.axes = fvar.axes;
      this.instances = fvar.instances;
      const avarRec = tables.get("avar");
      if (avarRec) avar = parseAvar(reader, avarRec.offset);
    }
    this.axisSpace = new AxisSpace(this.axes, { avar, instances: this.instances });
    this.axisTags = this.axisSpace.axisTags;
    this.avar = avar;

    const gvarRec = tables.get("gvar");
    this.gvar = gvarRec ? new GvarTable(reader, gvarRec.offset, this.axisTags, numGlyphs) : null;

    const hvarRec = tables.get("HVAR");
    this.hvar = hvarRec ? parseHvar(reader, hvarRec.offset, this.axisTags) : null;

    const mvarRec = tables.get("MVAR");
    this.mvar = mvarRec ? parseMvar(reader, mvarRec.offset, this.axisTags) : null;

    const gdefRec = tables.get("GDEF");
    this.gdef = gdefRec ? parseGdef(reader, gdefRec.offset, this.axisTags) : null;

    const gposRec = tables.get("GPOS");
    this.gpos = gposRec ? new GposTable(reader, gposRec.offset, this.gdef, this.axisTags) : null;

    const kernRec = tables.get("kern");
    this.kern = kernRec ? parseKern(reader, kernRec.offset) : null;

    this.glyph = new GlyphEvaluator({
      glyf: this.glyf,
      hmtx: this.hmtx,
      hhea: this.hhea,
      gvar: this.gvar,
      hvar: this.hvar,
      mvar: this.mvar,
      gdef: this.gdef,
      axisSpace: this.axisSpace,
    });

    // Back-compat accessors for code/tests that used Font's caches directly.
    this.locationCache = this.glyph.locationCache;
    this.outlineCache = this.glyph.outlineCache;
  }

  get familyName() {
    return this.name.get(16) ?? this.name.get(1) ?? "unknown";
  }

  // --- variation coordinates (delegated to AxisSpace) ---

  // userLocation: {tag: value}. Returns
  // {requested, clamped, normalized, unsupported, invalid, adjusted}.
  normalize(userLocation = {}) {
    return this.axisSpace.resolve(userLocation);
  }

  locationKey(normalized) {
    return this.axisSpace.locationKey(normalized);
  }

  locationState(normalized) {
    return this.glyph.locationState(normalized);
  }

  // --- metrics (delegated) ---

  metricsFor(normalized) {
    return this.glyph.metricsFor(normalized);
  }

  advance(gid, normalized) {
    return this.glyph.advance(gid, normalized);
  }

  phantomPoints(gid, normalized) {
    return this.glyph.phantomPoints(gid, normalized);
  }

  // --- outlines (delegated) ---

  glyphIdFor(cp) {
    return this.cmap.glyphIdFor(cp);
  }

  getOutline(gid, normalized) {
    return this.glyph.getOutline(gid, normalized);
  }

  // --- shaping ---

  // Shape a single run of text with this font only.
  shape(text, userLocation = {}) {
    return shapeRun(this, text, this.normalize(userLocation));
  }
}
