// glyf + loca: raw glyph parsing (simple and composite), lazy per glyph.

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

export const COMP_ARG_WORDS = 0x0001;
export const COMP_ARGS_ARE_XY = 0x0002;
export const COMP_ROUND_XY = 0x0004;
export const COMP_SCALE = 0x0008;
export const COMP_MORE = 0x0020;
export const COMP_XY_SCALE = 0x0040;
export const COMP_2X2 = 0x0080;
export const COMP_INSTRUCTIONS = 0x0100;
export const COMP_USE_MY_METRICS = 0x0200;
export const COMP_SCALED_OFFSET = 0x0800;
export const COMP_UNSCALED_OFFSET = 0x1000;

export class GlyfTable {
  constructor(reader, glyfOffset, locaOffsets) {
    this.reader = reader;
    this.offset = glyfOffset;
    this.loca = locaOffsets;
    this.cache = new Map();
  }

  static parseLoca(reader, headOffset, maxpOffset, locaOffset) {
    const hr = reader.sub(headOffset);
    hr.skip(50);
    const indexToLocFormat = hr.i16();
    const mr = reader.sub(maxpOffset);
    mr.skip(4);
    const numGlyphs = mr.u16();
    const lr = reader.sub(locaOffset);
    const offsets = [];
    for (let i = 0; i <= numGlyphs; i++) {
      offsets.push(indexToLocFormat === 0 ? lr.u16() * 2 : lr.u32());
    }
    return { offsets, numGlyphs };
  }

  getRaw(gid) {
    if (this.cache.has(gid)) return this.cache.get(gid);
    const start = this.loca[gid];
    const end = this.loca[gid + 1];
    if (start === end) {
      const empty = { numberOfContours: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0, endPts: [], points: [], flags: [], components: null };
      this.cache.set(gid, empty);
      return empty;
    }
    const r = this.reader.sub(this.offset + start);
    const numberOfContours = r.i16();
    const xMin = r.i16(), yMin = r.i16(), xMax = r.i16(), yMax = r.i16();

    if (numberOfContours >= 0) {
      const endPts = [];
      for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
      const instructionLength = r.u16();
      r.skip(instructionLength);
      const numPoints = numberOfContours === 0 ? 0 : endPts[endPts.length - 1] + 1;
      const flags = [];
      while (flags.length < numPoints) {
        const flag = r.u8();
        flags.push(flag);
        if (flag & REPEAT) {
          const repeatCount = r.u8();
          for (let i = 0; i < repeatCount; i++) flags.push(flag);
        }
      }
      const xs = [];
      let x = 0;
      for (const flag of flags) {
        if (flag & X_SHORT) {
          const b = r.u8();
          x += flag & X_SAME_OR_POSITIVE ? b : -b;
        } else if (!(flag & X_SAME_OR_POSITIVE)) {
          x += r.i16();
        }
        xs.push(x);
      }
      const ys = [];
      let y = 0;
      for (const flag of flags) {
        if (flag & Y_SHORT) {
          const b = r.u8();
          y += flag & Y_SAME_OR_POSITIVE ? b : -b;
        } else if (!(flag & Y_SAME_OR_POSITIVE)) {
          y += r.i16();
        }
        ys.push(y);
      }
      const points = [];
      const onCurve = [];
      for (let i = 0; i < numPoints; i++) {
        points.push([xs[i], ys[i]]);
        onCurve.push((flags[i] & ON_CURVE) !== 0);
      }
      const glyph = { numberOfContours, xMin, yMin, xMax, yMax, endPts, points, onCurve, components: null };
      this.cache.set(gid, glyph);
      return glyph;
    }

    // Composite glyph.
    const components = [];
    let hasInstructions = false;
    while (true) {
      const flags = r.u16();
      const compGid = r.u16();
      let arg1, arg2;
      if (flags & COMP_ARG_WORDS) {
        arg1 = flags & COMP_ARGS_ARE_XY ? r.i16() : r.u16();
        arg2 = flags & COMP_ARGS_ARE_XY ? r.i16() : r.u16();
      } else {
        arg1 = flags & COMP_ARGS_ARE_XY ? r.i8() : r.u8();
        arg2 = flags & COMP_ARGS_ARE_XY ? r.i8() : r.u8();
      }
      let transform = null; // [[xx, xy], [yx, yy]]
      if (flags & COMP_SCALE) {
        const s = r.f2dot14();
        transform = [[s, 0], [0, s]];
      } else if (flags & COMP_XY_SCALE) {
        const sx = r.f2dot14(), sy = r.f2dot14();
        transform = [[sx, 0], [0, sy]];
      } else if (flags & COMP_2X2) {
        const xx = r.f2dot14(), xy = r.f2dot14();
        const yx = r.f2dot14(), yy = r.f2dot14();
        transform = [[xx, xy], [yx, yy]];
      }
      components.push({
        gid: compGid,
        flags,
        xyValues: (flags & COMP_ARGS_ARE_XY) !== 0,
        x: flags & COMP_ARGS_ARE_XY ? arg1 : 0,
        y: flags & COMP_ARGS_ARE_XY ? arg2 : 0,
        firstPt: flags & COMP_ARGS_ARE_XY ? 0 : arg1,
        secondPt: flags & COMP_ARGS_ARE_XY ? 0 : arg2,
        transform,
      });
      if (flags & COMP_INSTRUCTIONS) hasInstructions = true;
      if (!(flags & COMP_MORE)) break;
    }
    if (hasInstructions) {
      const instructionLength = r.u16();
      r.skip(instructionLength);
    }
    const glyph = { numberOfContours, xMin, yMin, xMax, yMax, endPts: [], points: [], onCurve: [], components };
    this.cache.set(gid, glyph);
    return glyph;
  }
}
