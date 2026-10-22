// apps/web/src/api/__tests__/create-nav-guard.test.ts
// 源码守卫（node 直接读源文件）：建库/建表「先等缓存落地、再跳到含新 id 的真实路由」契约。
//
// 行为部分（await 后缓存已刷新）见 create-refresh.test.ts。这里锁的是接线不被悄悄改回：
//   1) hooks.ts 里 createBase/createTable 的 onSuccess 必须调用 await 版刷新函数，
//      不能退回 fire-and-forget 的 void invalidateAll（#1006 竞态会复发）；
//   2) 三个入口（建新库模态、旧壳侧栏、新壳二级导航）跳转 URL 必须拼上新资源返回的 id，
//      不能跳去列表页或写死的旧 id。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("源码守卫：建库/建表跳转契约", () => {
  it("hooks.ts：createBase/createTable 的 onSuccess 接到 await 版刷新函数", () => {
    const src = read("../../api/hooks.ts");
    // 两个刷新函数都被引入
    expect(src).toContain("refreshAfterCreateBase");
    expect(src).toContain("refreshAfterCreateTable");

    // createBase 的 onSuccess 不再是旧的 invalidateAll()（切片截到 updateBase 之前）
    const createBaseBlock = src
      .slice(src.indexOf("createBase: useMutation"), src.indexOf("updateBase: useMutation"));
    expect(createBaseBlock).toMatch(/onSuccess:\s*\(\)\s*=>\s*refreshAfterCreateBase\(qc\)/);
    expect(createBaseBlock).not.toContain("invalidateAll()");

    // createTable 的 onSuccess 把新表 id 透传给刷新函数（views/fields 按 tableId 失效）
    const createTableBlock = src
      .slice(src.indexOf("createTable: useMutation"), src.indexOf("updateTable: useMutation"));
    expect(createTableBlock).toMatch(
      /onSuccess:\s*\(t,\s*v\)\s*=>\s*refreshAfterCreateTable\(\s*qc,\s*v\.baseId,\s*t\.id\s*\)/,
    );
    expect(createTableBlock).not.toMatch(/invalidateAll\(v\.baseId\)/);
  });

  it("三个入口：navigate 目标都含新资源返回的 id（真实路由，不跳列表/写死 id）", () => {
    const modal = read("../../components/CreateLibraryModal.tsx");
    expect(modal).toContain("navigate(`/base/${b.id}`)");

    const sidebar = read("../../features/sidebar/Sidebar.tsx");
    expect(sidebar).toContain("navigate(`/base/${baseId}/table/${t.id}`)");

    const secondary = read("../../features/workspace/SecondaryNavTableOps.tsx");
    expect(secondary).toContain("navigate(`/base/${baseId}/table/${t.id}`)");
  });});
