#!/usr/bin/env node
/**
 * GouXiangDB —— 单机模式（不建立任何协同连接）DOM 基线快照器
 * ============================================================
 *
 * 目的：为「多人实时协同接线后界面一个像素都不许变」这条红线，提供机器可验证的判据。
 *      判据 = 同一台测试机、同一账号、同一 URL/操作序列下，页面 DOM 逐元素一致。
 *
 * 用法：
 *   0) （换机器 / 重建数据时才需要）幂等建种，建完请重取基线
 *        node apps/web/scripts/dom-snapshot-seed.mjs --base-url http://192.168.31.167
 *   1) 取基线
 *        node apps/web/scripts/dom-snapshot.mjs --out docs/design/2026-09-collab/baseline/pre-wire
 *   2) 与基线比对（实时抓取当前站点，逐元素 diff）
 *        node apps/web/scripts/dom-snapshot.mjs --compare docs/design/2026-09-collab/baseline/pre-wire
 *   3) 两份已落盘产物互比（例如「接线后」产物 vs「接线前」基线）
 *        node apps/web/scripts/dom-snapshot.mjs --compare <新目录> --baseline <基线目录>
 *
 * 常用参数：
 *   --base-url <url>   被测站点，默认 http://192.168.31.167
 *   --only doc,canvas,grid   只抓/只比部分页面
 *   --headed           显示浏览器窗口（排查用）
 *   --out <dir>        --compare 时用作「本次实时抓取」的落盘目录（默认临时目录）
 *   --json            以 JSON 输出比对结果（便于 CI 消费）
 *
 * 鉴权（按优先级）：
 *   1) --token <jwt> 或环境变量 GX_TOKEN
 *   2) 环境变量 GX_JWT_SECRET + GX_USER_ID（本地按 apps/api/src/domain/org/authState.ts:45
 *      issueToken 的算法签 HS256，payload = { userId, tv, iat, exp }）
 *   3) 内置默认值：测试机 192.168.31.167 的 apps/api/.env JWT_SECRET + 库内 e2e 账号
 *      （仅为「一条命令可跑」；换站点请用前两种方式覆盖）
 *   登录态经 localStorage["gx-auth"] 注入（store/auth.ts:27，zustand persist 格式），不点击登录表单，
 *   避免登录流程本身引入的 DOM 噪声与不确定性。
 *
 * 纪律：本脚本只读被测站点（不写任何业务数据），不修改任何业务代码。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 去噪规则（DENOISE_VERSION = v1）
 * ─────────────────────────────────────────────────────────────────────────
 * 逐元素指纹字段：t=标签名、d=子树深度、c=归一化 class、a=归一化属性、x=直接文本
 * （不含随机 id / 动态 data-* / 时间戳 / hover-focus 态 / 滚动位置）
 *
 * R1 结构定位：只记录 DFS 前序 + 深度，不用元素路径下标 —— 下标会随任何一个节点增删而整体错位，
 *    反而让「一处变化」被放大成整页差异。
 * R2 剔除脚本样式节点：script / style / link / meta / noscript / template。它们不进渲染树，
 *    且 link/script 的构建产物 hash（assets/index-Drxbjf_o.js）会在每次重构建时变化 —— 保留必然误报。
 * R3 随机身份类属性一律剔除：id、for、name、aria-controls/labelledby/describedby/owns。
 *    依据：本机实测 doc 页的 data-block/data-editable/data-zone-before/data-zone-after/data-focus
 *    值形如 bmubf0br71a7w6（slate 每次装载重新生成的块 key），画布页 plait-data-id 是图形身份而非外观。
 *    这些属于「数据身份」，不属于「界面」。
 * R4 data-* 白名单：只保留语义稳定的 data-*（见 KEEP_DATA_ATTRS）。理由是动态 data-* 太多，
 *    白名单比黑名单可解释、可审计；新出现的 data-* 默认不参与比对（属于「预警项」，见 README）。
 * R5 class 归一化：按空格切分 → 丢弃机器生成的段（css-1x2y3z / element-3f2a9b / 含 ≥8 位十六进制 /
 *    大小写数字混合的 base36 随机串）→ 剩余段排序后拼回。class 顺序不影响样式，排序可消除 React 重排噪声。
 * R6 style 归一化：保留全部子属性名，但数值统一四舍五入到 1 位小数、transform 内的浮点同样归一化。
 *    原因：画布 SVG 的 width/height（如 2244px）、表格列宽（876px）是 JS 按字体测量算出来的浮点数，
 *    亚像素抖动会造成假差异；1 位小数既压掉抖动又能捕捉真实的尺寸变化。
 * R7 SVG 路径与坐标：d / transform / points / viewBox / x / y / cx / cy / r / x1 / y1 / x2 / y2 /
 *    stroke-width / stroke-dasharray 等数值属性同样做 R6 归一化（画布图元轮廓由缩放与布局决定）。
 * R8 文本遮罩：直接文本（trim + 折叠空白后）把时间戳 2026-09-21 16:33 / 16:33 / 「3 分钟前」/「刚刚」
 *    替换为 <TS>/<T>/<REL>。依据：侧栏与列表里的「更新于 …」必然随时间变化，不遮罩则每次跑都误报。
 * R9 资源 URL 归一化：href/src 中的构建 hash（`-DxBjf_o.js`）替换为 <HASH>；data-href 等语义链接保留。
 * R10 状态归零：dump 前 window.scrollTo(0,0)、所有可滚动容器 scrollTop/scrollLeft 归零、
 *    document.activeElement.blur()。理由：滚动位置与焦点环是「当次会话状态」，不是界面结构。
 * R11 稳态等待：轮询 document.querySelectorAll('*').length，连续 3 次相同才 dump（最多 12s），
 *    另加固定 1200ms 让 CSS 过渡落定。理由：最大误报来源不是属性噪声，而是「上一次跑时还没渲染完」。
 * R12 视口固定：1440x900、deviceScaleFactor=1、时区/locale 固定、禁用动画偏好 follow。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';
import { SEED, makeToken } from './dom-snapshot-seed.mjs';

const DENOISE_VERSION = 'v1';
const SCRIPT_VERSION = '1.0.0';

// ── 固定操作序列（唯一真源：种子标识统一来自 dom-snapshot-seed.mjs）──────
const PAGES = [
  {
    key: 'doc',
    label: '文档编辑器（Markdown 富文本）',
    // 操作序列：打开知识库首页 → 点击中间面板条目「基线-文档」
    open: `/kb/${SEED.kbId}`,
    click: SEED.doc.title,
    route: `/kb/${SEED.kbId}/doc/${SEED.doc.id}`,
    expectText: SEED.doc.expectText,
  },
  {
    key: 'canvas',
    label: '画布（4 个图形：矩形/椭圆/三角/文本）',
    open: `/kb/${SEED.kbId}`,
    click: SEED.canvas.title,
    route: `/kb/${SEED.kbId}/canvas/${SEED.canvas.id}`,
    expectText: SEED.canvas.expectText,
  },
  {
    key: 'grid',
    label: '数据表（网格视图 5 行）',
    open: `/base/${SEED.baseId}`,
    click: SEED.tableTitle,
    route: `/base/${SEED.baseId}/table/${SEED.tableId}/view/${SEED.viewId}`,
    expectText: SEED.gridExpectText,
  },
];

// ── 去噪规则常量（会被序列化进浏览器上下文）──────────────────────────────
const RULES = {
  // R4：只保留这些语义稳定的 data-*
  KEEP_DATA_ATTRS: [
    'data-nav-row',
    'data-nav-entity',
    'data-l1',
    'data-l2-scope',
    'data-l2-trash',
    'data-open',
    'data-heading-id',
    'data-href',
    'data-slate-node',
    'data-slate-leaf',
    'data-slate-string',
    'data-slate-editor',
    'data-readonly',
    'data-enhance',
    'data-gx-overlay',
    'data-state',
    'data-gx-view-tab',
    'data-gx-view-more',
    'data-gx-view-new',
    'data-gx-toolbar-view-row',
    'data-entity-icon-trigger',
    'data-gx-truncated',
    'data-testid',
  ],
  // R3：随机身份/引用类属性，一律剔除
  DROP_ATTRS: [
    'id',
    'for',
    'name',
    'aria-controls',
    'aria-labelledby',
    'aria-describedby',
    'aria-owns',
    'plait-data-id',
  ],
  // R6/R7：数值归一化属性
  NUM_ATTRS: [
    'd',
    'transform',
    'points',
    'viewBox',
    'x',
    'y',
    'cx',
    'cy',
    'r',
    'x1',
    'y1',
    'x2',
    'y2',
    'width',
    'height',
    'stroke-width',
    'stroke-dasharray',
    'zindex',
  ],
  SKIP_TAGS: ['script', 'style', 'link', 'meta', 'noscript', 'template'],
};

// ── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE_URL = String(args['base-url'] || process.env.GX_BASE_URL || 'http://192.168.31.167').replace(/\/$/, '');
const HEADED = !!args.headed;
const ONLY = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
const AS_JSON = !!args.json;

// ── 鉴权 ───────────────────────────────────────────────────────────────
// makeToken 与种子脚本共用一份实现（dom-snapshot-seed.mjs），避免两处签发逻辑漂移。

// 页面内执行的指纹函数（R1–R9 全在此实现，规则随函数一起序列化进浏览器）
function inPageFingerprint(rules) {
  const {
    KEEP_DATA_ATTRS, DROP_ATTRS, NUM_ATTRS, SKIP_TAGS,
  } = rules;
  const keepData = new Set(KEEP_DATA_ATTRS);
  const dropAttrs = new Set(DROP_ATTRS);
  const numAttrs = new Set(NUM_ATTRS);
  const skipTags = new Set(SKIP_TAGS);

  // R6/R7：数值四舍五入到 1 位小数
  const roundNums = (s) =>
    String(s).replace(/-?\d+\.\d+/g, (m) => {
      const v = Math.round(parseFloat(m) * 10) / 10;
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
    });

  // R5：class 段去噪
  const isNoisyClass = (part) => {
    if (!part) return true;
    if (/^(css|sc|jsx)-[a-z0-9]{4,}$/i.test(part)) return true; // css-in-js
    if (/^[a-z]+-[0-9a-f]{5,}$/i.test(part)) return true; // element-3f2a9b
    if (/[0-9a-f]{8,}/i.test(part) && !/^[a-z-]+$/i.test(part)) return true; // 内嵌长十六进制
    if (part.length >= 6 && /[a-z]/.test(part) && /[A-Z0-9]/.test(part) && /^[A-Za-z0-9_-]+$/.test(part)) return true; // base36 随机串
    return false;
  };
  const normClass = (cls) =>
    cls
      .split(/\s+/)
      .filter((p) => !isNoisyClass(p))
      .sort()
      .join(' ');

  // R8：文本遮罩
  const maskText = (t) =>
    t
      .replace(/\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/g, '<TS>')
      .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<T>')
      .replace(/\d+\s*(秒|分钟|分|小时|天|周|个月|月|年)前/g, '<REL>')
      .replace(/刚刚/g, '<REL>');

  // R9：资源 URL 中的构建 hash
  const normUrl = (v) => String(v).replace(/-[A-Za-z0-9_]{8,}\.(js|css|png|jpe?g|svg|woff2?|json|webp)/g, '-<HASH>.$1');

  // R7b：画布图形层的 path 路径抽象 —— 只留命令序列，数值全部替换为 #
  const abstractPath = (d) => String(d).replace(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi, '#');
  const r1 = (n) => Math.round(n * 10) / 10;

  const nodes = [];
  const walk = (el, depth) => {
    const tag = el.tagName.toLowerCase();
    if (skipTags.has(tag)) return;
    // 是否位于画布图形层（plait 的 element-host 子树）
    const inBoardShape = !!(el.closest && el.closest('.element-host'));

    // 直接文本子节点（叶子文本），避免父节点重复记录全文
    let directText = '';
    for (const n of el.childNodes) if (n.nodeType === 3) directText += n.nodeValue;
    directText = maskText(directText.replace(/\s+/g, ' ').trim());

    const attrs = {};
    for (const at of Array.from(el.attributes)) {
      const name = at.name;
      if (dropAttrs.has(name)) continue; // R3
      if (name === 'class' || name === 'style') continue; // 单独处理
      if (name.startsWith('data-') && !keepData.has(name)) continue; // R4
      let v = at.value;
      if (name === 'd' && inBoardShape) v = abstractPath(v); // R7b
      else if (numAttrs.has(name)) v = roundNums(v);
      if (name === 'href' || name === 'src') v = normUrl(v);
      attrs[name] = v;
    }
    const cls = el.getAttribute('class');
    if (cls) attrs.class = normClass(cls); // R5
    const style = el.getAttribute('style');
    if (style) attrs.style = roundNums(style.replace(/\s+/g, ' ').trim()); // R6

    const rec = { t: tag, d: depth };
    if (attrs.class) rec.c = attrs.class;
    const rest = { ...attrs };
    delete rest.class;
    if (Object.keys(rest).length) rec.a = rest;
    if (directText) rec.x = directText;
    // R7b 补：几何走 getBBox（视觉包围盒），替代不可复现的精确坐标 —— 图形挪位/改尺寸仍能被发现
    if (inBoardShape && (tag === 'path' || tag === 'polygon' || tag === 'polyline' || tag === 'ellipse' || tag === 'rect' || tag === 'line' || tag === 'text')) {
      try {
        const bb = el.getBBox();
        rec.b = [r1(bb.x), r1(bb.y), r1(bb.width), r1(bb.height)];
      } catch {
        /* 非 SVG 或不可测量，忽略 */
      }
    }
    nodes.push(rec);

    for (const c of el.children) walk(c, depth + 1);
  };

  if (document.documentElement) walk(document.documentElement, 0);
  return {
    url: location.pathname,
    title: document.title,
    nodeCount: nodes.length,
    nodes,
  };
}

// R11：等待 DOM 节点数稳定
async function waitForStableDom(page, { tries = 40, interval = 300, need = 3 } = {}) {
  let same = 0;
  let last = -1;
  for (let i = 0; i < tries; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('*').length);
    if (n === last && n > 0) same++;
    else same = 0;
    last = n;
    if (same >= need) return n;
    await page.waitForTimeout(interval);
  }
  return last;
}

// R10：滚动位置归零 + 焦点归零
async function resetState(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollTop) el.scrollTop = 0;
      if (el.scrollLeft) el.scrollLeft = 0;
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
}

async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
}

/**
 * 固定操作序列的「点击条目」一步。
 * 实测：侧栏 L1 只有库条目（data-nav-row="item" 且 data-nav-entity="base|kb"），
 * 文档 / 画布条目在中间面板，没有 data-nav-row 标记，因此按可见文本定位，
 * 且每点一次都校验 URL 是否落到目标路由 —— 只有落到目标才算「点中」。
 */
async function clickNav(page, label, route) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    () => page.locator('[data-nav-row="item"]', { hasText: new RegExp(`^${escaped}$`) }).first(),
    () => page.getByText(label, { exact: true }).first(),
    () => page.getByText(label).first(),
  ];
  for (const make of candidates) {
    const loc = make();
    const ok = await loc.click({ timeout: 6_000 }).then(() => true).catch(() => false);
    if (!ok) continue;
    await page.waitForTimeout(900);
    if (page.url().includes(route)) return true;
  }
  return false;
}

async function capturePage(page, spec, baseUrl, outDir) {
  const result = { key: spec.key, label: spec.label, route: spec.route, ok: false };
  // ── 固定操作序列：库首页 → 点击条目 → 落到目标路由 ──
  try {
    await gotoSettled(page, baseUrl + spec.open);
    await waitForStableDom(page); // 等中间面板/侧栏渲染完再点
    await page.waitForTimeout(500);
  } catch (e) {
    result.error = `打开 ${spec.open} 失败: ${String(e).slice(0, 120)}`;
    return result;
  }
  const clicked = await clickNav(page, spec.click, spec.route);
  if (!page.url().includes(spec.route)) {
    // 点击未落到目标（布局变化/条目被裁切）→ 回退直达 URL，保证产物可复现
    result.navFallback = clicked ? 'click-missed' : 'click-not-found';
    try {
      await gotoSettled(page, baseUrl + spec.route);
    } catch (e) {
      result.error = `直达 ${spec.route} 失败: ${String(e).slice(0, 120)}`;
      return result;
    }
  }
  result.settledUrl = page.url();

  if (spec.expectText) {
    await page
      .locator(`text=${spec.expectText}`)
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .catch(() => {
        result.warning = `未等到标志文本「${spec.expectText}」`;
      });
  }
  await page.evaluate(() => (document.fonts && document.fonts.ready) || null).catch(() => {});
  await waitForStableDom(page);
  await page.waitForTimeout(1200); // 让 CSS 过渡落定
  await resetState(page);
  await page.waitForTimeout(200);

  const shot = path.join(outDir, spec.key, 'screenshot.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });

  const fp = await page.evaluate(inPageFingerprint, RULES);
  fp.capturedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, spec.key, 'dom.json'), JSON.stringify(fp, null, 1));

  Object.assign(result, {
    ok: true,
    nodeCount: fp.nodeCount,
    url: fp.url,
    screenshot: path.relative(outDir, shot),
    domJson: path.relative(outDir, path.join(outDir, spec.key, 'dom.json')),
  });
  return result;
}

async function capture(baseUrl, outDir) {
  const { token, source } = makeToken({ token: args.token });
  fs.mkdirSync(outDir, { recursive: true });
  const specs = ONLY ? PAGES.filter((p) => ONLY.includes(p.key)) : PAGES;
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, // R12
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce', // 关掉动画，减少过渡中间态
  });
  await ctx.addInitScript(
    ([t, user]) => {
      localStorage.setItem('gx-auth', JSON.stringify({ state: { token: t, user }, version: 0 }));
    },
    [token, SEED.user],
  );
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });

  const results = [];
  for (const spec of specs) results.push(await capturePage(page, spec, baseUrl, outDir));

  const manifest = {
    tool: 'apps/web/scripts/dom-snapshot.mjs',
    seedTool: 'apps/web/scripts/dom-snapshot-seed.mjs',
    scriptVersion: SCRIPT_VERSION,
    denoiseVersion: DENOISE_VERSION,
    baseUrl,
    capturedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 900 },
    authSource: source,
    seed: {
      kbId: SEED.kbId,
      baseId: SEED.baseId,
      tableId: SEED.tableId,
      viewId: SEED.viewId,
      docId: SEED.doc.id,
      canvasId: SEED.canvas.id,
      rowNames: SEED.rowNames,
    },
    operationSequence:
      '先打开库首页，再点击固定条目落到目标路由；点击未命中时回退为直达 URL（会在 manifest 标注 navFallback）',
    pages: results,
    consoleErrors,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  return manifest;
}

// ── 比对（LCS 对齐，输出增/删/改条目）──────────────────────────────────
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // 滚动数组求 LCS 长度表（n,m 均在千级，内存可控）
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'keep' });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
      ops.push({ op: 'del', left: i });
      i++;
    } else {
      ops.push({ op: 'add', right: j });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'del', left: i++ });
  while (j < m) ops.push({ op: 'add', right: j++ });
  return ops;
}

function summarize(node) {
  const bits = [`t=${node.t}`, `d=${node.d}`];
  if (node.c) bits.push(`c="${node.c}"`);
  if (node.a) bits.push(`a=${JSON.stringify(node.a).slice(0, 120)}`);
  if (node.x) bits.push(`x="${node.x.slice(0, 60)}"`);
  return bits.join(' ');
}

function diffPages(baseFp, curFp) {
  const left = baseFp.nodes.map((n) => JSON.stringify(n));
  const right = curFp.nodes.map((n) => JSON.stringify(n));
  const ops = lcsDiff(left, right);

  const entries = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.op === 'keep') continue;
    // del 紧跟 add → 合并为「改」
    if (op.op === 'del' && ops[k + 1] && ops[k + 1].op === 'add') {
      changed++;
      entries.push({
        kind: 'changed',
        before: summarize(baseFp.nodes[op.left]),
        after: summarize(curFp.nodes[ops[k + 1].right]),
      });
      k++;
      continue;
    }
    if (op.op === 'del') {
      removed++;
      entries.push({ kind: 'removed', before: summarize(baseFp.nodes[op.left]) });
    } else {
      added++;
      entries.push({ kind: 'added', after: summarize(curFp.nodes[op.right]) });
    }
  }

  return {
    nodeCountBaseline: baseFp.nodeCount,
    nodeCountCurrent: curFp.nodeCount,
    added,
    removed,
    changed,
    total: added + removed + changed,
    entries,
  };
}

function compareDirs(baseDir, curDir) {
  const out = { baseDir, currentDir: curDir, pages: {}, identical: true };
  const specs = ONLY ? PAGES.filter((p) => ONLY.includes(p.key)) : PAGES;
  for (const spec of specs) {
    const bp = path.join(baseDir, spec.key, 'dom.json');
    const cp = path.join(curDir, spec.key, 'dom.json');
    if (!fs.existsSync(bp)) {
      out.pages[spec.key] = { error: `基线缺少 ${path.relative(baseDir, bp)}` };
      out.identical = false;
      continue;
    }
    if (!fs.existsSync(cp)) {
      out.pages[spec.key] = { error: `当前产物缺少 ${path.relative(curDir, cp)}` };
      out.identical = false;
      continue;
    }
    const baseFp = JSON.parse(fs.readFileSync(bp, 'utf8'));
    const curFp = JSON.parse(fs.readFileSync(cp, 'utf8'));
    const d = diffPages(baseFp, curFp);
    const routeChanged = baseFp.url !== curFp.url;
    if (routeChanged) d.routeChanged = { baseline: baseFp.url, current: curFp.url };
    out.pages[spec.key] = { label: spec.label, ...d };
    if (d.total > 0 || routeChanged) out.identical = false;
  }
  return out;
}

function printCompare(res) {
  const lines = [];
  lines.push(`基线目录：${res.baseDir}`);
  lines.push(`当前产物：${res.currentDir}`);
  lines.push('');
  for (const [key, p] of Object.entries(res.pages)) {
    if (p.error) {
      lines.push(`[${key}] ✗ ${p.error}`);
      continue;
    }
    const flag = p.total === 0 && !p.routeChanged ? '✓ 零差异' : '✗ 有差异';
    lines.push(
      `[${key}] ${flag}  节点 ${p.nodeCountBaseline} → ${p.nodeCountCurrent}  ` +
        `新增 ${p.added} / 删除 ${p.removed} / 变更 ${p.changed}（合计 ${p.total}）`,
    );
    if (p.routeChanged) lines.push(`    路由变化：${p.routeChanged.baseline} → ${p.routeChanged.current}`);
    p.entries.slice(0, 50).forEach((e) => {
      if (e.kind === 'changed') lines.push(`    ~ 基线: ${e.before}\n      当前: ${e.after}`);
      else if (e.kind === 'removed') lines.push(`    - ${e.before}`);
      else lines.push(`    + ${e.after}`);
    });
    if (p.entries.length > 50) lines.push(`    … 其余 ${p.entries.length - 50} 条已省略（--json 可拿全量）`);
  }
  lines.push('');
  lines.push(res.identical ? '结论：全部页面逐元素一致（零差异）' : '结论：存在差异，见上');
  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  if (args.compare && args.baseline) {
    // 静态比对：两份已落盘产物
    const res = compareDirs(path.resolve(String(args.baseline)), path.resolve(String(args.compare)));
    if (AS_JSON) console.log(JSON.stringify(res, null, 2));
    else console.log(printCompare(res));
    process.exit(res.identical ? 0 : 1);
  }

  if (args.compare) {
    // 实时抓取当前站点 → 与基线目录比对
    const baseDir = path.resolve(String(args.compare));
    const liveDir = path.resolve(String(args.out || path.join(os.tmpdir(), `gx-dom-live-${Date.now()}`)));
    console.error(`[capture] ${BASE_URL} → ${liveDir}`);
    const manifest = await capture(BASE_URL, liveDir);
    for (const p of manifest.pages) {
      console.error(`  ${p.ok ? '✓' : '✗'} ${p.key} ${p.ok ? `${p.nodeCount} 节点` : p.error}`);
    }
    const res = compareDirs(baseDir, liveDir);
    res.liveDir = liveDir;
    if (AS_JSON) console.log(JSON.stringify(res, null, 2));
    else console.log(printCompare(res));
    process.exit(res.identical ? 0 : 1);
  }

  // 默认：抓基线
  if (!args.out) {
    console.error('用法：\n  node apps/web/scripts/dom-snapshot.mjs --out <目录>\n  node apps/web/scripts/dom-snapshot.mjs --compare <基线目录>');
    process.exit(2);
  }
  const outDir = path.resolve(String(args.out));
  console.error(`[capture] ${BASE_URL} → ${outDir}`);
  const manifest = await capture(BASE_URL, outDir);
  let failed = 0;
  for (const p of manifest.pages) {
    if (p.ok) console.error(`  ✓ ${p.key}  ${p.nodeCount} 节点  ${p.screenshot}${p.navFallback ? `  (导航回退: ${p.navFallback})` : ''}`);
    else {
      failed++;
      console.error(`  ✗ ${p.key}  ${p.error}`);
    }
  }
  console.error(`已写入 ${path.join(outDir, 'manifest.json')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('运行失败：', e);
  process.exit(1);
});
