#!/usr/bin/env node
// scripts/acceptance/seed-legacy.mjs
// 门② G2 旧库播种器：对运行中的 v0.1.0 真服务（HTTP）播种五类对象 + 20 个权限主体。
//
// 纪律（team-lead R6/R7/R8 裁决）：
//   - 只经 v0.1.0 服务 HTTP 建数据（满足手册"用 v0.1.0 代码建真库"），不手写 schema/不绕过服务；
//   - 附件物理文件直接落 UPLOAD_ROOT（旧库无通用上传端点），记录里放 {id,name,size,mime,url} 引用；
//   - 确定性 LCG seed42，固定邮箱/密码，可复跑；幂等防护：库中已有 drill 主体即 exit 10；
//   - 产出 manifest.json（share token / 关键实体 id / 附件清单），供 dump/check/golden 使用。
//
// 退出码：0 成功；64 参数/环境错；10 目标库非空（疑似重放）；1 播种失败。

import path from "node:path";
import fs from "node:fs";
import { createClient } from "./lib/http.mjs";
import { openDb, appTables } from "./lib/db.mjs";
import { makeRng } from "./lib/lcg.mjs";
import { materializeUploads, attachmentCellValue } from "./seed/uploads.mjs";
import { seedRecords } from "./seed/records.mjs";
import { seedSubjects } from "./seed/subjects.mjs";
import { buildDocs, buildLongDoc } from "./seed/docs.mjs";
import { buildCanvases } from "./seed/canvas.mjs";

const OWNER_EMAIL = "drill-owner@example.test";
const OWNER_PASSWORD = "drill-owner-pw-2026";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[seed-legacy] ${msg}`);
  process.exit(code);
}

const baseUrl = arg("--base-url");
const dbFile = arg("--db");
const uploadRoot = arg("--uploads");
const outDir = arg("--out");
if (!baseUrl || !dbFile || !uploadRoot || !outDir) {
  fail(64, "用法: seed-legacy.mjs --base-url http://127.0.0.1:PORT --db <abs.db> --uploads <dir> --out <dir>");
}

async function main() {
  // 幂等防护 + 旧 schema 校验
  let db;
  try {
    db = openDb(dbFile, { readonly: true });
  } catch (e) {
    fail(64, `打不开数据库（--db 必须是已由 v0.1.0 11 迁移建好的库）：${e.message}`);
  }
  const tables = appTables(db);
  if (tables.length !== 15) fail(10, `目标库不是 v0.1.0 旧 schema（期望 15 张应用表，实际 ${tables.length}）`);
  const existingUsers = db.prepare("SELECT count(*) c FROM users WHERE email LIKE 'drill-%@example.test'").get().c;
  if (existingUsers > 0) fail(10, `库中已存在 ${existingUsers} 个 drill 主体，疑似重放；请用全新旧库`);
  db.close();

  const api = createClient(baseUrl);

  // owner 注册（旧库首位用户 -> 升级后自举为 role_owner）
  await api.post("/auth/signup", { email: OWNER_EMAIL, password: OWNER_PASSWORD, displayName: "演练所有者" });
  // signup 直接发 token；但 createClient 未自动持有，重新登录拿 token
  const login = await api.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (login.status !== 200) fail(1, `owner 登录失败 ${login.status}`);
  api.setToken(login.json.token);
  const loginFactory = async (email, password) => {
    const c = createClient(baseUrl);
    const r = await c.raw("POST", "/auth/login", { email, password });
    if (r.status !== 200) throw new Error(`登录失败 ${email}: ${r.status}`);
    c.setToken(r.json.token);
    return c;
  };

  // 1) 附件落盘（确定性字节）
  const rng = makeRng(42);
  fs.mkdirSync(uploadRoot, { recursive: true });
  const uploads = materializeUploads(rng, uploadRoot);
  const referencedUploads = uploads.filter((u) => u.referenced);
  const attValues = attachmentCellValue(referencedUploads);
  console.log(`[seed] 附件 ${uploads.length} 个落盘（其中引用 ${referencedUploads.length}）`);

  // 2) 结构化记录：3 base x 3 表 x 50 行（含宽表/关联表）
  const rec = await seedRecords(api, { log: (l) => console.log(`[seed] ${l}`), attachmentValues: attValues });

  // 3) 知识库 + 10 篇正文 + 6 块普通画布
  const kb = await api.post("/kb", { name: "演练知识库", iconColor: "#0F6E56" });
  const kbId = kb.knowledgeBase.id;

  const docSibling = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "兄弟文档(内链目标)" });
  await api.put(`/kb/docs/${docSibling.doc.id}/content`, { content: "# 兄弟文档\n\n内链五形态指向我。\n" });

  const docs = buildDocs({
    canvasIdDeep: "cv_chain_c0",
    docSiblingId: docSibling.doc.id,
    publicHostBase: "http://127.0.0.1",
  });
  docs.push(buildLongDoc(makeRng(7), 20000));

  const docIds = [];
  for (const d of docs) {
    const created = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: d.title });
    await api.put(`/kb/docs/${created.doc.id}/content`, { content: d.content });
    docIds.push({ key: d.key, id: created.doc.id, title: d.title, bytes: Buffer.byteLength(d.content, "utf8") });
  }

  // 6 块普通画布
  const canvases = buildCanvases({ docRoot: docIds[0]?.id ?? docSibling.doc.id, docChild: docIds[1]?.id, docGrand: docIds[2]?.id, docOutOfScope: "doc_out_placeholder" });
  const canvasIds = [];
  for (const cv of canvases) {
    const created = await api.post(`/kb/${kbId}/docs`, { kind: "canvas", title: cv.title });
    await api.put(`/kb/docs/${created.doc.id}/content`, { content: cv.content });
    canvasIds.push({ key: cv.key, id: created.doc.id, title: cv.title });
  }

  // 4) 深 3 引用闭包链：C0(canvas,分享根) -gxDocRef-> C1(canvas) -> C2(canvas) -> docDeep4(第4层,越界403)
  const chain = [];
  for (let i = 0; i < 3; i++) {
    const c = await api.post(`/kb/${kbId}/docs`, { kind: "canvas", title: `深闭包链路 C${i}` });
    chain.push(c.doc.id);
  }
  const docDeep4 = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "深闭包第4层(越界)" });
  await api.put(`/kb/docs/${docDeep4.doc.id}/content`, { content: "# 第四层\n\n超过 REF_CLOSURE_MAX_DEPTH=3，匿名访问应 403。\n" });
  const chainContent = (idx) => JSON.stringify([
    { id: `chain_e${idx}`, type: "geometry", shape: "rectangle", angle: 0, points: [[{ x: 40, y: 40 }]],
      gxNote: `链路节点 ${idx}`, gxDocRef: { docId: idx === 2 ? docDeep4.doc.id : chain[idx + 1] } },
  ]);
  for (let i = 0; i < 3; i++) await api.put(`/kb/docs/${chain[i]}/content`, { content: chainContent(i) });

  // 完全独立的越界文档（不被任何闭包画布引用）
  const docOut = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "独立越界文档" });
  await api.put(`/kb/docs/${docOut.doc.id}/content`, { content: "# 独立越界\n\n不在任何分享闭包内，应 403。\n" });

  // 5) viewer 分享（includeChildren=false）+ 子文档（访问子应 404）
  const viewerRoot = docIds[0].id;
  const childDoc = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "viewer根的子文档", parentId: viewerRoot });
  await api.put(`/kb/docs/${childDoc.doc.id}/content`, { content: "# 子文档\n\n根未开级联，匿名访问应 404。\n" });

  // 6) 20 个权限主体（8 手工 + 12 LCG）
  const kbDocsAll = [...docIds.map((d) => ({ id: d.id, kind: "doc" })), ...canvasIds.map((c) => ({ id: c.id, kind: "canvas" }))];
  const subjects = await seedSubjects(api, loginFactory, { bases: rec.bases, kb: { kbId, docs: kbDocsAll } }, { log: (l) => console.log(`[seed] ${l}`) });

  // 7) 分享链接（>=5）
  const shareTokens = [];
  async function enableShare(docId, role, includeChildren = false) {
    const r = await api.post(`/kb/docs/${docId}/share`, { shareEnabled: true, shareRole: role, shareIncludeChildren: includeChildren });
    return r.share.shareToken;
  }
  // 7.1 doc viewer
  shareTokens.push({ name: "doc-viewer", kind: "doc", token: await enableShare(viewerRoot, "viewer", false), rootId: viewerRoot, canEdit: false });
  // 7.2 doc editor（匿名写 2MB 用独立 scratch，避免污染 golden）
  const editorDoc = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "匿名编辑Scratch" });
  await api.put(`/kb/docs/${editorDoc.doc.id}/content`, { content: "# scratch\n\n匿名写边界测试用，可被改写。\n" });
  shareTokens.push({ name: "doc-editor-scratch", kind: "doc", token: await enableShare(editorDoc.doc.id, "editor", false), rootId: editorDoc.doc.id, canEdit: true });
  // 7.3 canvas 直开
  shareTokens.push({ name: "canvas", kind: "canvas", token: await enableShare(canvasIds[0].id, "viewer", false), rootId: canvasIds[0].id, canEdit: false });
  // 7.4 深 3 闭包链根 C0
  shareTokens.push({
    name: "deep-closure", kind: "canvas", token: await enableShare(chain[0], "viewer", false), rootId: chain[0], canEdit: false,
    closure: { layer2: chain[1], layer3: chain[2], layer4_forbidden: docDeep4.doc.id },
  });
  // 7.5 已删目标
  const doomed = await api.post(`/kb/${kbId}/docs`, { kind: "doc", title: "将被删除的分享" });
  await api.put(`/kb/docs/${doomed.doc.id}/content`, { content: "# 删除目标\n\n分享后软删，token 应 404。\n" });
  const doomedToken = await enableShare(doomed.doc.id, "viewer", false);
  await api.del(`/kb/docs/${doomed.doc.id}`);
  shareTokens.push({ name: "deleted-doc", kind: "doc", token: doomedToken, rootId: doomed.doc.id, canEdit: false, deleted: true });
  // viewer 根未级联的子文档（404 期望）
  shareTokens.find((t) => t.name === "doc-viewer").nonCascadeChild = childDoc.doc.id;
  shareTokens.find((t) => t.name === "deep-closure").independentForbidden = docOut.doc.id;

  // 8) base 级旧分享链接（share_links 表，升级后行必须保留）
  const baseShare = await api.post(`/bases/${rec.bases[0].id}/share`, { role: "viewer" });

  const manifest = {
    schema: "gx-drill-legacy@1",
    seed: 42,
    owner: { email: OWNER_EMAIL, userId: null },
    counts: rec.counts,
    bases: rec.bases,
    tableManifest: rec.tableManifest,
    kb: { kbId, docSibling: docSibling.doc.id },
    docs: docIds,
    canvases: canvasIds,
    closureChain: { c0: chain[0], c1: chain[1], c2: chain[2], deep4: docDeep4.doc.id },
    docOutOfScope: docOut.doc.id,
    uploads,
    subjects,
    shareTokens,
    baseShareLink: { id: baseShare.link.id, token: baseShare.link.token, baseId: rec.bases[0].id, role: baseShare.link.role },
  };
  // owner userId 由 /auth/me 补
  const me = await api.get("/auth/me");
  manifest.owner.userId = me.user?.id ?? me.id ?? null;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[seed] 完成。分享 ${shareTokens.length} 个，正文 ${docIds.length}，画布 ${canvasIds.length + 3}，附件 ${uploads.length}`);
  console.log(`[seed] manifest -> ${path.join(outDir, "manifest.json")}`);
}

main().catch((e) => {
  console.error("[seed-legacy] 失败：", e);
  process.exit(1);
});
