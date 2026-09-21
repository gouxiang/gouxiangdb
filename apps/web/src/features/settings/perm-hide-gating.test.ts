// 权限治理第二批回归（node 环境，纯源码断言，无 jsdom、无新增依赖）。
//
// 锁的是同一条口径：判断标准是「这个操作属于哪一类」，不是「有没有权限」。
//   · 管理类 / 配置类 / 破坏性操作（删库、改库名、新建文档画布、改成员角色、删视图）
//     → 无权限**不渲染**，用户根本看不到入口存在；
//   · 数据编辑类（表格工具栏新建记录、回收站恢复）→ **保留 disabled + 原因**，
//     用户需要知道「我能看但不能改」，藏掉会让人以为功能丢了。
// 这套断言防止后续改回「可见不可改」的旧写法，也防止把数据编辑类误藏。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

describe("权限治理第二批：管理类隐藏 / 数据编辑类保留禁用", () => {
  it("KB 新建文档 / 画布由 canCreate 门控，不再 disabled（第四批：入口从 KB 首页移到 L2）", () => {
    // 改断言原因：第四批入口收敛——「新建文档 / 新建画布」从 KbHomePage 移到二级导航
    // （SecondaryNavKbOps，选项卡行右侧，按当前 tab 建对应类型），同一能力不留两处入口。
    // 门控口径不变：canCreate 为假时**不渲染**，不是 disabled 假装禁用。
    const ops = read("../workspace/SecondaryNavKbOps.tsx");
    expect(ops).toContain("canCreate");
    expect(ops).toContain("新建文档");
    expect(ops).toContain("新建画布");
    expect(ops).not.toContain("disabled={!canCreate}");
    // 原入口确已下线：KbHomePage 不再持有 useCreateDoc（否则又是双入口）
    expect(read("../kb/KbHomePage.tsx")).not.toContain("useCreateDoc");
  });

  it("库设置：名称无权限走只读文本；危险操作区（删库）整块不渲染", () => {
    const src = read("./SettingsPage.tsx");
    // 只读文本，不是灰掉的 input
    expect(src).toContain("canManageBase ? (\n                        <Input");
    expect(src).not.toContain("disabled={!canManageBase}");
    // 删库属破坏性操作：整块 + 左侧导航项一起收掉
    expect(src).toContain("{canManageBase && tab === \"danger\" && (");
    expect(src).toContain("TABS.filter((t) => canManageBase || t.key !== \"danger\")");
  });

  it("视图切换器：新建 / 重命名 / 删除视图由 canManageSchema 门控，不再 disabled", () => {
    const src = read("../grid/ViewSwitcher.tsx");
    expect(src).toContain("{canManageSchema && (");
    expect(src).not.toContain("disabled={!canManageSchema}");
    expect(src).not.toContain("NO_PERMISSION_HINT");
    // onlyOne 是业务规则而非权限，仍保留 disabled + 原因
    expect(src).toContain("disabled={onlyOne}");
    expect(src).toContain("至少保留一个视图");
  });

  it("回收站：彻底删除（不可逆）不渲染；恢复（数据编辑类）保留 disabled", () => {
    const src = read("./TrashPage.tsx");
    expect(src).toContain("{canManageBase && (");
    expect(src).not.toContain("disabled={!canManageBase}");
    // 恢复 = 写回数据，属数据编辑类，必须保持可见且说明原因
    expect(src).toContain("disabled={!canEditData}");
    expect(src).toContain("无编辑权限");
  });

  it("成员与权限：逐库成员写端点下线，面板改只读台账；无管理权不渲染「允许分享」开关", () => {
    // 改断言原因：后端把加人 / 改角色 / 踢人三个写端点一并下线后，旧口径（角色下拉与
    // 「移除」按钮按 canManageBase 显隐）失去了断言对象——留着就是断言一段已删的代码。
    // 新口径同一条纪律：管理类操作无权限即**不渲染**，不给 disabled 假入口。
    const src = read("./MembersPanel.tsx");
    expect(src).toContain("canToggleShare ? (");
    expect(src).not.toContain("disabled={!canManageBase}");
    // 只读台账：不再有角色下拉与移除入口
    expect(src).not.toContain("isOwner");
    expect(src).not.toContain("useGXMutations");
  });

  it("红线：表格工具栏「新建记录」仍是 disabled + 原因，不许改成隐藏", () => {
    // 改断言原因：设置项下移成工具栏第二行后，「新建记录」的实现搬到了
    // GridToolbarSettingsRow.tsx（单文件 ≤300 行公约），口径一字未动，仍是
    // disabled + 原因 + 外层 span 承接 title（PERM-A2）。故断言对两个文件一起生效。
    const src = read("../grid/GridToolbar.tsx") + "\n" + read("../grid/GridToolbarSettingsRow.tsx");
    expect(src).toContain("disabled={!permissions.canEditData}");
    expect(src).toContain("无编辑权限");
    expect(src).toContain("新建记录");
  });
});
