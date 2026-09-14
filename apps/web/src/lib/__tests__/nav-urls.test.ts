// M3-S0 Characterization：硬编码旧 URL 形态清单（N5 兼容面）纯函数快照。
//
// 依据：docs/planning/phase2/M3-implementation-plan.md
//   - §1.3「硬编码旧 URL 的全部生成点」表格（grep 实查的 32 个导航命中文件）：
//     lib/internal-links.ts:13-34 的 internalHref 五类目标是正文内部链接的【单一真源】，
//     且已落库为 Markdown 正文 / 画布 gxLinkRef 等持久化数据。
//   - §2.1 第 1 条 / §3 契约 1：内容 URL 形态零变化——S8 换统一工作区外壳时
//     /base/:id/...、/kb/:id/... 路径与参数一个字符都不能改（URL 不可变是 M3 裁决）。
//   - §1.3 表格中的组件行号（App.tsx / Sidebar / TopBar / KbTree / SearchDialog 等
//     32 处 navigate()/href 生成点）是 S8 回归的【人工 checklist】，不在此做组件快照
//    （脆且维护成本高）；本文件只锁纯函数协议层 + 公开分享路由声明形态。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { internalHref, isInternalHref, type InternalTarget } from "../internal-links";
import { withBase } from "../base";

// 编译期穷举守卫：InternalTarget 联合若新增第 6 类目标，
// 此 Record 缺键会直接 tsc 报错（防协议静默扩展而本测试不覆盖）。
const TARGETS: Readonly<Record<InternalTarget["kind"], InternalTarget>> = {
  doc: { kind: "doc", kbId: "kb_01", docId: "doc_aa" },
  canvas: { kind: "canvas", kbId: "kb_01", docId: "can_bb" },
  kb: { kind: "kb", kbId: "kb_01" },
  table: { kind: "table", baseId: "base_01", tableId: "tbl_02", recordId: "rec_03" },
  base: { kind: "base", baseId: "base_01" },
};

describe("M3-S0 §1.3 internalHref 五类内部链接形态快照（单一真源，落库正文数据）", () => {
  it("五类目标输出形态逐值锁定：/base/:id、/base/:id/table/:tid、/kb/:id、/kb/:id/(doc|canvas)/:docId", () => {
    expect(internalHref(TARGETS.base)).toBe("/base/base_01");
    expect(internalHref(TARGETS.kb)).toBe("/kb/kb_01");
    expect(internalHref(TARGETS.doc)).toBe("/kb/kb_01/doc/doc_aa");
    expect(internalHref(TARGETS.canvas)).toBe("/kb/kb_01/canvas/can_bb");
    // 跨表开记录：record 走 query（§1.3 SearchDialog/ViewRouter 旧形）
    expect(internalHref(TARGETS.table)).toBe("/base/base_01/table/tbl_02?record=rec_03");
  });

  it("table 不带 recordId 时不挂 query，路径其余部分不变", () => {
    expect(internalHref({ kind: "table", baseId: "b", tableId: "t" })).toBe("/base/b/table/t");
  });

  it("目标类型恰为五类（穷举守卫运行时侧），键集合不增不减", () => {
    expect(Object.keys(TARGETS).sort()).toEqual(["base", "canvas", "doc", "kb", "table"]);
  });

  // 关键断言（防 S8 换外壳误改协议）：
  // internalHref 的每个输出都必须仍能被 isInternalHref 识别为内部链接，
  // 且根前缀恒为 /base/ 或 /kb/——正文里已落库的链接升级后逐条仍走 SPA 委托。
  it("内部链接解析后仍以 /base、/kb 为根（往返不变式，五类全覆盖）", () => {
    for (const target of Object.values(TARGETS)) {
      const href = internalHref(target);
      expect(href.startsWith("/base/") || href.startsWith("/kb/")).toBe(true);
      expect(isInternalHref(href)).toBe(true);
    }
    // 无 record 的 table 同样满足
    expect(isInternalHref(internalHref({ kind: "table", baseId: "b", tableId: "t" }))).toBe(true);
  });
});

describe("M3-S0 §1.3 isInternalHref 边界：内部委托只认 /base、/kb 两根", () => {
  it("/s/:token 公开分享链接【不是】内部委托链接（独立公开页，防 S8 误纳入 SPA 点击委托）", () => {
    expect(isInternalHref("/s/share-token-xyz")).toBe(false);
    expect(isInternalHref("/s/share-token-xyz/doc/doc_aa")).toBe(false);
  });

  it("外部协议、锚点、空串、其它应用根路径一律不算内部链接", () => {
    expect(isInternalHref("https://example.com/kb/x")).toBe(false);
    expect(isInternalHref("http://host/base/b")).toBe(false);
    expect(isInternalHref("mailto:a@b.com")).toBe(false);
    expect(isInternalHref("#section-1")).toBe(false);
    expect(isInternalHref("")).toBe(false);
    expect(isInternalHref("/workspace/contacts")).toBe(false);
    expect(isInternalHref("/settings")).toBe(false);
  });

  it("/base、/kb 两根（含带子路径与 query）识别为内部", () => {
    expect(isInternalHref("/base/b/table/t?record=r")).toBe(true);
    expect(isInternalHref("/kb/k/canvas/c")).toBe(true);
  });
});

describe("M3-S0 §1.3 部署 basename：子路径前缀与内部链接组合", () => {
  it("BASE_URL=/app/gouxiangdb 时内部链接正确带前缀且无双斜杠（飞牛 fnOS 网关态）", () => {
    const base = "/app/gouxiangdb";
    expect(withBase(base, internalHref(TARGETS.doc))).toBe(
      "/app/gouxiangdb/kb/kb_01/doc/doc_aa",
    );
    expect(withBase(base, internalHref(TARGETS.base))).toBe("/app/gouxiangdb/base/base_01");
    expect(withBase(base, internalHref(TARGETS.table))).toBe(
      "/app/gouxiangdb/base/base_01/table/tbl_02?record=rec_03",
    );
  });

  it("根部署 base='' 时内部链接形态零变化（协议层不感知部署前缀）", () => {
    expect(withBase("", internalHref(TARGETS.doc))).toBe("/kb/kb_01/doc/doc_aa");
    expect(withBase("", internalHref(TARGETS.base))).toBe("/base/base_01");
  });
});

describe("M3-S0 §1.3/§1.4 匿名公开分享路由声明形态（/s/:token，N5 不可变）", () => {
  // 公开链接由后端邮件/页面对外发出，§2.1-8 要求旧链接新壳下逐条可达。
  // S8 重组 App.tsx 外壳时若删掉/改名这两条路由，本断言强制其显式决策而非静默丢失。
  const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");

  it("App.tsx 仍声明 /s/:token 与 /s/:token/doc/:docId 两条公开分享路由", () => {
    expect(appSource).toContain('path="/s/:token"');
    expect(appSource).toContain('path="/s/:token/doc/:docId"');
  });
});
