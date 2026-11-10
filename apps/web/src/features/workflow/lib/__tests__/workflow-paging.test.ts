// 工作流 page 基分页纯函数单测（#1317 刀 C3-a1，纯 node，零 IO/React/依赖）。
//
// 锁四件事：
//   ① 常量对齐后端 workflowService:21-22（默认 20、上限 100）；
//   ② 入参规整：page 非法回落 1，pageSize 非法回落 20、超 100 夹到 100，total 非法回落 0；
//   ③ from/to/canPrev/canNext 推导，尤其 total=0 时 from=0、page 超界时如实算得 to<from（不抹平）；
//   ④ nextPage/prevPage 夹在 [1, 末页]，total=0 时末页至少为 1。
import { describe, it, expect } from "vitest";
import {
  WORKFLOW_DEFAULT_PAGE_SIZE,
  WORKFLOW_MAX_PAGE_SIZE,
  workflowPageState,
  nextPage,
  prevPage,
} from "../workflow-paging";

describe("常量对齐后端", () => {
  it("默认 20、上限 100", () => {
    expect(WORKFLOW_DEFAULT_PAGE_SIZE).toBe(20);
    expect(WORKFLOW_MAX_PAGE_SIZE).toBe(100);
  });
});

describe("workflowPageState 推导", () => {
  it("0 条：from/to 均为 0，不可前后翻页", () => {
    expect(workflowPageState(1, 20, 0)).toEqual({
      page: 1,
      pageSize: 20,
      from: 0,
      to: 0,
      total: 0,
      canPrev: false,
      canNext: false,
    });
  });

  it("整页整除（20 条 / size20）：首页 from1-to20，无下一页", () => {
    const s = workflowPageState(1, 20, 20);
    expect(s).toMatchObject({ from: 1, to: 20, canPrev: false, canNext: false });
  });

  it("末页不满（25 条 / size20）：首页可下一页，次页 from21-to25 到底", () => {
    const first = workflowPageState(1, 20, 25);
    expect(first).toMatchObject({ from: 1, to: 20, canPrev: false, canNext: true });
    const second = workflowPageState(2, 20, 25);
    expect(second).toMatchObject({ from: 21, to: 25, canPrev: true, canNext: false });
  });

  it("page 超过总页数：如实算得 from>total、to<from，不擅自抹平（UI 层据此回正）", () => {
    const over = workflowPageState(99, 20, 25);
    expect(over.from).toBe(1961); // (99-1)*20+1
    expect(over.to).toBe(25); // min(99*20, 25)
    expect(over.to).toBeLessThan(over.from);
    expect(over.canPrev).toBe(true);
    expect(over.canNext).toBe(false);
  });

  it("total 整除时末页正好铺满（100 条 / size20，第 5 页 from81-to100）", () => {
    const last = workflowPageState(5, 20, 100);
    expect(last).toMatchObject({ from: 81, to: 100, canPrev: true, canNext: false });
  });
});

describe("入参规整", () => {
  it("page 非有限/非整数/<1 一律回落第 1 页", () => {
    for (const p of [0, -1, 1.2, NaN, Infinity]) {
      expect(workflowPageState(p, 20, 25).page).toBe(1);
    }
  });

  it("pageSize 非有限/非整数/<1 回落默认 20", () => {
    for (const size of [0, -5, 1.5, NaN, Infinity]) {
      expect(workflowPageState(1, size, 25).pageSize).toBe(20);
    }
  });

  it("pageSize 超过 100 夹到 100", () => {
    const s = workflowPageState(1, 200, 250);
    expect(s.pageSize).toBe(100);
    expect(s.to).toBe(100); // 夹边后首页末条序号
  });

  it("total 非有限/负数回落 0", () => {
    for (const t of [-3, NaN, Infinity]) {
      const s = workflowPageState(1, 20, t);
      expect(s.total).toBe(0);
      expect(s.from).toBe(0);
      expect(s.to).toBe(0);
    }
  });
});

describe("nextPage / prevPage 夹边", () => {
  it("total=0：末页至少 1，前后翻都停在 1", () => {
    const s = workflowPageState(1, 20, 0);
    expect(prevPage(s)).toBe(1);
    expect(nextPage(s)).toBe(1);
  });

  it("25 条 / size20（共 2 页）：首页 next=2、prev 夹到 1；次页 next 夹到 2、prev=1", () => {
    const first = workflowPageState(1, 20, 25);
    const second = workflowPageState(2, 20, 25);
    expect(nextPage(first)).toBe(2);
    expect(prevPage(first)).toBe(1);
    expect(nextPage(second)).toBe(2); // 不超过末页
    expect(prevPage(second)).toBe(1);
  });

  it("100 条 / size20（共 5 页）：中间页正常 ±1，末页 next 夹到 5", () => {
    const mid = workflowPageState(3, 20, 100);
    expect(prevPage(mid)).toBe(2);
    expect(nextPage(mid)).toBe(4);
    const last = workflowPageState(5, 20, 100);
    expect(nextPage(last)).toBe(5);
  });

  it("自定义 pageSize=100 时末页按实际条数计算（250 条共 3 页）", () => {
    const s = workflowPageState(3, 100, 250);
    expect(nextPage(s)).toBe(3); // ceil(250/100)=3
    expect(prevPage(s)).toBe(2);
  });
});
