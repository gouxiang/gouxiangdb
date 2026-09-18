// scripts/acceptance/rollback/seed.mjs
// 门③最小种子：在【全开姿态】的真 dist 服务上经 HTTP 播种，产出后续每旗复用的 context.json。
//
// 必须在全开姿态播种的原因（读码核实）：
//   - signup 仅在 enterpriseOrg on 时 bootstrapFirstOwnerTx 自举首位 owner（auth.ts:44-55）；
//   - R3 要验证"旧 members 三表守卫"，需 owner + 已授权成员 + 未授权局外人三种身份；
//   - R4/R5/R6 需要 base/table/带可检索标记词的记录。
//
// 纯 HTTP 播种，不直连业务库；只写 RUN_DIR 下的 context.json（含令牌与各 id）。

import fs from "node:fs";
import { parseArgs, http } from "./probe.mjs";

async function j(method, base, path, token, body) {
  const r = await http(base, method, path, { token, body });
  if (r.status < 200 || r.status > 299) {
    throw new Error(`${method} ${path} -> ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.json;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args["base-url"];
  const out = args.out;
  if (!base || !out) throw new Error("用法：seed.mjs --base-url URL --out context.json");

  // 1) owner（首位用户 -> 全开姿态自举为 ws_default owner）
  const owner = await j("POST", base, "/api/auth/signup", null, {
    email: "owner@rollback.local",
    password: "owner-pass-123",
    displayName: "Owner",
  });
  const ownerToken = owner.token;

  // 2) 第二用户（稍后被加为 base viewer，用于 R3 旧守卫 allow 判定）
  const member = await j("POST", base, "/api/auth/signup", null, {
    email: "member@rollback.local",
    password: "member-pass-123",
    displayName: "Member",
  });
  // 3) 第三用户（永不授权，用于 R3 旧守卫 deny 403）
  const outsider = await j("POST", base, "/api/auth/signup", null, {
    email: "outsider@rollback.local",
    password: "outsider-pass-123",
    displayName: "Outsider",
  });

  // 4) base + 一张表（服务端自动建"名称"主字段）
  const baseCreated = await j("POST", base, "/api/bases", ownerToken, {
    name: "回滚门 Base",
    iconColor: "#378ADD",
  });
  const baseId = baseCreated.base.id;

  const tableCreated = await j(
    "POST",
    base,
    `/api/tables?baseId=${encodeURIComponent(baseId)}`,
    ownerToken,
    { name: "探针表", withDefaults: false },
  );
  const tableId = tableCreated.table.id;
  const primaryFieldId = tableCreated.table.primaryFieldId;

  // 5) 三条记录，主字段含唯一英文标记词，供 FTS trigram 命中（zephyrmarker）
  const markers = ["zephyrmarker alpha", "zephyrmarker beta", "普通记录无标记"];
  const recordIds = [];
  for (const name of markers) {
    const rec = await j(
      "POST",
      base,
      `/api/records?tableId=${encodeURIComponent(tableId)}`,
      ownerToken,
      { fields: { [primaryFieldId]: name } },
    );
    if (rec.record?.id) recordIds.push(rec.record.id);
    else if (rec.id) recordIds.push(rec.id);
  }

  // 6) 知识库（R1 旧 /api 面存活旁证 + 检索 docs 域）
  const kb = await j("POST", base, "/api/kb", ownerToken, {
    name: "回滚门知识库",
    iconColor: "#0F6E56",
  });
  const kbId = kb.knowledgeBase.id;
  const doc = await j("POST", base, `/api/kb/${kbId}/docs`, ownerToken, {
    kind: "doc",
    title: "zephyrmarker 文档",
  });
  await j("PUT", base, `/api/kb/docs/${doc.doc.id}/content`, ownerToken, {
    content: "# zephyrmarker doc\n\n回滚门可检索正文。\n",
  });

  // 7) 把第二用户授权为该 base 的 viewer（旧 members 表面，R3 allow）
  const invite = await j(
    "POST",
    base,
    `/api/bases/${encodeURIComponent(baseId)}/members`,
    ownerToken,
    { email: "member@rollback.local", role: "viewer" },
  );

  const ctx = {
    baseUrl: base,
    baseId,
    tableId,
    primaryFieldId,
    kbId,
    docId: doc.doc.id,
    recordIds,
    marker: "zephyrmarker",
    tokens: { owner: ownerToken, member: member.token, outsider: outsider.token },
    emails: {
      owner: "owner@rollback.local",
      member: "member@rollback.local",
      outsider: "outsider@rollback.local",
    },
    invite,
  };
  fs.writeFileSync(out, `${JSON.stringify(ctx, null, 2)}\n`);
  console.log(`[seed] context -> ${out}（base=${baseId} table=${tableId} records=${recordIds.length} kb=${kbId}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
