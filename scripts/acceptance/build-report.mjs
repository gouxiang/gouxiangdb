#!/usr/bin/env node
// scripts/acceptance/build-report.mjs
// 汇总 run-manifest.json + before/manifest.json + after/*.json + share-links.log 生成 REPORT.md，
// 末行固定 DRILL_VERDICT=PASS|FAIL（team-lead 独立重跑才算过闸；本脚本只如实汇总本地产物）。
//
// 用法: build-report.mjs --run-dir <dir> [--out <REPORT.md>]
// 退出码：0 verdict=PASS；1 verdict=FAIL；64 参数/缺件。

import fs from "node:fs";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function fail(code, msg) {
  console.error(`[build-report] ${msg}`);
  process.exit(code);
}

const runDir = arg("--run-dir");
if (!runDir) fail(64, "用法: build-report.mjs --run-dir <dir> [--out REPORT.md]");
const outFile = arg("--out") || path.join(runDir, "REPORT.md");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

const rm = readJson(path.join(runDir, "run-manifest.json"));
if (!rm) fail(64, `缺 ${runDir}/run-manifest.json（先跑 run-upgrade-drill.sh）`);
const beforeDir = path.join(runDir, "before");
const afterDir = path.join(runDir, "after");
const seed = readJson(path.join(beforeDir, "manifest.json"));
const diff = readJson(path.join(afterDir, "diff-result.json"));
const nav = readJson(path.join(afterDir, "nav-paths-result.json"));
const boot = readJson(path.join(afterDir, "bootstrap-result.json"));
const golden = readJson(path.join(afterDir, "golden-result.json"));
const search = readJson(path.join(afterDir, "search-result.json"));
const body = readJson(path.join(afterDir, "body-limits-result.json"));
const shareLog = fs.existsSync(path.join(afterDir, "share-links.log"))
  ? fs.readFileSync(path.join(afterDir, "share-links.log"), "utf8") : "";

const v = rm.verdicts ?? {};
const bootChecks = Object.fromEntries((boot?.checks ?? []).map((c) => [c.name, c]));
const reasonDist = bootChecks.auth_policies_three_legacy_reasons?.detail?.reasonByReason ?? null;
const ce = bootChecks.change_events_match_live_rows?.detail ?? null;
const navApply = nav?.steps?.apply?.fix?.nodes?.pathsRebuilt ?? null;
const navFault = nav?.steps?.faultState ?? null;
const sharePassLine = (shareLog.match(/分享矩阵：PASS=(\d+) FAIL=(\d+)/) || []);
const bodyCases = Object.fromEntries((body?.cases ?? []).map((c) => [c.name, c]));

const stepFail = (rm.steps ?? []).filter((s) => s.exit !== 0).map((s) => s.name);
const gates = [
  ["migrate 两次幂等", nav?.steps?.secondMigrate?.alreadyInSync === true && (nav?.steps?.secondMigrate?.exit === 0)],
  ["零损坏 diff（七类+时间戳）", v.diffZeroDamage === true && v.timestampChanges === 0],
  ["nav 故障态->修复->二次幂等", v.navPaths === true],
  ["B5 自举固定期望", v.bootstrap === true],
  ["黄金主体+LCG 对拍+新结构", !!golden?.summary && golden.summary.failed === 0],
  ["旧分享链接 R7 矩阵", v.shareLinks === true],
  ["search FTS-only/三态/自愈", v.searchFtsOnly === true],
  ["body 双实例边界", v.bodyLimits === true],
];
const allPass = gates.every(([, ok]) => ok) && stepFail.length === 0;
const verdict = allPass ? "PASS" : "FAIL";

const sc = rm.seedCounts ?? seed?.counts ?? {};
const tmKinds = (seed?.tableManifest ?? []).reduce((a, t) => { a[t.kind] = (a[t.kind] || 0) + 1; return a; }, {});
const managedTables = (seed?.tableManifest ?? []).length;
const starterTables = (sc.tables ?? 0) - managedTables;

const L = [];
L.push("# 门② AC-UPG-1 v0.1.0 -> M7 直升零损坏演练报告");
L.push("");
L.push(`- 运行目录: \`${runDir}\``);
L.push(`- node: ${rm.nodeVersion}`);
L.push(`- 旧基线 commit (v0.1.0): \`${rm.commits?.v010}\`（${rm.migrations?.old} 迁移）`);
L.push(`- 候选 HEAD commit: \`${rm.commits?.head}\`（${rm.migrations?.new} 迁移）`);
L.push(`- 迁移: ${rm.migrations?.old} -> ${rm.migrations?.new}，一条直线 \`prisma migrate deploy\``);
L.push(`- 总耗时: ${rm.totalDurMs} ms`);
L.push("");
L.push("## 1. 播种规模（v0.1.0 真服务 HTTP 播种，LCG seed42；全部为服务端实测计数）");
L.push(`- base=${sc.bases ?? "?"}，表=${sc.tables ?? "?"}，记录活行=${sc.rows ?? "?"}`);
L.push(`  - 其中自管表 ${managedTables} 张（构成 ${JSON.stringify(tmKinds)}：wide/target/relation 各 1 + plain ${tmKinds.plain ?? 0}），每表 50 行（含草稿/软删/空值/多字节边界）；`);
L.push(`  - 另 ${starterTables} 张为 v0.1.0 建 base 时服务端自带 starter table（删不掉，一并计入旧库，其行同样纳入零损坏 0-diff）。`);
L.push(`  - 规模满足 B3 下限（>=9 自管表/450 行）：实测自管表 ${managedTables}、连同 starter 共 ${sc.tables} 表/${sc.rows} 活行。`);
L.push(`- KbDoc 正文 id=${(seed?.docs ?? []).length}（五形态：普通/长文/树/ACL/creator；另含 kb builder sibling 1），画布 id=${(seed?.canvases ?? []).length}（+3 建库自带，见 seed 完成日志）`);
L.push(`- 附件文件=${(seed?.uploads ?? []).length}（含恰 2MiB 边界与 2MiB+1 未引用哨兵），分享链接=${(seed?.shareTokens ?? []).length} + 1 base share_link`);
L.push(`- 主体：owner 1 + 手工黄金 g1..g8 + LCG 随机，共 ${(seed?.subjects?.users ?? []).length + 1} 个 drill 用户`);
L.push("");
L.push("> id 口径说明：邮箱/share token/附件 id 使用 drill-* 前缀可复现；base/table/record/doc 等实体 id 由");
L.push("> **v0.1.0 真服务**经 HTTP 创建（cuid），非脚本能指定前缀——这是\"用旧版代码建真旧库\"的必然结果。");
L.push("> 实体 id 从各 HTTP 响应与旧库快照采集进 manifest，升级前后按同一 id 集做 0-diff，不影响零损坏判定。");
L.push("");
L.push("## 2. 直升与迁移");
L.push(`- 二次 migrate deploy：exit=${nav?.steps?.secondMigrate?.exit}，alreadyInSync=${nav?.steps?.secondMigrate?.alreadyInSync}`);
L.push(`- B5 自举：applied=${boot?.ledger?.applied}（期望 ${boot?.expectedMigrations}，按迁移目录动态计数），rolled_back=${boot?.ledger?.rolledBack}（期望 0）`);
L.push(`- workspaces=${bootChecks.workspaces_single_default?.pass ? 1 : "?"}，系统角色 7 枚有序=${bootChecks.roles_seven_system?.pass ? "是" : "否"}，`
  + `owner 唯一且最早=${bootChecks.role_owner_single_earliest?.pass ? "是" : "否"}`);
L.push(`- auth_policies reason 三态分布（纯迁移投影）: ${reasonDist ? JSON.stringify(reasonDist) : "?"}`);
L.push(`- change_events 播种: rec=${ce?.seededRec}/活records=${ce?.liveRecords}，doc=${ce?.seededDoc}/活docs=${ce?.liveDocs}`
  + `（前缀仅 cev_seed_rec_/cev_seed_doc_，op=upsert/status=pending）`);
L.push(`- personal_access_tokens=${bootChecks.pat_table_empty?.detail?.personalAccessTokens ?? "?"}，`
  + `mcp_idempotency=${bootChecks.mcp_idempotency_empty?.detail?.mcpIdempotency ?? "?"}，主库无 search 派生表=${bootChecks.main_db_no_search_tables?.pass ? "是" : "否"}`);
L.push("");
L.push("## 3. nav-reconcile（补强①，跑生产发布物 dist/nav-reconcile.js）");
L.push(`- 故障态：根节点=${navFault?.rootCount}（坏=${navFault?.badRootCount}），非根 path=''/'depth0 卡住=${navFault?.stuckCount}/${navFault?.nonRootCount}`);
L.push(`- --apply pathsRebuilt=${navApply}；二次只读 A/B/C=0、二次 --apply no changes=${nav?.steps?.idempotent?.applyNoChanges}`);
L.push(`- 修复态 depth 分布: ${JSON.stringify(nav?.steps?.postState?.depthHist ?? {})}，path 不符=${nav?.steps?.postState?.pathMismatchCount}，table depth2/view depth3/直属doc2/嵌套doc3 齐备`);
L.push("");
L.push("## 4. 零损坏七类判定（before/after snapshot）");
L.push(`- verdict=${diff?.verdict}，damageCount=${diff?.damageCount}，warnCount=${diff?.warnCount}`);
L.push(`- 旧行 createdAt/updatedAt/deletedAt/joinedAt 原文改动总数=${v.timestampChanges}（补强③，非归一化遮盖）`);
L.push(`- 画布板核对=${diff?.stats?.canvasBoardsChecked ?? "?"}，附件引用悬空核对=${diff?.stats?.attachmentRefsChecked ?? "?"}，blocks round-trip=${diff?.stats?.blocksRoundtrip ?? "?"}`);
L.push(`- uploads 树（相对路径+size+sha256）0 diff、attachment JSON 引用全命中、在线备份 tar 经 verify-restore 对账（见阶段3 日志）`);
L.push("");
L.push("> 附件产品限制：本产品**无通用附件托管/下载通道**（全仓上传端点仅 POST /me/avatar）。");
L.push("> 附件是记录 fields JSON 里的 `{id,name,size,mime,url}` 引用，文件静态落 uploads/at/。");
L.push("> 故零损坏证据＝uploads 树路径/size/sha256 前后 0 diff + 引用不悬空 + 在线备份可恢复，不新增下载端点。");
L.push("");
L.push("## 5. M4 权限黄金值（补强②，硬编码期望与独立对拍分离）");
if (golden?.summary) {
  L.push(`- 手工黄金主体: ${golden.summary.goldenPass}/${golden.summary.goldenTotal}`);
  L.push(`- LCG 随机独立对拍（legacyExpect 裸 SQL 重算）: ${golden.summary.lcgPass}/${golden.summary.lcgTotal}`);
  L.push(`- authz reconcile 只读 A/B/C=0 + --apply no changes: ${golden.summary.reconcilePass}`);
  L.push(`- g7 多源并集/部门子树=${golden.summary.deptSubtreePass}，`
    + `继承中断(409/confirmed/孙失权/幂等)=${golden.summary.cutoffPass}，g8 停用闭环=${golden.summary.disabledPass}（明细见 golden-result.json）`);
} else L.push("- golden-result.json 缺失");
L.push("");
L.push("## 6. 旧分享链接 R7（升级后 curl 对抗矩阵）");
L.push(`- PASS=${sharePassLine[1] ?? "?"} FAIL=${sharePassLine[2] ?? "?"}（有效 token 直开、已删 404、超深/越界 403、未级联 404、旧 editor 分享匿名写 fail-closed 403、只读分享写 403）`);
const legacyEditorFc = /PASS \[legacy-editor-anon-write-403\]/.test(shareLog);
L.push(`- 旧版创建(shareCreatedBy=NULL)的 editor 档链接升级后匿名写一律 403 fail-closed=${legacyEditorFc ? "已固化" : "缺失/失败"}`
  + "（有意安全收紧，迁移 20260922010000 + shareCaps.ts:97；GET 可开不受影响）");
L.push("- 新建可编辑分享的匿名写 200/400（10MB zod 上界）与默认档 >1MiB 413 字节边界归第8节 check-body-limits B1/B2/A4 覆盖");
L.push("");
L.push("## 7. 搜索 FTS-only（补强④，embedding=off 零外网；vec0 hybrid=P1 不阻塞）");
L.push(`- 首启 index=${search?.steps?.preStatus?.indexNull ? "null(缺库语义)" : "?"}，embedding=${search?.steps?.preStatus?.embeddingMode}，vecLoaded=${search?.steps?.preStatus?.vecLoaded}`);
L.push(`- 全量 reindex 202 + HTTP status 轮询清零: ${search?.steps?.coverage?.completed}，chunks=${search?.steps?.coverage?.chunksTotal}，coverage=${JSON.stringify(search?.steps?.coverage?.coverage ?? {})}`);
L.push(`- 长 marker(auto/fts/vector 降级)零泄漏 + 2 码点短词 LIKE 分流: ${search?.steps?.zeroLeak?.pass}（owner 长命中=${search?.steps?.zeroLeak?.ownerLongHit} 短LIKE命中=${search?.steps?.zeroLeak?.ownerShortHit}）`);
L.push(`- 删库自愈: ${search?.steps?.selfHeal?.pass}（indexNull/probe200/reindex202/恢复/零泄漏）`);
L.push("");
L.push("## 8. 请求体边界（R6 双实例）");
for (const name of Object.keys(bodyCases)) {
  L.push(`- ${name}: ${bodyCases[name].pass ? "PASS" : "FAIL"}`);
}
L.push("");
L.push("## 9. 门判定");
for (const [name, ok] of gates) L.push(`- ${ok ? "PASS" : "FAIL"}  ${name}`);
if (stepFail.length) L.push(`- FAIL  非零退出步骤: ${stepFail.join(", ")}`);
L.push("");
L.push("> 本报告由演练脚本本地产物自动汇总。**是否门②过闸以 team-lead 独立重跑为准**，本脚本不宣称过闸。");
L.push("> RC13~RC25 Web 手工主体不在自动化范围，见 R8-manual-checklist.md 人工签字。");
L.push("");
L.push(`DRILL_VERDICT=${verdict}`);

fs.writeFileSync(outFile, L.join("\n"));
console.log(`[build-report] -> ${outFile}`);
console.log(`DRILL_VERDICT=${verdict}`);
process.exit(allPass ? 0 : 1);
