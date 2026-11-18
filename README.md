# 可变字形海报渲染器

浏览器端用真实的 OpenType 可变字体表（fvar/avar/gvar/HVAR/MVAR/GPOS/kern）
解析、求值并排版字形。没有把可变轴退化成普通缩放，也没有新增字体设计维度。

## 启动界面

需要 Node.js（仓库自带一个零依赖静态服务器）。

```bash
npm install            # 仅测试需要（Playwright）；运行界面本身不依赖
npm run serve          # 默认 http://localhost:8080/
```

在浏览器打开终端打印的地址（默认 `http://localhost:8080/`）。页面加载
`assets/fonts/NotoSans-wdth-wght.ttf` 作为主字体、`DejaVuSans.ttf` 作为回退字体。

### 在界面上操作

1. 在“可变轴（解析自 fvar）”里拖动 **Weight / Width** 滑杆，或直接输入数值。
2. 在“文本与排版”里修改文本、字号、行高倍数、字距和对齐。
3. 画布会同时反映**字形形态**与**布局**的变化；右侧“采用坐标”表格显示
   截断后的用户值与 avar 之后的归一化坐标。
4. 点击画布上的任意字形，可在“字形检查”里看到字体来源、glyph id、前进量、
   bbox、轮廓点数与归一化坐标。
5. 越界或非法轴值会在“采用坐标”上方给出可见警告（截断或无效），不会被
   当作默认值悄悄应用。回退字体不支持的轴、全字体都缺的字形也分别有提示。
6. 可上传 `.ttf/.otf/.ttc` 替换主字体；“恢复默认”把各轴重置为 fvar 默认值。

## 架构与重构边界

| 模块 | 职责 | 变化影响 |
| --- | --- | --- |
| `src/font/axes.js` | `AxisSpace`：fvar 轴范围、范围校验、user→clamped→normalized→avar | 坐标语义；所有入口共享 |
| `src/font/glyph.js` | `GlyphEvaluator`：gvar 轮廓（含 IUP/复合字形）、前进量、MVAR 度量、按归一化位置缓存 | 归一化坐标 → 轮廓/前进量/度量缓存 |
| `src/font/shaping.js` | GPOS/kern、GDEF 标记、逐 run 求形 | 相邻字形关系 |
| `src/font/layout.js` | `shapeText`（求形）与 `placeLines`（放置）两段，`layoutPoster` 为组合入口 | 选项 → 仅放置；文本/轴 → 求形 |
| `src/font/compat.js` | 旧海报状态迁移与旧入口适配 | 仅兼容层，复用同一套校验 |
| `src/ui/main.js` | 轴控件由 `AxisSpace` 驱动；渲染调用求形/放置两段 | 轴或文本变化才重入求形 |

缓存边界：`GlyphEvaluator` 以归一化位置为键缓存轮廓/实例；`main.js` 以求形
结果为缓存单位，键为各字体归一化位置 + 文本。只改字号/字距/对齐时不会重算
轮廓，只重新放置。

## 验证

```bash
npm test          # Node 单元测试（轴、轮廓、求形、排版、兼容、重构等价）
npm run test:ui   # Playwright 浏览器冒烟
```

- `test/refactor-equivalence.test.js` 用重构前冻结的
  `test/fixtures/engine-baseline.json` 逐位置比对轮廓校验和/bbox、前进量、
  度量和排版范围（含主字体+回退字体与缺字场景）。
- `test/axis-interface.test.js` 验证共享范围校验、非法值不被默认值遮错、
  多轴联动确实改变轮廓而非统一缩放、缺字与回退可区分。
- `test/legacy-compat.test.js`、`test/legacy-poster-run.test.js` 让旧海报
  样例运行到底，并与当前入口结果一致。
- `test/ui.smoke.mjs` 在真实浏览器里拖动轴、改文本，检查画布像素、布局
  宽度与前进量都随之变化，并检查越界提示。

重新生成基线（仅在有意改变可变字体行为时）：

```bash
node tools/snapshot-engine.mjs test/fixtures/engine-baseline.json
```

## 运行环境备注

容器里若缺少 Chromium 系统库，可把依赖 deb 解包到本地目录并设置
`LD_LIBRARY_PATH`（Playwright 浏览器本身用 `npx playwright install chromium`
安装）。界面本身只需 `npm run serve`。
