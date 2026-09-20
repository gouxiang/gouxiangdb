#!/usr/bin/env node
// scripts/refresh-progress-data.mjs
// 作用：刷新「进度看板.html」与「进度数据.js」（一次调用全量重算）。
// 用法：GX_API_TESTS=<n> GX_WEB_TESTS=<n> GX_SHARED_TESTS=<n> GX_NEXT_ACTION="<下一片>" node scripts/refresh-progress-data.mjs
//       （在仓库根执行；不传环境变量时沿用上次的数字，不会被清空）
//
// ★ 设计铁律（2026-09-17 定，因出现「切片表写着 S6 待开始、时间线却已到 M6-FE」的自相矛盾）：
//   看板里**所有会随进度变化的内容都由本脚本渲染**，HTML 内只留 <!--GX_*_START-->…<!--GX_*_END--> 占位标记。
//   每片过闸只改本文件顶部的 M6_SLICES / HEADLINE_* 一处，再跑本脚本 → 页头更新时间、一句话现状、KPI、
//   里程碑状态、切片明细、时间线一次性全部重算。**禁止再往 HTML 里手写这些内容**（手写必漂移）。
//
// 为什么数据用 .js 而不是 .json：本地以 file:// 打开 HTML 时浏览器会拦截 fetch 读本地 JSON，
// 但允许 <script src="本地文件">。故数据以「挂全局变量的小脚本」形式提供。

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "进度数据.js");
const HTML = path.join(ROOT, "进度看板.html");
const MAX_COMMITS = 12; // 时间线上限（同时约束页面 DOM 与内存）

// ════════════════════════════════════════════════════════════════
// ① 唯一真相源 —— 每片过闸只改这一段，然后跑本脚本
// ════════════════════════════════════════════════════════════════
// status: done = 已过闸 / run = 进行中 / wait = 待开始
const M6_SLICES = [
  { id: "S0", title: "基线锁定（把“不能破坏的行为”冻成回归护栏）", status: "done", note: "<code>a474a7f</code> 15:59 · 复核出计划里 19 处过期信息" },
  { id: "S1", title: "访问令牌基座（只显示一次、停用连带吊销、删除级联）", status: "done", note: "<code>4141e99</code> 16:09 · 迁移 #23" },
  { id: "S2", title: "MCP 传输层（官方 SDK、只对 MCP 放开 11MB、按令牌限流）", status: "done", note: "<code>55c90f8</code> 16:23 + <code>7a86fb8</code> 16:33" },
  { id: "S3", title: "双闸门鉴权（工具按权限动态注册；未授权工具与不存在工具响应完全一致）", status: "done", note: "<code>8d46a9e</code> 16:31 + <code>ef4eccf</code> 17:11（只写令牌可用）" },
  { id: "S4", title: "表/记录能力：读 5 工具 + 创建/更新/删除写工具", status: "done", note: "<code>6277c92</code> 读 · <code>5f5780e</code>/<code>68dbf5a</code>/<code>b8d6738</code>/<code>04de085</code> 写原语搬运 · <code>4ace2fe</code>/<code>b1af5e4</code>/<code>0333694</code> 三写工具" },
  { id: "S5", title: "文档块引擎下沉共享包 + 文档读写工具（4 个）", status: "done", note: "<code>656f9fb</code> 引擎下沉 <code>@gx/blocks</code>（纯移动 <b>0 行改动</b>）· <code>dbec6f1</code> 四工具 · <code>c4fdbdf</code> 修「baseVersion 必填致只写身份死锁」· <code>2fc9aa0</code> 测试真断言化" },
  { id: "S6", title: "画布读取 + 命令行入口 + 三份语言说明", status: "done", note: "<code>b1c3688</code> 19:36 只读 <code>canvas.get_board</code> + stdio 第二入口 + 三语言说明书 · <code>9232eda</code> 19:43 说明书时序改正（只读期不宣称写入已上线）" },
  { id: "S6b", title: "画布结构校验器 + 图元写入（保证 AI 画的图网页端能正常打开）", status: "done", note: "<code>d1a7a72</code> 20:07 校验器 · <code>3bf7691</code> 20:28 写入工具 · <code>1d2151b</code> 20:38 · <code>99c16ae</code> 21:07 <b>服务端产出 JSON → 前端真画布加载</b> golden（chromium+webkit）。总监变异测试:删掉「禁自带 id」黑名单 → 3 例立即变红，证明断言有效" },
  { id: "S7", title: "审计与幂等", status: "done", note: "<code>b4d51b2</code>+<code>4b06af8</code> 21:20 审计四枚事件 + 请求幂等（并发同键只执行一次）+ 30 秒超时 · <code>006d334</code> 21:27" },
  { id: "S8", title: "三种客户端连通 + 四类对抗回归", status: "done", note: "<code>6d898b0</code> 22:04 · 15 文件 +2008 <b>纯新增</b>（零生产码）；<code>498e201</code> 22:30 补 stdio 入口 IDOR 两族 + 陈旧 baseVersion 409；<code>58f0845</code> 22:35 文档对齐 <b>64 例</b>。总监独立复验：e2e <b>6 文件 64 例全绿</b>（20.8s，真 TCP / unix socket / stdio 网络栈）；常规门收集总数恒 <b>2089</b>=基线；tsc 0 / eslint 0 error；读码确认 IDOR 带「隐藏资源确实存在」前置证明 + 反例护栏、Inspector 真自动化（pin 0.16.6）、审计连 token 随机段都零泄漏" },
  { id: "S9", title: "出口收口（决策记录、接口文档、运维手册、接入说明）", status: "done", note: "<code>3446851</code> ADR-0051~55 · <code>1b51b96</code> openapi 只增 pats/x-mcp + runbook/onboarding + 出口基线 · <code>06d3a5c</code> caddy 笔误 · <code>7990038</code> org 默认挂载姿态行" },
  { id: "M6-FE", title: "前端令牌管理页", status: "done", note: "<code>fbb4981</code> 22:00 设置→MCP 接入（列表 / 新建一次性明文 / 吊销）。总监复验：web 23 文件 <b>278 例</b>全绿、类型检查 0；<b>令牌零落 localStorage/sessionStorage/URL、关闭即焚</b>（亲自 grep + 读码确认）" },
];

// 片数/百分比由脚本自动算，只有下面两句描述需要人维护
const HEADLINE_DONE_NOTE = "（S0–S9 全套工具 + 审计幂等 + 前端令牌页 + 出口硬门全部落地并独立复验；M6 = 12/12 完成）";
const HEADLINE_CURRENT = "，现执行 M7 企业版总验收：门①②③④已过闸（③含 P1 修复后的 R6/R6b 两面复跑），门⑤判「有条件过」，api 全量 2145 / web 314 / shared 56 全绿 0 失败；剩余门⑥ x86/fpk 外部面与门⑧四项签字。本轮另修一处真缺陷：M5 增量索引链路从未接线（`249df44`）";

const DEFAULT_NEXT_ACTION = "M7 总验收：门⑥ x86_64/fpk 外部面取证 → 门⑦ checklist 的 26 条未做项收口 → 门⑧ RELEASE 重写与四项姿态签字";

// ════════════════════════════════════════════════════════════════
// ② 采集事实（git + 测试基线）
// ════════════════════════════════════════════════════════════════
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** 去掉 Conventional Commits 前缀，便于阅读：feat(m6-s4): xxx -> xxx */
function pretty(subject) {
  return subject.replace(/^(feat|fix|test|docs|refactor|chore|perf|build|ci)(\([^)]*\))?:\s*/i, "");
}

let commits = [];
let head = "";
let headTime = "";
let commitsTotal = null;
let commitsToday = null;
try {
  head = git(["rev-parse", "--short", "HEAD"]);
  const raw = git(["log", `-${MAX_COMMITS}`, "--date=format:%m-%d %H:%M", "--pretty=%h%x1f%ad%x1f%s"]);
  commits = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, time, subject] = line.split("\x1f");
      return { hash, time, subject: pretty(subject) };
    });
  headTime = commits[0]?.time ?? "";
  commitsTotal = Number(git(["rev-list", "--count", "HEAD"]));
  const n = new Date();
  const ymd = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  commitsToday = git(["log", `--since=${ymd}T00:00:00`, "--oneline"]).split("\n").filter(Boolean).length;
} catch {
  // 非 git 环境 / 命令失败：输出空数据，页面进入"未接入"降级态而不是误报
}

// 测试基线（本脚本不跑测试，避免拖慢；跑完由派工流程用环境变量传入）
const counts = {
  api: Number(process.env.GX_API_TESTS || 0) || null,
  web: Number(process.env.GX_WEB_TESTS || 0) || null,
  shared: Number(process.env.GX_SHARED_TESTS || 0) || null,
};

// 未传环境变量时沿用上次已知数字，不清空
let prev = {};
if (existsSync(OUT)) {
  try {
    const m = readFileSync(OUT, "utf8").match(/window\.__GX_PROGRESS__\s*=\s*(\{[\s\S]*\});?\s*$/);
    if (m) prev = JSON.parse(m[1]);
  } catch { /* ignore */ }
}
const mergedCounts = {
  api: counts.api ?? prev?.counts?.api ?? null,
  web: counts.web ?? prev?.counts?.web ?? null,
  shared: counts.shared ?? prev?.counts?.shared ?? null,
};

const nextAction = process.env.GX_NEXT_ACTION || prev?.nextAction || DEFAULT_NEXT_ACTION;

const payload = {
  generatedAt: new Date().toISOString(),
  head,
  headTime,
  commitsTotal,
  commitsToday,
  counts: mergedCounts,
  nextAction,
  slices: M6_SLICES.map((s) => ({ id: s.id, status: s.status })),
  commits,
};

writeFileSync(OUT, `window.__GX_PROGRESS__ = ${JSON.stringify(payload, null, 2)};\n`, "utf8");

// ════════════════════════════════════════════════════════════════
// ③ 渲染看板区块（HTML 里只有占位标记，内容全部由这里生成）
// ════════════════════════════════════════════════════════════════
const PILL = {
  done: ["p-done", "已过闸"],
  run: ["p-run", "进行中"],
  wait: ["p-wait", "待开始"],
};
const M6_TOTAL = M6_SLICES.length;
const doneCount = M6_SLICES.filter((s) => s.status === "done").length;
const runningIds = M6_SLICES.filter((s) => s.status === "run").map((s) => s.id);

function stamp(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const blocks = {
  GX_UPDATED: `最后更新：${stamp(new Date())}<code>${head || "—"}</code> &nbsp;|&nbsp; 全部数字由项目总监在本机实测`,

  GX_HEADLINE:
    `<b>一句话现状：</b>M0–M5 全部完成；<b>M6（AI 接入服务）${M6_TOTAL} 片已完成 ${doneCount} 片</b>` +
    HEADLINE_DONE_NOTE +
    HEADLINE_CURRENT,

  GX_KPI:
    `<div class="kpi"><div class="n">${commitsTotal ?? "—"}</div><div class="l">累计提交（今日 ${commitsToday ?? "—"} 条）</div></div>\n` +
    `<div class="kpi"><div class="n">${mergedCounts.api ?? "—"}</div><div class="l">后端自动化测试用例（0 失败）</div></div>\n` +
    `<div class="kpi"><div class="n">${mergedCounts.web ?? "—"}</div><div class="l">前端测试用例</div></div>\n` +
    `<div class="kpi"><div class="n">${mergedCounts.shared ?? "—"}</div><div class="l">共享包测试用例（shared-types + canvas）</div></div>\n` +
    `<div class="kpi"><div class="n">0</div><div class="l">类型检查错误（三包）</div></div>`,

  GX_M6STATUS:
    doneCount >= M6_TOTAL
      ? `<span class="pill p-done">已完成</span>`
      : `<span class="pill p-run">进行中 ${doneCount}/${M6_TOTAL} 片</span>`,

  GX_M6SLICES: M6_SLICES.map((s) => {
    const [cls, label] = PILL[s.status] ?? PILL.wait;
    return `<tr><td>${s.id}</td><td>${s.title}</td><td><span class="pill ${cls}">${label}</span></td><td>${s.note}</td></tr>`;
  }).join("\n"),

  GX_NEXT: `${nextAction}${runningIds.length ? `（在途：${runningIds.join(" / ")}）` : ""}`,
};

// 同步写回 HTML（双保险：外部脚本被拦 / 直接开本地文件也能完整渲染）
if (existsSync(HTML)) {
  let html = readFileSync(HTML, "utf8");
  let touched = 0;

  const oneLine = JSON.stringify(payload);
  const dataRe = /<!--GX_DATA_START-->[\s\S]*?<!--GX_DATA_END-->/;
  const dataBlock =
    "<!--GX_DATA_START-->\n" +
    "<!-- 内嵌数据快照：由 scripts/refresh-progress-data.mjs 生成（外部脚本被拦时仍能渲染） -->\n" +
    `<script>window.__GX_PROGRESS__ = ${oneLine};</script>\n` +
    "<!--GX_DATA_END-->";
  if (dataRe.test(html)) {
    html = html.replace(dataRe, dataBlock);
    touched++;
  } else {
    console.warn("[refresh-progress-data] 未找到 GX_DATA 标记，跳过内嵌快照");
  }

  for (const [key, content] of Object.entries(blocks)) {
    const re = new RegExp(`<!--${key}_START-->[\\s\\S]*?<!--${key}_END-->`);
    if (re.test(html)) {
      html = html.replace(re, `<!--${key}_START-->\n${content}\n<!--${key}_END-->`);
      touched++;
    } else {
      console.warn(`[refresh-progress-data] 未找到 ${key} 标记，跳过该区块`);
    }
  }

  writeFileSync(HTML, html, "utf8");
  console.log(`[refresh-progress-data] 已重算看板 ${touched} 个区块（含内嵌数据快照）`);
}

console.log(`[refresh-progress-data] 已写入 ${OUT}`);
console.log(
  `  head=${head} 最近提交=${headTime} 时间线=${commits.length} 条 | M6 进度=${doneCount}/${M6_TOTAL} | 提交总数=${commitsTotal} 今日=${commitsToday}`
);
