#!/usr/bin/env node
/**
 * GouXiangDB —— DOM 基线快照的「种子数据」单一真源 + 幂等建种脚本
 * =================================================================
 *
 * 为什么需要它：DOM 基线只有在「两次跑的是同一批数据」时才有意义。
 * 本模块导出的 SEED 常量被 dom-snapshot.mjs 直接引用（页面 URL 里的 docId/canvasId
 * 就来自这里），因此改种子必然牵动基线 —— 这是一处刻意设计的耦合。
 *
 * 用法（仅在测试机上执行，需要能写数据的 token）：
 *   node apps/web/scripts/dom-snapshot-seed.mjs --base-url http://192.168.31.167 [--out <目录>]
 *
 * 幂等性：按标题（文档/画布）与「名称」字段值（表格行）查找既有对象，命中则复用；
 *        只有内容与期望不一致时才 PUT 覆盖。重复执行不会产生重复数据。
 *
 * 注意：本脚本会写测试机数据（不写业务代码）；生产库不要跑。
 *
 * 种子清单：
 *   - 文档「基线-文档」：含 H1/H2、段落、粗体、行内代码、链接、无序列表、代码块
 *   - 画布「基线-画布」：4 个图形（矩形 A / 椭圆 B / 三角 C / 文本 D），元素 id 固定为
 *     baseline-*-001，便于肉眼定位；坐标取负值区间，与 plait 默认视口原点一致（否则图形落在可视区外）
 *   - 数据表「数据表 1」（base=E2E验证库，view=网格视图）：5 行，名称=基线行-一..五
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── 固定标识（与 167 测试机现状一致；换机器需同步调整）─────────────────
export const SEED = {
  kbId: 'cmuazmt0t000sed30azpsdcol',
  baseId: 'cmuazigmr0005bcnbdtyn0edb',
  tableId: 'cmuazigmx000bbcnbrv0orw91',
  viewId: 'cmuazign3000nbcnbtbgjn2fb',
  tableTitle: '数据表 1',
  gridExpectText: '基线行-五',
  user: { id: 'cmuazi2v40001bcnb6wfh19fz', email: 'e2e@gx.local', displayName: '端到端验证' },
  fields: {
    name: 'cmuazigmy000dbcnbgnv4tk2e',
    qty: 'cmuazigmz000fbcnb4u6gognt',
    note: 'cmuazign2000lbcnbf5mqtwd1',
  },
  doc: {
    id: 'cmubetwae0019ed30m006cpgl',
    title: '基线-文档',
    // 渲染完成标志：出现这句话说明 Markdown 正文已渲染
    expectText: '基线快照文档',
    markdown: `# 基线快照文档

这是 **接线前基线** 用的固定内容，用来验证多人协同接入后界面逐元素不变。

## 段落与行内样式

普通段落里带 **粗体文字**、\`inline code\`，以及一个 [示例链接](https://example.com/baseline)。

## 列表

- 第一项：标题层级
- 第二项：段落与行内样式
- 第三项：列表与代码块

## 代码块

\`\`\`ts
const baseline = "pre-wire";
\`\`\`
`,
  },
  canvas: {
    id: 'cmubetwfv001ged3056kmbh88',
    title: '基线-画布',
    expectText: '矩形 A',
  },
  // 表格行的「名称」值，用于幂等匹配
  rowNames: ['基线行-一', '基线行-二', '基线行-三', '基线行-四', '基线行-五'],
};

/** 画布 content（plait element 数组的 JSON 字符串）；结构取自 UI 实测样本 */
export function canvasContent() {
  const geo = (id, shape, points, text, extra = {}) => ({
    id,
    type: 'geometry',
    shape,
    angle: 0,
    opacity: 1,
    text: {
      children: [{ text }],
      type: 'paragraph',
      ...(shape === 'text' ? {} : { align: 'center' }),
    },
    points,
    ...extra,
  });
  return JSON.stringify([
    geo('baseline-rect-001', 'rectangle', [[-352, -122], [-132, -2]], '矩形 A', { strokeWidth: 2 }),
    geo('baseline-ellipse-001', 'ellipse', [[-92, -122], [128, -2]], '椭圆 B', { strokeWidth: 2 }),
    geo('baseline-triangle-001', 'triangle', [[168, -122], [388, -2]], '三角 C', { strokeWidth: 2 }),
    geo('baseline-text-001', 'text', [[-352, -212], [-152, -190]], '基线画布文本 D', { autoSize: true }),
  ]);
}

export const TABLES_ROWS = [
  { name: '基线行-一', qty: 1, note: '第一条固定数据' },
  { name: '基线行-二', qty: 2, note: '第二条固定数据' },
  { name: '基线行-三', qty: 3, note: '第三条固定数据' },
  { name: '基线行-四', qty: 4, note: '第四条固定数据' },
  { name: '基线行-五', qty: 5, note: '第五条固定数据' },
];

// ── 鉴权（与 dom-snapshot.mjs 同策略）───────────────────────────────────
export function makeToken(opts = {}) {
  const injected = opts.token || process.env.GX_TOKEN;
  if (injected) return { token: String(injected), source: 'GX_TOKEN/--token' };
  const secret = process.env.GX_JWT_SECRET || 'dev-secret-change-in-prod-gouxiangdb-v2';
  const userId = process.env.GX_USER_ID || 'cmuazi2v40001bcnb6wfh19fz';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ userId, tv: 0, iat: now, exp: now + 7 * 24 * 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return {
    token: `${h}.${p}.${sig}`,
    source: process.env.GX_JWT_SECRET ? 'GX_JWT_SECRET+GX_USER_ID' : '内置默认（测试机 dev secret + e2e 用户）',
    userId,
  };
}

async function api(baseUrl, token, method, apiPath, body) {
  const res = await fetch(baseUrl + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-GX-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 幂等建种：返回 { docId, canvasId, recordIds, actions } */
export async function ensureSeed(baseUrl, token) {
  const actions = [];
  const { kbId, tableId, fields, doc, canvas, rowNames } = SEED;

  // 1) 文档
  const docsRes = await api(baseUrl, token, 'GET', `/api/kb/${kbId}/docs`);
  const docs = docsRes.docs || [];
  let docId = (docs.find((d) => d.kind === 'doc' && d.title === doc.title) || {}).id;
  if (!docId) {
    docId = (await api(baseUrl, token, 'POST', `/api/kb/${kbId}/docs`, { kind: 'doc', title: doc.title })).doc.id;
    actions.push(`新建文档 ${doc.title} → ${docId}`);
  } else actions.push(`复用文档 ${doc.title} → ${docId}`);
  const cur = await api(baseUrl, token, 'GET', `/api/kb/docs/${docId}`);
  if ((cur.doc.content || '') !== doc.markdown) {
    await api(baseUrl, token, 'PUT', `/api/kb/docs/${docId}/content`, { content: doc.markdown });
    actions.push(`覆盖文档内容（${doc.markdown.length} 字符）`);
  } else actions.push('文档内容已一致，跳过写入');

  // 2) 画布
  let canvasId = (docs.find((d) => d.kind === 'canvas' && d.title === canvas.title) || {}).id;
  if (!canvasId) {
    canvasId = (await api(baseUrl, token, 'POST', `/api/kb/${kbId}/docs`, { kind: 'canvas', title: canvas.title })).doc.id;
    actions.push(`新建画布 ${canvas.title} → ${canvasId}`);
  } else actions.push(`复用画布 ${canvas.title} → ${canvasId}`);
  const wantCanvas = canvasContent();
  const curCanvas = await api(baseUrl, token, 'GET', `/api/kb/docs/${canvasId}`);
  if ((curCanvas.doc.content || '') !== wantCanvas) {
    await api(baseUrl, token, 'PUT', `/api/kb/docs/${canvasId}/content`, { content: wantCanvas });
    actions.push('覆盖画布内容（4 个图形）');
  } else actions.push('画布内容已一致，跳过写入');

  // 3) 表格行
  const recRes = await api(baseUrl, token, 'GET', `/api/records?tableId=${tableId}`);
  const existing = (recRes.records || []).filter((r) => rowNames.includes(r.fields?.[fields.name]));
  const recordIds = [];
  for (let i = 0; i < TABLES_ROWS.length; i++) {
    const row = TABLES_ROWS[i];
    const want = { [fields.name]: row.name, [fields.qty]: row.qty, [fields.note]: row.note };
    const hit = existing.find((r) => r.fields?.[fields.name] === row.name);
    if (hit) {
      recordIds.push(hit.id);
      const same = Object.entries(want).every(([k, v]) => String(hit.fields?.[k] ?? '') === String(v));
      if (!same) actions.push(`行 ${row.name} 字段不一致（保留原值，如需完全一致请手工核对）`);
    } else {
      const created = await api(baseUrl, token, 'POST', `/api/records?tableId=${tableId}`, { fields: want });
      recordIds.push(created.record?.id ?? created.id);
      actions.push(`新建行 ${row.name}`);
    }
  }
  if (recordIds.length === rowNames.length) actions.push(`表格行共 ${recordIds.length} 条（复用/新建完成）`);

  return {
    docId,
    canvasId,
    recordIds,
    routes: {
      doc: `/kb/${kbId}/doc/${docId}`,
      canvas: `/kb/${kbId}/canvas/${canvasId}`,
      grid: `/base/${SEED.baseId}/table/${tableId}/view/${SEED.viewId}`,
    },
    actions,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const baseUrl = String(get('base-url', process.env.GX_BASE_URL || 'http://192.168.31.167')).replace(/\/$/, '');
  const { token, source } = makeToken({ token: get('token') });
  console.error(`[seed] ${baseUrl}（鉴权来源：${source}）`);
  const res = await ensureSeed(baseUrl, token);
  res.actions.forEach((a) => console.error('  ' + a));
  const outDir = get('out');
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'seed-ids.json'), JSON.stringify(res, null, 2));
    console.error(`已写入 ${path.join(outDir, 'seed-ids.json')}`);
  }
  console.log(JSON.stringify(res, null, 2));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((e) => {
    console.error('运行失败：', e);
    process.exit(1);
  });
}
