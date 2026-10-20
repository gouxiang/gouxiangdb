#!/usr/bin/env node
/**
 * 交接快照脚本 —— 动工前先跑一次
 *
 * 用途：本目录的交接文档（HANDOFF.md / REFACTOR-SCOPE.md）是**静态**的，
 * 而 UI 重构动工时距离本文档写完可能已隔了数周、且期间另有开发任务合入，
 * 文档里写死的文件清单/令牌取值/测试基线都可能已过期。
 *
 * 因此：**不要直接照抄文档里的现状描述**，而是先跑本脚本拿一份「当下真实状态」，
 * 再与文档中的目标状态比对，得到真正需要改造的差集。
 *
 * 用法：node docs/design/2026-10-ui-redesign/actual/v6/scripts/snapshot.mjs
 *
 * 注意：本机（16GB）只跑轻量扫描，不跑全量测试/构建。
 *       测试基线请在 VM15（192.168.31.15）上执行，见 HANDOFF.md 验收章节。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* v6/scripts -> v6 -> actual -> 2026-10-ui-redesign -> design -> docs -> <repo root> */
const ROOT = [0, 0, 0, 0, 0, 0].reduce((p) => path.dirname(p), HERE);
const WEB = path.join(ROOT, 'apps/web');
const rel = (p) => path.relative(ROOT, p);

/** 递归收集文件 */
function walk(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...walk(full, ext));
    } else if (e.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

const countLines = (f) => {
  try {
    return readFileSync(f, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
};

const snap = { generatedAt: new Date().toISOString(), repoRoot: ROOT };

/* ① 路由表：从 App.tsx 抽取 path= 与 element= */
try {
  const app = readFileSync(path.join(WEB, 'src/App.tsx'), 'utf8');
  const routes = [...app.matchAll(/path="([^"]+)"[^>]*element=\{<([A-Za-z0-9_]+)/g)].map(
    (m) => ({ path: m[1], component: m[2] }),
  );
  snap.routes = routes;
  snap.routeCount = routes.length;
} catch (e) {
  snap.routes = `READ_FAIL: ${e.message}`;
}

/* ② 关键落点文件是否存在（交接契约里提到的东西） */
const LANDMARKS = [
  'apps/web/src/features/workspace/PrimaryNav.tsx',
  'apps/web/src/features/workspace/SecondaryNav.tsx',
  'apps/web/src/features/workspace/SecondaryNavTableOps.tsx',
  'apps/web/src/features/workspace/SecondaryNavKbOps.tsx',
  'apps/web/src/features/workspace/lib/nav-footer.ts',
  'apps/web/src/features/workspace/lib/menu-sections.ts',
  'apps/web/src/features/views/ViewShell.tsx',
  'apps/web/src/features/shell/AppShell.tsx',
  'apps/web/src/features/shell/TopBar.tsx',
  'packages/design-tokens/src/colors.ts',
  'docs/design/2026-09-ui-restructure/UI-SPEC.md',
];
snap.landmarks = LANDMARKS.map((p) => {
  const full = path.join(ROOT, p);
  return { path: p, exists: existsSync(full), lines: existsSync(full) ? countLines(full) : 0 };
});

/* ③ 令牌冲突自检：规范参考设计值 vs 代码/底板当前值 */
const TOKEN_CMP = [
  { key: 'accent', spec: '#3A6DF0', probe: /--brand:\s*(#[0-9a-fA-F]{3,8})/, file: 'docs/design/2026-10-ui-redesign/actual/v6/src/shared.css' },
  { key: 'bg', spec: '#F7F9FC', probe: /--bg:\s*(#[0-9a-fA-F]{3,8})/, file: 'docs/design/2026-10-ui-redesign/actual/v6/src/shared.css' },
  { key: 'hairline', spec: '#E9EFF9', probe: /--line:\s*(#[0-9a-fA-F]{3,8})/, file: 'docs/design/2026-10-ui-redesign/actual/v6/src/shared.css' },
];
snap.tokenCheck = TOKEN_CMP.map((t) => {
  const full = path.join(ROOT, t.file);
  if (!existsSync(full)) return { ...t, current: null, conflict: 'FILE_MISSING' };
  const m = readFileSync(full, 'utf8').match(t.probe);
  const current = m ? m[1].toLowerCase() : null;
  return {
    key: t.key,
    spec: t.spec.toLowerCase(),
    current,
    conflict: !current ? 'NOT_FOUND' : current !== t.spec.toLowerCase(),
  };
});

/* ④ 输出 */
console.log(JSON.stringify(snap, null, 2));
const bad = snap.tokenCheck.filter((t) => t.conflict === true);
if (bad.length) {
  console.error(
    `\n⚠️  令牌冲突 ${bad.length} 项：` +
      bad.map((t) => `${t.key} 规范=${t.spec} 当前=${t.current}`).join('; ') +
      `\n     → 必须先把 packages/design-tokens/src/colors.ts 迁移到规范取值，再动页面。`,
  );
}
