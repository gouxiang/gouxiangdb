// v6 S3 顶栏面包屑纯函数回归（node 环境，无路由 / 无依赖）。
// 锁 deriveCrumb 全口径：工作区固定页、base 首页/settings/trash/erd/table(+view)、
// kb 首页/settings/trash/doc/canvas、库名未就绪 → []、子资源名缺失兜底、to 链接段、
// 未知路由 → []。铁律：任何分支不得输出 undefined / 空串段。

import { describe, it, expect } from "vitest";
import { deriveCrumb } from "./route-crumb";

describe("deriveCrumb：工作区级固定页", () => {
  it("通讯录 / 权限管理 / 帮助中心 单段，且单段不带 to", () => {
    expect(deriveCrumb({ pathname: "/workspace/contacts" })).toEqual([{ label: "通讯录" }]);
    expect(deriveCrumb({ pathname: "/workspace/authz" })).toEqual([{ label: "权限管理" }]);
    expect(deriveCrumb({ pathname: "/help" })).toEqual([{ label: "帮助中心" }]);
  });

  it("工作区设置及其分区子页都只出一段「工作区设置」（不追加第二段）", () => {
    expect(deriveCrumb({ pathname: "/workspace/settings" })).toEqual([{ label: "工作区设置" }]);
    expect(deriveCrumb({ pathname: "/workspace/settings/general" })).toEqual([
      { label: "工作区设置" },
    ]);
    expect(deriveCrumb({ pathname: "/workspace/settings/members" })).toEqual([
      { label: "工作区设置" },
    ]);
  });

  it("未知工作区子路由 → []（不编造段名）", () => {
    expect(deriveCrumb({ pathname: "/workspace/nope" })).toEqual([]);
  });

  it("工作流：/workflow 单段无 to；/workflow/runs 两段且首段带 to、末段无 to", () => {
    expect(deriveCrumb({ pathname: "/workflow" })).toEqual([{ label: "工作流" }]);
    expect(deriveCrumb({ pathname: "/workflow/runs" })).toEqual([
      { label: "工作流", to: "/workflow" },
      { label: "运行记录" },
    ]);
    // /workflow/runs/:runId：三段，首两段带 to、末段「运行详情」无 to。
    expect(deriveCrumb({ pathname: "/workflow/runs/run_1" })).toEqual([
      { label: "工作流", to: "/workflow" },
      { label: "运行记录", to: "/workflow/runs" },
      { label: "运行详情" },
    ]);
    // /workflow/def/:defId：静态 def 前缀与 runs 同构，精确识别为两段，末段无 to。
    expect(deriveCrumb({ pathname: "/workflow/def/wf_1" })).toEqual([
      { label: "工作流", to: "/workflow" },
      { label: "流程详情" },
    ]);
    // /workflow/def 缺 id（seg[3] 为空）回落单段，不编造二段。
    expect(deriveCrumb({ pathname: "/workflow/def" })).toEqual([{ label: "工作流" }]);
    // /workflow/new：独立静态段，精确识别为两段，首段带 to、末段无 to。
    expect(deriveCrumb({ pathname: "/workflow/new" })).toEqual([
      { label: "工作流", to: "/workflow" },
      { label: "新建流程" },
    ]);
    // 未识别的 /workflow/* 子路由只兜底单段，不编造二段。
    expect(deriveCrumb({ pathname: "/workflow/whatever" })).toEqual([{ label: "工作流" }]);
  });
});

describe("deriveCrumb：智能数据库", () => {
  it("库首页：库名就绪出单段（不带 to）；未就绪返回 [] 防错名闪跳", () => {
    expect(deriveCrumb({ pathname: "/base/b1", baseName: "客户主库" })).toEqual([
      { label: "客户主库" },
    ]);
    expect(deriveCrumb({ pathname: "/base/b1" })).toEqual([]);
    expect(deriveCrumb({ pathname: "/base/b1", baseName: null })).toEqual([]);
    expect(deriveCrumb({ pathname: "/base/b1", baseName: "  " })).toEqual([]);
  });

  it("settings / trash / erd：库名段带 to 回库 + 固定第二段", () => {
    expect(deriveCrumb({ pathname: "/base/b1/settings", baseName: "客户主库" })).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "库设置" },
    ]);
    expect(deriveCrumb({ pathname: "/base/b1/trash", baseName: "客户主库" })).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "回收站" },
    ]);
    expect(deriveCrumb({ pathname: "/base/b1/erd", baseName: "客户主库" })).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "数据库关系图" },
    ]);
  });

  it("子页库名未就绪 → []（不先出裸第二段）", () => {
    expect(deriveCrumb({ pathname: "/base/b1/table/t1" })).toEqual([]);
    expect(deriveCrumb({ pathname: "/base/b1/settings" })).toEqual([]);
  });

  it("表页：表名就绪用真名；缺失/未就绪用「数据表」兜底（不阻塞），view 子路由不追加第三段", () => {
    expect(
      deriveCrumb({ pathname: "/base/b1/table/t1", baseName: "客户主库", tableName: "需求池" }),
    ).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "需求池" },
    ]);
    expect(deriveCrumb({ pathname: "/base/b1/table/t1", baseName: "客户主库" })).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "数据表" },
    ]);
    expect(
      deriveCrumb({
        pathname: "/base/b1/table/t1/view/v1",
        baseName: "客户主库",
        tableName: "需求池",
      }),
    ).toEqual([
      { label: "客户主库", to: "/base/b1" },
      { label: "需求池" },
    ]);
  });

  it("未识别的 base 子路由：只兜底库名一段，不编造二段", () => {
    expect(deriveCrumb({ pathname: "/base/b1/whatever", baseName: "客户主库" })).toEqual([
      { label: "客户主库" },
    ]);
  });
});

describe("deriveCrumb：知识库", () => {
  it("库首页：库名就绪出单段；未就绪返回 []", () => {
    expect(deriveCrumb({ pathname: "/kb/k1", kbName: "产品知识库" })).toEqual([
      { label: "产品知识库" },
    ]);
    expect(deriveCrumb({ pathname: "/kb/k1" })).toEqual([]);
  });

  it("settings / trash 两段，库名段带 to", () => {
    expect(deriveCrumb({ pathname: "/kb/k1/settings", kbName: "产品知识库" })).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "知识库设置" },
    ]);
    expect(deriveCrumb({ pathname: "/kb/k1/trash", kbName: "产品知识库" })).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "回收站" },
    ]);
  });

  it("文档页：标题就绪用真名；缺失兜底「文档」；画布页兜底「画布」", () => {
    expect(
      deriveCrumb({ pathname: "/kb/k1/doc/d1", kbName: "产品知识库", docTitle: "发版说明" }),
    ).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "发版说明" },
    ]);
    expect(deriveCrumb({ pathname: "/kb/k1/doc/d1", kbName: "产品知识库" })).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "文档" },
    ]);
    expect(
      deriveCrumb({ pathname: "/kb/k1/canvas/d2", kbName: "产品知识库", docTitle: "流程图" }),
    ).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "流程图" },
    ]);
    expect(deriveCrumb({ pathname: "/kb/k1/canvas/d2", kbName: "产品知识库" })).toEqual([
      { label: "产品知识库", to: "/kb/k1" },
      { label: "画布" },
    ]);
  });
});

describe("deriveCrumb：杂项护栏", () => {
  it("根路径 / 与未知路由 → []", () => {
    expect(deriveCrumb({ pathname: "/" })).toEqual([]);
    expect(deriveCrumb({ pathname: "/something" })).toEqual([]);
  });

  it("尾斜杠归一化（/base/b1/ 与 /base/b1 同果）", () => {
    expect(deriveCrumb({ pathname: "/base/b1/", baseName: "客户主库" })).toEqual([
      { label: "客户主库" },
    ]);
    expect(deriveCrumb({ pathname: "/help/" })).toEqual([{ label: "帮助中心" }]);
  });

  it("任何输出段 label 均为非空字符串、to 仅出现在非末段", () => {
    const cases = [
      "/workspace/contacts",
      "/workflow/runs",
      "/base/b1/table/t1/view/v1",
      "/kb/k1/canvas/d2",
      "/base/b1/trash",
    ];
    for (const pathname of cases) {
      const crumbs = deriveCrumb({
        pathname,
        baseName: "B",
        kbName: "K",
        tableName: "T",
        docTitle: "D",
      });
      for (const [i, seg] of crumbs.entries()) {
        expect(typeof seg.label).toBe("string");
        expect(seg.label.length).toBeGreaterThan(0);
        if (i === crumbs.length - 1) expect(seg.to).toBeUndefined();
      }
    }
  });
});
