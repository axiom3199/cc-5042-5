#!/usr/bin/env python3
"""Generate reference JSON from mature typography engines (fontTools for
outlines/metrics, HarfBuzz for shaping/positioning). The Node test suite
compares the JS engine's output against these files.

Run: python3 test/reference/gen_reference.py
"""
import json
import math
import os

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer, models
from fontTools.pens.pointPen import DecomposingPointPen


class RecordingDecomposingPointPen(DecomposingPointPen):
    """Point pen that records raw points and expands composite glyphs."""

    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.value = []

    def beginPath(self):
        self.value.append(("beginPath", None))

    def addPoint(self, pt, segmentType=None, *args, **kwargs):
        self.value.append(("addPoint", (pt, segmentType)))

    def endPath(self):
        self.value.append(("endPath", None))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.dirname(os.path.abspath(__file__))

FONTS = {
    "noto": os.path.join(ROOT, "assets/fonts/NotoSans-wdth-wght.ttf"),
    "test": os.path.join(ROOT, "test/fixtures/TestAxes.ttf"),
}

NOTO_LOCATIONS = [
    {},
    {"wght": 100},
    {"wght": 900},
    {"wdth": 62.5},
    {"wdth": 100},
    {"wght": 550, "wdth": 80},
    {"wght": 333.3, "wdth": 75.7},
    {"wght": 900, "wdth": 62.5},
    {"wght": 100, "wdth": 100},
    {"wght": 50, "wdth": 120},   # out of range -> clamped
    {"wght": 1000, "wdth": 10},  # out of range -> clamped
]
TEST_LOCATIONS = [
    {},
    {"wght": 100},
    {"wght": 900},
    {"wdth": 50},
    {"wdth": 150},
    {"wght": 550, "wdth": 120},
    {"wght": 250, "wdth": 80},
    {"wght": 1000, "wdth": 10},  # out of range -> clamped
]

NOTO_GLYPH_CHARS = ["A", "V", "T", "o", "é", "Á", "0", "-", ".", "(", "ı"]
TEST_GLYPH_CHARS = ["A", "V", "T", "o", " ", "0", "Á", "´", "😀"]

NOTO_STRINGS = ["AVATAR", "To", "AV", "oooo", "AAAA", "VA VA", "T.A", "HyHy",
                "éA", "AVAVAV", "ı̈)", "ı̈̂)", "A🦄B"]
TEST_STRINGS = ["AV", "VAV", "To", "AAAA", "A😀B", "oAo", "A V"]


def normalize(font, loc):
    axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes}
    clamped = {}
    for tag, (mn, default, mx) in axes.items():
        v = loc.get(tag, default)
        clamped[tag] = min(mx, max(mn, v))
    normalized = models.normalizeLocation(clamped, axes)
    if "avar" in font:
        segs = font["avar"].segments
        normalized = {k: models.piecewiseLinearMap(v, segs[k]) for k, v in normalized.items()}
    return clamped, normalized


def outline_of(font, glyph_name):
    """Resolved contour points via the point-pen protocol (raw points).
    Composite glyphs are expanded into their components."""
    gs = font.getGlyphSet()
    pen = RecordingDecomposingPointPen(gs)
    gs[glyph_name].drawPoints(pen)
    contours = []
    current = None
    for op, args in pen.value:
        if op == "beginPath":
            current = []
        elif op == "addPoint":
            (x, y), segmentType = args
            current.append({"x": x, "y": y, "onCurve": segmentType is not None})
        elif op == "endPath":
            contours.append(current)
            current = None
    return contours


def bbox_of(contours):
    xs = [p["x"] for c in contours for p in c]
    ys = [p["y"] for c in contours for p in c]
    if not xs:
        return {"xMin": 0, "yMin": 0, "xMax": 0, "yMax": 0}
    return {"xMin": min(xs), "yMin": min(ys), "xMax": max(xs), "yMax": max(ys)}


def gen_font(key, path, locations, glyph_chars, strings):
    font = TTFont(path)
    cmap = font.getBestCmap()
    order = font.getGlyphOrder()

    meta = {
        "upm": font["head"].unitsPerEm,
        "numGlyphs": font["maxp"].numGlyphs,
        "hhea": {
            "ascent": font["hhea"].ascent,
            "descent": font["hhea"].descent,
            "lineGap": font["hhea"].lineGap,
        },
        "axes": [
            {
                "tag": a.axisTag,
                "min": a.minValue,
                "default": a.defaultValue,
                "max": a.maxValue,
                "nameID": a.axisNameID,
                "name": font["name"].getDebugName(a.axisNameID),
            }
            for a in font["fvar"].axes
        ],
        "instances": [
            {"name": font["name"].getDebugName(i.subfamilyNameID), "coords": i.coordinates}
            for i in font["fvar"].instances
        ],
        "glyphIds": {ch: font.getGlyphID(cmap[ord(ch)]) for ch in glyph_chars if ord(ch) in cmap},
    }

    norm_refs = []
    for loc in locations:
        clamped, normalized = normalize(font, loc)
        norm_refs.append({"user": loc, "clamped": clamped, "normalized": normalized})

    outlines = []
    for loc in locations:
        clamped, _ = normalize(font, loc)
        inst = instancer.instantiateVariableFont(font, clamped, inplace=False)
        hmtx = inst["hmtx"].metrics
        per_glyph = {}
        for ch in glyph_chars:
            cp = ord(ch)
            if cp not in cmap:
                continue
            name = cmap[cp]
            contours = outline_of(inst, name)
            per_glyph[ch] = {
                "gid": font.getGlyphID(name),
                "contours": contours,
                "bbox": bbox_of(contours),
                "advance": hmtx[name][0],
                "lsb": hmtx[name][1],
            }
        # .notdef via glyph id 0
        contours = outline_of(inst, order[0])
        per_glyph[".notdef"] = {
            "gid": 0,
            "contours": contours,
            "bbox": bbox_of(contours),
            "advance": hmtx[order[0]][0],
            "lsb": hmtx[order[0]][1],
        }
        outlines.append({"location": clamped, "glyphs": per_glyph})

    # HarfBuzz shaping.
    blob = hb.Blob.from_file_path(path)
    face = hb.Face(blob)
    shapings = []
    for loc in locations:
        clamped, _ = normalize(font, loc)
        hbfont = hb.Font(face)
        hb.ot_font_set_funcs(hbfont)
        if clamped:
            hbfont.set_variations(clamped)
        for s in strings:
            buf = hb.Buffer()
            buf.add_str(s)
            buf.guess_segment_properties()
            hb.shape(hbfont, buf, {})
            shapings.append({
                "location": clamped,
                "text": s,
                "glyphs": [
                    {
                        "gid": info.codepoint,
                        "cluster": info.cluster,
                        "advance": pos.x_advance,
                        "xOffset": pos.x_offset,
                        "yOffset": pos.y_offset,
                    }
                    for info, pos in zip(buf.glyph_infos, buf.glyph_positions)
                ],
            })

    return {"meta": meta, "normalize": norm_refs, "outlines": outlines, "shaping": shapings}


def main():
    for key, path in FONTS.items():
        if key == "noto":
            data = gen_font(key, path, NOTO_LOCATIONS, NOTO_GLYPH_CHARS, NOTO_STRINGS)
        else:
            data = gen_font(key, path, TEST_LOCATIONS, TEST_GLYPH_CHARS, TEST_STRINGS)
        out_path = os.path.join(OUT, f"reference-{key}.json")
        with open(out_path, "w") as fh:
            json.dump(data, fh)
        print("wrote", out_path, f"({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    main()
