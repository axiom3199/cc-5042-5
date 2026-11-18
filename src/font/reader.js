// Big-endian binary reader over a DataView. Cursor-based, with absolute seeks.
export class Reader {
  constructor(view, pos = 0) {
    this.v = view;
    this.p = pos;
  }

  static from(buffer) {
    const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    return new Reader(new DataView(buf, buffer.byteOffset ?? 0, buffer.byteLength));
  }

  get length() {
    return this.v.byteLength;
  }

  seek(pos) {
    this.p = pos;
    return this;
  }

  skip(n) {
    this.p += n;
    return this;
  }

  tell() {
    return this.p;
  }

  sub(pos) {
    return new Reader(this.v, pos);
  }

  u8() { const v = this.v.getUint8(this.p); this.p += 1; return v; }
  i8() { const v = this.v.getInt8(this.p); this.p += 1; return v; }
  u16() { const v = this.v.getUint16(this.p); this.p += 2; return v; }
  i16() { const v = this.v.getInt16(this.p); this.p += 2; return v; }
  u24() { const v = (this.v.getUint8(this.p) << 16) | (this.v.getUint8(this.p + 1) << 8) | this.v.getUint8(this.p + 2); this.p += 3; return v; }
  u32() { const v = this.v.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.v.getInt32(this.p); this.p += 4; return v; }

  u16At(pos) { return this.v.getUint16(pos); }
  i16At(pos) { return this.v.getInt16(pos); }
  u32At(pos) { return this.v.getUint32(pos); }

  fixed() { return this.i32() / 65536; }
  f2dot14() { return this.i16() / 16384; }

  tag() {
    const a = this.u8(), b = this.u8(), c = this.u8(), d = this.u8();
    return String.fromCharCode(a, b, c, d);
  }

  bytes(n) {
    const out = new Uint8Array(this.v.buffer, this.v.byteOffset + this.p, n);
    this.p += n;
    return out;
  }
}

// OpenType rounding: nearest integer, halves towards +Infinity.
export function otRound(v) {
  return Math.floor(v + 0.5);
}
