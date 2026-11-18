#!/usr/bin/env python3
"""Build a small synthetic variable font (test/fixtures/TestAxes.ttf).

Exercises engine paths the real demo font does not:
- kern table (format 0) instead of GPOS kerning
- gvar intermediate-region tuples, private point numbers, two-axis tuples
- avar non-linear mappings on both axes
- composite glyph with gvar-driven component offset + advance deltas
- cmap format 12 (astral codepoint) alongside format 4
"""
import os
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent, GlyphCoordinates
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables._k_e_r_n import KernTable_format_0
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.ttLib.tables._f_v_a_r import Axis
from fontTools.ttLib.tables import ttProgram

OUT = os.path.join(os.path.dirname(__file__), "TestAxes.ttf")

ORDER = [".notdef", "space", "A", "V", "T", "o", "acute", "Aacute", "zero", "emoji"]
CMAP = {
    0x20: "space", 0x41: "A", 0x56: "V", 0x54: "T", 0x6F: "o",
    0xB4: "acute", 0xC1: "Aacute", 0x30: "zero", 0x1F600: "emoji",
}
METRICS = {  # (advance, lsb) — lsb must equal the glyph's xMin so that
             # fontTools' draw offset (lsb - xMin) is zero everywhere.
    ".notdef": (600, 50), "space": (300, 0), "A": (600, 20), "V": (620, 10),
    "T": (580, 0), "o": (400, 40), "acute": (200, 0), "Aacute": (600, 20),
    "zero": (500, 0), "emoji": (700, 0),
}


def simple_glyph(points, oncurve=None):
    g = Glyph()
    g.numberOfContours = len(points)
    g.coordinates = GlyphCoordinates([p for contour in points for p in contour])
    g.endPtsOfContours = []
    n = 0
    for contour in points:
        n += len(contour)
        g.endPtsOfContours.append(n - 1)
    total = sum(len(c) for c in points)
    g.flags = [1] * total if oncurve is None else oncurve
    g.program = ttProgram.Program()
    g.program.fromBytecode([])
    return g


def make_glyphs():
    glyphs = {}
    glyphs[".notdef"] = simple_glyph([[(50, 0), (550, 0), (550, 700), (50, 700)]])
    glyphs["space"] = simple_glyph([[]])
    glyphs["space"].numberOfContours = 0
    glyphs["space"].endPtsOfContours = []
    glyphs["A"] = simple_glyph([[(20, 0), (300, 650), (580, 0), (300, 150)]])
    glyphs["V"] = simple_glyph([[(10, 700), (300, 0), (590, 700), (300, 200)]])
    glyphs["T"] = simple_glyph([[
        (0, 700), (600, 700), (600, 640), (330, 640),
        (330, 0), (270, 0), (270, 640), (0, 640),
    ]])
    glyphs["o"] = simple_glyph([
        [(40, 0), (360, 0), (360, 500), (40, 500)],
        [(120, 80), (280, 80), (280, 420), (120, 420)],
    ])
    glyphs["acute"] = simple_glyph([[(0, 750), (150, 900), (150, 750)]])
    glyphs["zero"] = simple_glyph([[(0, 0), (500, 0), (500, 700), (0, 700)]])
    glyphs["emoji"] = simple_glyph([[(0, 0), (700, 0), (700, 700), (0, 700)]])

    # Composite: Aacute = A + acute (acute offset above-right of A).
    comp = Glyph()
    comp.numberOfContours = -1
    c1 = GlyphComponent()
    c1.glyphName = "A"
    c1.x, c1.y = 0, 0
    c1.flags = 0x0202  # ARGS_ARE_XY_VALUES | USE_MY_METRICS
    c2 = GlyphComponent()
    c2.glyphName = "acute"
    c2.x, c2.y = 220, -100
    c2.flags = 0x0002  # ARGS_ARE_XY_VALUES
    comp.components = [c1, c2]
    comp.program = ttProgram.Program()
    comp.program.fromBytecode([])
    glyphs["Aacute"] = comp
    return glyphs


def make_gvar():
    gvar = newTable("gvar")
    gvar.version = 1
    gvar.reserved = 0
    gvar.variations = {}

    def tvar(axes, deltas):
        return TupleVariation(axes, deltas)

    # A: 4 points + 4 phantoms (idx 4=left, 5=right, 6=top, 7=bottom)
    gvar.variations["A"] = [
        # weight-only, all points: raise apex, widen advance by 50
        tvar({"wght": (0.0, 1.0, 1.0)},
             [(0, 100), (0, 100), (0, 0), (0, 0), (0, 0), (50, 0), (0, 0), (0, 0)]),
        # weight intermediate region with private point numbers
        tvar({"wght": (0.2, 0.5, 0.8)},
             [(50, 0), (50, 0), None, None, None, None, None, None]),
        # width-only (negative direction), sparse points incl. right phantom
        tvar({"wdth": (-1.0, -1.0, 0.0)},
             [None, None, (-40, 0), (-40, 0), None, (-30, 0), None, None]),
        # two-axis tuple
        tvar({"wght": (0.0, 1.0, 1.0), "wdth": (0.0, 1.0, 1.0)},
             [(20, 20), None, None, None, None, None, None, None]),
    ]
    # V: 4 points + 4 phantoms
    gvar.variations["V"] = [
        tvar({"wght": (0.0, 1.0, 1.0)},
             [(0, -50), (0, 0), (0, -50), (0, 0), (0, 0), (30, 0), (0, 0), (0, 0)]),
    ]
    # o: 8 points + 4 phantoms; sparse points force IUP across both contours
    gvar.variations["o"] = [
        tvar({"wght": (0.0, 1.0, 1.0)},
             [(0, 20), None, None, None, (0, -20), None, None, None,
              None, None, None, None]),
        tvar({"wdth": (-1.0, -1.0, 0.0)},
             [(-10, 0)] * 8 + [(0, 0), (-40, 0), (0, 0), (0, 0)]),
    ]
    # space: phantom-only advance change
    gvar.variations["space"] = [
        tvar({"wght": (0.0, 1.0, 1.0)}, [(0, 0), (100, 0), (0, 0), (0, 0)]),
    ]
    # Aacute composite: 2 components + 4 phantoms
    gvar.variations["Aacute"] = [
        tvar({"wght": (0.0, 1.0, 1.0)},
             [None, (0, 30), None, (60, 0), None, None]),
    ]
    return gvar


def main():
    font = TTFont()
    font.setGlyphOrder(ORDER)

    glyphs = make_glyphs()
    glyf = newTable("glyf")
    glyf.glyphs = glyphs
    glyf.glyphOrder = ORDER
    font["glyf"] = glyf
    font["loca"] = newTable("loca")

    maxp = newTable("maxp")
    maxp.tableVersion = 0x10000
    maxp.numGlyphs = len(ORDER)
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = 1
    font["maxp"] = maxp

    head = newTable("head")
    head.tableVersion = 1.0
    head.fontRevision = 1.0
    head.checkSumAdjustment = 0
    head.magicNumber = 0x5F0F3CF5
    head.flags = 3
    head.unitsPerEm = 1000
    head.created = head.modified = 0
    head.xMin, head.yMin, head.xMax, head.yMax = 0, -200, 700, 900
    head.macStyle = 0
    head.lowestRecPPEM = 8
    head.fontDirectionHint = 2
    head.indexToLocFormat = 1
    head.glyphDataFormat = 0
    font["head"] = head

    hhea = newTable("hhea")
    hhea.tableVersion = 0x10000
    hhea.ascent = 800
    hhea.descent = -200
    hhea.lineGap = 100
    hhea.advanceWidthMax = 700
    hhea.minLeftSideBearing = 0
    hhea.minRightSideBearing = 0
    hhea.xMaxExtent = 700
    hhea.caretSlopeRise = 1
    hhea.caretSlopeRun = 0
    hhea.caretOffset = 0
    hhea.reserved0 = hhea.reserved1 = hhea.reserved2 = hhea.reserved3 = 0
    hhea.metricDataFormat = 0
    hhea.numberOfHMetrics = len(ORDER)
    font["hhea"] = hhea

    hmtx = newTable("hmtx")
    hmtx.metrics = {name: METRICS[name] for name in ORDER}
    font["hmtx"] = hmtx

    cmap = newTable("cmap")
    cmap.tableVersion = 0
    cmap.tables = []
    bmp = {cp: name for cp, name in CMAP.items() if cp <= 0xFFFF}
    sub4 = CmapSubtable.newSubtable(4)
    sub4.platformID, sub4.platEncID, sub4.language = 3, 1, 0
    sub4.cmap = bmp
    sub12 = CmapSubtable.newSubtable(12)
    sub12.platformID, sub12.platEncID, sub12.language = 3, 10, 0
    sub12.cmap = dict(CMAP)
    cmap.tables = [sub4, sub12]
    font["cmap"] = cmap

    name = newTable("name")
    name.names = []
    for nid, value in [(1, "TestAxes"), (2, "Regular"), (4, "TestAxes Regular"),
                       (6, "TestAxes-Regular"), (256, "Weight"), (257, "Width")]:
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    font["name"] = name

    post = newTable("post")
    post.formatType = 3.0
    post.italicAngle = 0
    post.underlinePosition = -100
    post.underlineThickness = 50
    post.isFixedPitch = 0
    post.minMemType42 = post.maxMemType42 = post.minMemType1 = post.maxMemType1 = 0
    font["post"] = post

    os2 = newTable("OS/2")
    os2.version = 4
    os2.xAvgCharWidth = 500
    os2.usWeightClass = 400
    os2.usWidthClass = 5
    os2.fsType = 0
    os2.ySubscriptXSize = os2.ySubscriptYSize = 650
    os2.ySubscriptXOffset = 0
    os2.ySubscriptYOffset = 75
    os2.ySuperscriptXSize = os2.ySuperscriptYSize = 650
    os2.ySuperscriptXOffset = 0
    os2.ySuperscriptYOffset = 350
    os2.yStrikeoutSize = 50
    os2.yStrikeoutPosition = 300
    os2.sFamilyClass = 0
    from fontTools.ttLib.tables.O_S_2f_2 import Panose
    os2.panose = Panose()
    os2.ulUnicodeRange1 = os2.ulUnicodeRange2 = os2.ulUnicodeRange3 = os2.ulUnicodeRange4 = 0
    os2.achVendID = "TEST"
    os2.fsSelection = 0x40
    os2.usFirstCharIndex = 0x20
    os2.usLastCharIndex = 0xFFFF
    os2.sTypoAscender = 800
    os2.sTypoDescender = -200
    os2.sTypoLineGap = 100
    os2.usWinAscent = 900
    os2.usWinDescent = 200
    os2.ulCodePageRange1 = os2.ulCodePageRange2 = 0
    os2.sxHeight = 500
    os2.sCapHeight = 700
    os2.usDefaultChar = 0
    os2.usBreakChar = 0x20
    os2.usMaxContext = 1
    font["OS/2"] = os2

    fvar = newTable("fvar")
    fvar.majorVersion, fvar.minorVersion = 1, 0
    a1 = Axis()
    a1.axisTag, a1.minValue, a1.defaultValue, a1.maxValue = "wght", 100.0, 400.0, 900.0
    a1.flags, a1.axisNameID = 0, 256
    a2 = Axis()
    a2.axisTag, a2.minValue, a2.defaultValue, a2.maxValue = "wdth", 50.0, 100.0, 150.0
    a2.flags, a2.axisNameID = 0, 257
    fvar.axes = [a1, a2]
    fvar.instances = []
    font["fvar"] = fvar

    avar = newTable("avar")
    avar.segments = {
        "wght": {-1.0: -1.0, -0.5: -0.75, 0.0: 0.0, 0.5: 0.25, 1.0: 1.0},
        "wdth": {-1.0: -1.0, -0.3: -0.5, 0.0: 0.0, 1.0: 1.0},
    }
    font["avar"] = avar

    font["gvar"] = make_gvar()

    kern = newTable("kern")
    kern.version = 0
    st = KernTable_format_0()
    st.version = 0
    st.coverage = 1  # horizontal kerning
    st.kernTable = {("A", "V"): -80, ("V", "A"): -20, ("T", "o"): -40}
    kern.kernTables = [st]
    font["kern"] = kern

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    font.save(OUT)
    print("wrote", OUT)

    # Sanity: reload and instantiate at both extremes.
    from fontTools.varLib import instancer
    for loc in ({"wght": 100, "wdth": 50}, {"wght": 900, "wdth": 150}, {"wght": 550, "wdth": 120}):
        inst = instancer.instantiateVariableFont(font, loc, inplace=False)
        print(loc, "A adv:", inst["hmtx"].metrics["A"], "space adv:", inst["hmtx"].metrics["space"])


if __name__ == "__main__":
    main()
