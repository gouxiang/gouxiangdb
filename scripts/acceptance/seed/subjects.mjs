// scripts/acceptance/seed/subjects.mjs
// M4 20 主体播种（经 v0.1.0 真服务 HTTP）：
//   - 20 个用户 s01..s20（固定邮箱/密码；owner 之外的存量用户，升级后应全 ACTIVE）
//   - 8 个手工关键主体 g1..g8 的【旧库侧】授权（直接授予 / kb 继承 / acl 取高 / creator 兜底 /
//     commenter 多源之一 / 待停用成员）；部门子树与继承中断是 M2/M4 新概念，v0.1.0 无法播种，
//     在升级后经 v1 API 单独构造（见 verify-golden.mjs）。
//   - 12 个 LCG seed42 随机成员（base 成员 / kb 成员 / doc acl），供"回填幂等 + 新旧决策一致"。
//
// 硬编码黄金期望值在 golden.mjs（与自动对拍分开报告，禁止用回填结果循环论证）。

import { makeRng, pick } from "../lib/lcg.mjs";

export const SUBJECT_PASSWORD = "drill-pass-2026";
const ROLES_BASE = ["creator", "editor", "commenter", "viewer"];
const ROLES_KB = ["editor", "commenter", "viewer"];

/**
 * @param {import("../lib/http.mjs").ApiClient} owner owner 客户端
 * @param {(email:string,password:string)=>Promise<import("../lib/http.mjs").ApiClient>} login 登录工厂
 * @param {object} ctx
 * @param {Array<{id:string}>} ctx.bases
 * @param {{kbId:string, docs:Array<{id:string,kind:string}>}} ctx.kb
 * @param {(l:string)=>void} [ctx.log]
 */
export async function seedSubjects(owner, login, ctx, { log } = {}) {
  const rng = makeRng(42);
  const users = [];

  for (let i = 1; i <= 20; i++) {
    const tag = `s${String(i).padStart(2, "0")}`;
    const email = `drill-${tag}@example.test`;
    await owner.post("/auth/signup", { email, password: SUBJECT_PASSWORD, displayName: `主体${tag}` });
    users.push({ tag, email });
  }
  log?.(`  注册 20 个用户完成`);

  const base1 = ctx.bases[0].id;
  const base2 = ctx.bases[1].id;
  const kbId = ctx.kb.kbId;
  const docRows = ctx.kb.docs.filter((d) => d.kind === "doc");
  const aclDoc = docRows[0]?.id;

  // ---------- 8 个手工关键主体：旧库侧授权 ----------
  const goldenLegacy = [];

  await addBaseMember(owner, base1, users[0].email, "viewer");
  goldenLegacy.push({ tag: users[0].tag, scenario: "g1-direct-viewer-base", base: base1, role: "viewer" });

  await addBaseMember(owner, base1, users[1].email, "editor");
  goldenLegacy.push({ tag: users[1].tag, scenario: "g2-direct-editor-base", base: base1, role: "editor" });

  await addBaseMember(owner, base1, users[2].email, "creator");
  goldenLegacy.push({ tag: users[2].tag, scenario: "g3-direct-creator-base", base: base1, role: "creator" });

  await addKbMember(owner, kbId, users[3].email, "viewer");
  goldenLegacy.push({ tag: users[3].tag, scenario: "g4-kb-viewer-inherit-doc", kb: kbId, doc: aclDoc, role: "viewer" });

  await addKbMember(owner, kbId, users[4].email, "viewer");
  await setDocAcl(owner, aclDoc, users[4].email, "editor");
  goldenLegacy.push({ tag: users[4].tag, scenario: "g5-kb-viewer-plus-acl-editor", kb: kbId, doc: aclDoc, kbRole: "viewer", aclRole: "editor" });

  // g6：kb editor，自己建一篇 doc（createdBy=g6），验证 creator 兜底 + kb 继承
  await addKbMember(owner, kbId, users[5].email, "editor");
  let creatorDocId = null;
  {
    const g6 = await login(users[5].email, SUBJECT_PASSWORD);
    const r = await g6.post(`/kb/${kbId}/docs`, { kind: "doc", title: "黄金g6-creator创建文档" });
    creatorDocId = r.doc.id;
    await g6.put(`/kb/docs/${creatorDocId}/content`, { content: "# g6 creator 兜底\n\n由 g6 本人创建的文档。\n" });
  }
  goldenLegacy.push({ tag: users[5].tag, scenario: "g6-creator-fallback", kb: kbId, doc: creatorDocId, kbRole: "editor" });

  // g7：base1 commenter（r+comment）；多源并集的第二源（部门 dept 授予）在升级后追加
  await addBaseMember(owner, base1, users[6].email, "commenter");
  goldenLegacy.push({ tag: users[6].tag, scenario: "g7-multi-source-union", base: base1, role: "commenter" });

  // g8：base2 viewer，升级后停用
  await addBaseMember(owner, base2, users[7].email, "viewer");
  goldenLegacy.push({ tag: users[7].tag, scenario: "g8-disabled-member", base: base2, role: "viewer" });

  // ---------- 12 个 LCG 随机主体（s09..s20） ----------
  const randomGrants = [];
  for (let i = 8; i < 20; i++) {
    const u = users[i];
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      const kind = pick(rng, ["base", "kb", "acl"]);
      try {
        if (kind === "base") {
          const b = pick(rng, ctx.bases).id;
          const role = pick(rng, ROLES_BASE);
          await addBaseMember(owner, b, u.email, role);
          randomGrants.push({ tag: u.tag, kind, base: b, role });
        } else if (kind === "kb") {
          const role = pick(rng, ROLES_KB);
          await addKbMember(owner, kbId, u.email, role);
          randomGrants.push({ tag: u.tag, kind, kb: kbId, role });
        } else if (docRows.length) {
          const d = docRows[i % docRows.length].id;
          const role = pick(rng, ROLES_KB);
          await setDocAcl(owner, d, u.email, role);
          randomGrants.push({ tag: u.tag, kind, doc: d, role });
        }
      } catch {
        // 重复成员（409）等冲突忽略，随机集允许稀疏
      }
    }
  }
  log?.(`  12 个 LCG 主体授权完成（${randomGrants.length} 条）`);

  return { users, goldenLegacy, randomGrants, creatorDocId, aclDocId: aclDoc, kbId, base1, base2 };
}

async function addBaseMember(owner, baseId, email, role) {
  try {
    return await owner.post(`/bases/${baseId}/members`, { email, role });
  } catch (e) {
    if (/409|已是成员/.test(String(e.message))) return null;
    throw e;
  }
}
function addKbMember(owner, kbId, email, role) {
  return owner.post(`/kb/${kbId}/members`, { email, role });
}
function setDocAcl(owner, docId, email, role) {
  return owner.put(`/kb/docs/${docId}/acl`, { email, role });
}
