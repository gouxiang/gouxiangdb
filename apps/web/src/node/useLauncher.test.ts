// useLauncher.ts 薄适配接线测试（node 环境 + react-dom/server，无 jsdom、无新依赖）。
// 锁两件事：①hook 从注入 store 读到注册表并产出 VM；②store 变更后重新渲染拿到新值。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useLauncher } from "./useLauncher";
import { createLauncherStore, type LauncherStore } from "./launcherStore";
import type { KvStorage } from "./remoteSessions";

class MemStorage implements KvStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

function makeStore(): LauncherStore {
  return createLauncherStore({
    storage: new MemStorage(),
    getLocalBase: () => "",
    getOrigin: () => "http://localhost",
    getLocalToken: () => null,
  });
}

function Probe({ store }: { store: LauncherStore }) {
  const { vm } = useLauncher(store);
  return React.createElement(
    "div",
    { "data-empty": String(vm.isEmpty) },
    vm.isEmpty ? "EMPTY" : vm.rows.map((r) => r.title).join("|"),
  );
}

describe("useLauncher", () => {
  it("空注册表首渲 → EMPTY", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(React.createElement(Probe, { store }));
    expect(html).toContain("EMPTY");
    expect(html).toContain('data-empty="true"');
  });

  it("加入本地+远端并连接后重渲 → 标题按 VM 顺序输出", async () => {
    const store = makeStore();
    store.connectLocal();
    // 直接通过注册表接口造一个远端条目（不走网络），验证 hook 只是读 store。
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001", label: "公司库" });

    const html = renderToStaticMarkup(React.createElement(Probe, { store }));
    expect(html).not.toContain("EMPTY");
    // VM 排序本地在前；本地标题「本机」、远端自定义名「公司库」。
    expect(html).toContain("本机|公司库");
    expect(html).toContain('data-empty="false"');
  });
});
