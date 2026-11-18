// UI wiring: builds axis controls from the font's actual fvar table,
// renders the poster from real shaped/laid-out glyph data, and surfaces
// applied coordinates, unsupported axes, fallback and missing glyphs.
import { Font } from "../font/font.js";
import { FontSet } from "../font/fontset.js";
import { layoutPoster } from "../font/layout.js";
import { renderPoster, COLORS } from "./poster.js";

const $ = (id) => document.getElementById(id);
const canvas = $("poster");

const state = {
  fontSet: null,
  text: "",
  fontSize: 120,
  lineHeightFactor: 1.2,
  letterSpacing: 0,
  align: "left",
  location: {}, // user coordinates, may include axes the font lacks
  showMetrics: false,
  hits: [],
  layout: null,
};

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => (el.style.display = "none"), 8000);
}

async function loadFontFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法加载字体 ${url}: ${res.status}`);
  return new Font(await res.arrayBuffer());
}

// Pick demo characters from real coverage: one that needs the fallback
// font, one missing everywhere.
function pickDemoChars() {
  const [primary, fallback] = state.fontSet.fonts;
  const fbCandidates = [0x2665, 0x2192, 0x2605, 0x221e, 0x2600, 0x2022, 0x263a];
  const missingCandidates = [0x1f984, 0x1f995, 0x1f6f8, 0x4e00];
  const fb = fbCandidates.find(
    (cp) => primary.glyphIdFor(cp) === 0 && fallback.glyphIdFor(cp) !== 0
  );
  const miss = missingCandidates.find((cp) =>
    state.fontSet.fonts.every((f) => f.glyphIdFor(cp) === 0)
  );
  return {
    fb: fb ? String.fromCodePoint(fb) : "",
    miss: miss ? String.fromCodePoint(miss) : "",
  };
}

function defaultText() {
  const { fb, miss } = pickDemoChars();
  return `AVATAR é ${fb}${miss}\nTo oooo AVA`;
}

// --- axis UI ---

function buildAxisUI() {
  const font = state.fontSet.primary;
  const host = $("axes");
  host.innerHTML = "";
  const hasAxes = font.axes.length > 0;
  $("noAxes").hidden = hasAxes;
  $("instanceRow").hidden = !(hasAxes && font.instances.length);

  // Drop coordinates for axes this font doesn't have? No — keep them in
  // state so the "unsupported axis" warning demonstrates that they are
  // NOT applied. But ensure every supported axis has a value.
  for (const axis of font.axes) {
    if (typeof state.location[axis.tag] !== "number") {
      state.location[axis.tag] = axis.default;
    }
  }

  for (const axis of font.axes) {
    const div = document.createElement("div");
    div.className = "axis";
    const step = (axis.max - axis.min) / 400 || 0.01;
    div.innerHTML = `
      <div class="axis-head">
        <span><span class="axis-name"></span><span class="axis-tag"></span></span>
        <input type="number" class="axis-value" step="any">
      </div>
      <input type="range" class="axis-slider">
      <div class="axis-range"><span class="lo"></span><span class="def"></span><span class="hi"></span></div>`;
    div.querySelector(".axis-name").textContent = axis.name;
    div.querySelector(".axis-tag").textContent = ` ${axis.tag}${axis.hidden ? "（隐藏）" : ""}`;
    const slider = div.querySelector(".axis-slider");
    slider.min = axis.min;
    slider.max = axis.max;
    slider.step = step;
    slider.value = state.location[axis.tag];
    const num = div.querySelector(".axis-value");
    num.min = axis.min;
    num.max = axis.max;
    num.value = round2(state.location[axis.tag]);
    div.querySelector(".lo").textContent = axis.min;
    div.querySelector(".def").textContent = `默认 ${axis.default}`;
    div.querySelector(".hi").textContent = axis.max;
    const onInput = (v) => {
      state.location[axis.tag] = v;
      slider.value = v;
      num.value = round2(v);
      render();
    };
    slider.addEventListener("input", () => onInput(parseFloat(slider.value)));
    num.addEventListener("change", () => {
      const v = parseFloat(num.value);
      onInput(Number.isFinite(v) ? v : axis.default);
    });
    host.appendChild(div);
  }

  const inst = $("instances");
  inst.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "选择预设…";
  inst.appendChild(ph);
  font.instances.forEach((ins, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${ins.name} — ${font.axes.map((a) => `${a.tag}=${ins.coords[a.tag]}`).join(" ")}`;
    inst.appendChild(opt);
  });
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// --- rendering ---

function render() {
  if (!state.fontSet) return;
  try {
    const stage = $("stage");
    const width = Math.max(480, Math.min(1600, stage.clientWidth - 36));
    const layout = layoutPoster(state.fontSet, state.text, state.location, {
      fontSize: state.fontSize,
      lineHeightFactor: state.lineHeightFactor,
      letterSpacing: state.letterSpacing,
      align: state.align,
      width,
      padding: 48,
      height: 800,
    });
    // Grow the canvas to fit all lines.
    const primaryScale = state.fontSize / state.fontSet.primary.unitsPerEm;
    const last = layout.lines[layout.lines.length - 1];
    layout.height = Math.max(
      240,
      Math.ceil(last.baselineY - layout.metrics.descent * primaryScale + 48)
    );
    state.layout = layout;
    state.hits = renderPoster(canvas, layout, state.fontSet, {
      showMetrics: state.showMetrics,
    });
    updateReadouts(layout);
  } catch (err) {
    console.error(err);
    showError(`渲染失败：${err.message}`);
  }
}

function updateReadouts(layout) {
  const shaped = layout.shaped;
  const font = state.fontSet.primary;

  // Applied coordinates table (clamped user values + post-avar normalized).
  const tbody = $("coordTable").querySelector("tbody");
  tbody.innerHTML = "";
  if (font.axes.length === 0) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = 3;
    td.textContent = "（静态字体，无可变坐标）";
    td.style.textAlign = "left";
  }
  for (const axis of font.axes) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = axis.tag;
    tr.insertCell().textContent = round2(shaped.clamped[axis.tag]);
    tr.insertCell().textContent = (shaped.normalized[axis.tag] ?? 0).toFixed(4);
  }

  // Unsupported-axis warnings: these must be visible as NOT applied.
  const warnHost = $("unsupported");
  warnHost.innerHTML = "";
  for (const tag of shaped.unsupported) {
    const div = document.createElement("div");
    div.className = "warn";
    div.textContent = `轴 “${tag}” 不被 ${font.familyName} 支持，已忽略（未生效）。`;
    warnHost.appendChild(div);
  }
  for (const entry of shaped.unsupportedByFont) {
    if (entry.fontIndex === 0) continue;
    const div = document.createElement("div");
    div.className = "warn";
    const fname = state.fontSet.fonts[entry.fontIndex].familyName;
    div.textContent = `回退字体 ${fname} 不支持轴 ${entry.tags.map((t) => `“${t}”`).join("、")}，这些轴对它未生效。`;
    warnHost.appendChild(div);
  }

  // Glyph source counts.
  let primary = 0;
  for (const g of shaped.glyphs) if (!g.missing && !g.fallback) primary++;
  $("countPrimary").textContent = primary;
  $("countFallback").textContent = shaped.fallbackCount;
  $("countMissing").textContent = shaped.missingCount;
}

// --- glyph inspector ---

canvas.addEventListener("click", (ev) => {
  if (!state.layout) return;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const hit = [...state.hits].reverse().find(
    (h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1
  );
  const host = $("inspector");
  if (!hit) {
    host.innerHTML = `<p class="hint">未命中字形（点击字形的主体区域）。</p>`;
    return;
  }
  const g = hit.glyph;
  const font = state.fontSet.fonts[g.fontIndex];
  const outline = font.getOutline(g.gid, g.normalized);
  const pointCount = outline.contours.reduce((a, c) => a + c.length, 0);
  const badges = [
    g.missing ? `<span class="badge missing">缺字 .notdef</span>` : "",
    g.fallback ? `<span class="badge fallback">回退字体</span>` : "",
  ].join("");
  const coordStr = font.axes.length
    ? font.axes.map((a) => `${a.tag}=${(g.normalized[a.tag] ?? 0).toFixed(3)}`).join(" ")
    : "（静态）";
  host.innerHTML = `
    <p>${badges}</p>
    <dl>
      <dt>字符</dt><dd>${escapeHtml(g.char)} (U+${g.cp.toString(16).toUpperCase().padStart(4, "0")})</dd>
      <dt>glyph id</dt><dd>${g.gid}</dd>
      <dt>字体</dt><dd>#${g.fontIndex} ${escapeHtml(font.familyName)}</dd>
      <dt>前进量</dt><dd>${round2(g.advance)} 单位 = ${round2(g.advancePx)} px</dd>
      <dt>偏移</dt><dd>x ${round2(g.xOffset)} / y ${round2(g.yOffset)} 单位</dd>
      <dt>bbox</dt><dd>${round2(outline.bbox.xMin)}, ${round2(outline.bbox.yMin)} — ${round2(outline.bbox.xMax)}, ${round2(outline.bbox.yMax)}</dd>
      <dt>轮廓/点</dt><dd>${outline.contours.length} 条轮廓 / ${pointCount} 点${outline.composite ? "（复合字形）" : ""}</dd>
      <dt>归一化坐标</dt><dd>${coordStr}</dd>
      <dt>画布位置</dt><dd>x ${round2(g.x)} y ${round2(g.y)}</dd>
    </dl>`;
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
}

// --- controls ---

function bindRange(sliderId, numId, get, set) {
  const slider = $(sliderId);
  const num = $(numId);
  slider.value = get();
  num.value = get();
  slider.addEventListener("input", () => {
    set(parseFloat(slider.value));
    num.value = slider.value;
    render();
  });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) {
      set(v);
      slider.value = v;
      render();
    }
  });
}

function bindControls() {
  $("text").addEventListener("input", () => {
    state.text = $("text").value;
    render();
  });
  bindRange("fontSize", "fontSizeNum", () => state.fontSize, (v) => (state.fontSize = v));
  bindRange("lineHeight", "lineHeightNum", () => state.lineHeightFactor, (v) => (state.lineHeightFactor = v));
  bindRange("letterSpacing", "letterSpacingNum", () => state.letterSpacing, (v) => (state.letterSpacing = v));
  $("align").addEventListener("change", () => {
    state.align = $("align").value;
    render();
  });
  $("instances").addEventListener("change", () => {
    const i = $("instances").value;
    if (i === "") return;
    const ins = state.fontSet.primary.instances[Number(i)];
    Object.assign(state.location, ins.coords);
    buildAxisUI();
    render();
  });
  $("resetAxes").addEventListener("click", () => {
    for (const axis of state.fontSet.primary.axes) state.location[axis.tag] = axis.default;
    buildAxisUI();
    render();
  });
  $("showMetrics").addEventListener("change", () => {
    state.showMetrics = $("showMetrics").checked;
    render();
  });
  $("export").addEventListener("click", () => {
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "poster.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  });
  $("upload").addEventListener("change", () => {
    const file = $("upload").files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const font = new Font(reader.result);
        state.fontSet = new FontSet([font, ...state.fontSet.fonts.slice(1)]);
        updateHeader();
        buildAxisUI();
        render();
      } catch (err) {
        console.error(err);
        showError(`字体加载失败：${err.message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  });
  window.addEventListener("resize", render);
}

function updateHeader() {
  const p = state.fontSet.primary;
  const axisInfo = p.axes.length
    ? `${p.axes.length} 个可变轴：${p.axes.map((a) => `${a.name}(${a.tag})`).join("、")}`
    : "静态字体";
  $("fontName").textContent = `${p.familyName} — ${axisInfo}；回退：${state.fontSet.fonts
    .slice(1)
    .map((f) => f.familyName)
    .join("、")}`;
  $("fontList").innerHTML = state.fontSet.fonts
    .map(
      (f, i) =>
        `#${i} ${escapeHtml(f.familyName)} — upm ${f.unitsPerEm}，${f.numGlyphs} 字形，${f.axes.length} 轴`
    )
    .join("<br>");
}

async function main() {
  const [noto, dejavu] = await Promise.all([
    loadFontFile("assets/fonts/NotoSans-wdth-wght.ttf"),
    loadFontFile("assets/fonts/DejaVuSans.ttf"),
  ]);
  state.fontSet = new FontSet([noto, dejavu]);
  state.text = defaultText();
  $("text").value = state.text;
  for (const axis of noto.axes) state.location[axis.tag] = axis.default;
  updateHeader();
  buildAxisUI();
  bindControls();
  render();
}

main().catch((err) => {
  console.error(err);
  showError(`初始化失败：${err.message}`);
});
