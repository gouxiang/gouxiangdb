// 记录变更历史端到端测试的共享夹具：在 _realApp 的「真迁移临时库 + 真 records 路由」之上，
// 补上本专题要用的表/字段/读写辅助。单独成文件只为守单文件 <=300 行门禁。

import { setupHarness, type Harness } from "./_realApp.js";
import { rebuildScopePoliciesTx } from "../../domain/authz/scopeDoubleWrite.js";

export const OWNER_ID = "u1";
export const VIEWER_ID = "u2";
/** 受限身份的角色：对目标库可见可管，但「密级」字段被配成 hidden。 */
export const MASKED_ROLE = "role_test_masked";

export interface RecordChangesHarness extends Harness {
  /** 建一张四字段表并把 id 记进 `t`（每个用例独立，避免 A4 库名唯一约束撞车）。 */
  makeTableWithFields: () => Promise<{
    baseId: string;
    tableId: string;
    fName: string;
    fSel: string;
    fNote: string;
    fSecret: string;
  }>;
  createRecord: (tableId: string, values: Record<string, unknown>) => Promise<string>;
  patchRecord: (id: string, values: Record<string, unknown>) => Promise<void>;
  /** 调读端点并断言 200；返回解析后的响应体。 */
  changes: (id: string, qs?: string) => Promise<any>;
  /** 直接读 record_changes 表（绕开读端点，验证「写侧到底落了什么」）。 */
  rawChanges: (id: string) => Promise<Array<{ op: string; changes: string; actorId: string | null; actorName: string | null; tableId: string }>>;
  /** 给受限身份配：库可见可管 + 密级字段 hidden（角色只建一次，视野行按 baseId 逐例建）。 */
  grantMaskedViewer: (baseId: string, tableId: string, fSecret: string) => Promise<void>;
}

export async function setupRecordChangesHarness(): Promise<RecordChangesHarness> {
  const h = await setupHarness("gx-record-changes-");
  await h.prisma.user.create({
    data: { id: VIEWER_ID, email: "u2@example.com", displayName: "受限成员", passwordHash: "x" },
  });

  // A4：库名全局唯一，故每个用例用不同名字（顺序计数）。
  let libSeq = 0;
  let maskedReady = false;

  const makeTableWithFields = async () => {
    const baseId = await h.makeBase(`变更历史库${++libSeq}`);
    const t = await h.makeTable(baseId, "T");
    let order = 1;
    const add = async (name: string, type: string, extra: Record<string, unknown> = {}) => {
      const f = await h.prisma.field.create({
        data: { tableId: t.id, name, type, order: order++, ...extra } as never,
      });
      return f.id;
    };
    const fSel = await add("状态", "singleSelect", {
      options: JSON.stringify([
        { id: "opt_todo", name: "待办", color: "red" },
        { id: "opt_done", name: "完成", color: "green" },
      ]),
    });
    const fNote = await add("备注", "singleLineText");
    const fSecret = await add("密级", "singleLineText");
    return { baseId, tableId: t.id, fName: t.primaryFieldId, fSel, fNote, fSecret };
  };

  const json = async (res: Response): Promise<any> => res.json();

  const createRecord = async (tableId: string, values: Record<string, unknown>): Promise<string> => {
    const res = await h.request("POST", `/records?tableId=${tableId}`, { fields: values });
    expectStatus(res, 201);
    const body = await json(res);
    return body.record.id as string;
  };

  const patchRecord = async (id: string, values: Record<string, unknown>): Promise<void> => {
    const res = await h.request("PATCH", `/records/${id}`, { fields: values });
    expectStatus(res, 200);
  };

  const changes = async (id: string, qs = ""): Promise<any> => {
    const res = await h.request("GET", `/records/${id}/changes${qs}`);
    expectStatus(res, 200);
    return json(res);
  };

  const rawChanges = async (id: string) =>
    h.prisma.recordChange.findMany({
      where: { recordId: id },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      select: { op: true, changes: true, actorId: true, actorName: true, tableId: true },
    });

  const grantMaskedViewer = async (baseId: string, tableId: string, fSecret: string) => {
    if (!maskedReady) {
      await h.prisma.role.create({
        data: { id: MASKED_ROLE, workspaceId: "ws_default", name: "受限角色", permissions: "[]" },
      });
      await h.prisma.roleAssignment.create({
        data: { roleId: MASKED_ROLE, subjectType: "user", subjectId: VIEWER_ID, scopeType: "workspace", createdBy: "seed" },
      });
      maskedReady = true;
    }
    await h.prisma.roleLibraryScope.create({
      data: {
        roleId: MASKED_ROLE, libraryKind: "base", libraryId: baseId,
        visible: 1, canManage: 1, canShare: 0,
        config: JSON.stringify({ tables: {}, fields: { [tableId]: { [fSecret]: "hidden" } } }),
      },
    });
    // 引擎永久单一化后放行只认节点策略：给角色配库权限在产品里会同事务经
    // rebuildScopePoliciesTx 把视野投影到 nav 节点。夹具裸插 scope 后必须补这一步，
    // 否则 legacy 层认为可见、引擎节点上无策略 -> fail-closed 403。
    const saved = await h.prisma.roleLibraryScope.findMany({ where: { roleId: MASKED_ROLE } });
    await rebuildScopePoliciesTx(h.prisma, MASKED_ROLE, saved.map((r) => ({
      roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })), "seed");
  };

  return {
    ...h,
    makeTableWithFields,
    createRecord,
    patchRecord,
    changes,
    rawChanges,
    grantMaskedViewer,
  };
}

/** 断言 HTTP 状态码，不符就把 body 一起打出来（比只报数字好定位）。 */
async function expectStatus(res: Response, status: number): Promise<void> {
  if (res.status === status) return;
  const body = await res.text().catch(() => "");
  throw new Error(`期望 ${status}，实际 ${res.status}：${body.slice(0, 300)}`);
}
