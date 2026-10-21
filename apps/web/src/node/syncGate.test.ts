// apps/web/src/node/syncGate.test.ts
import { describe, it, expect } from "vitest";
import { isSyncShell, isSyncActive } from "./syncGate";

describe("isSyncShell 第①+②层（构建标志 && 物理在壳）", () => {
  it("两条件全真才为真（fail-closed 真值表）", () => {
    expect(isSyncShell({ launcherEnabled: true, shellPresent: true })).toBe(true);
    expect(isSyncShell({ launcherEnabled: true, shellPresent: false })).toBe(false);
    expect(isSyncShell({ launcherEnabled: false, shellPresent: true })).toBe(false);
    expect(isSyncShell({ launcherEnabled: false, shellPresent: false })).toBe(false);
  });

  it("非布尔/缺省不被 truthy 误判（严格 === true）", () => {
    expect(isSyncShell({ launcherEnabled: 1 as unknown as boolean, shellPresent: true })).toBe(false);
    expect(isSyncShell({ launcherEnabled: true, shellPresent: undefined as unknown as boolean })).toBe(false);
  });
});

describe("isSyncActive 第③层（再叠副本功能确认）", () => {
  it("必须 shell && replicaEnabled", () => {
    expect(isSyncActive({ shell: true, replicaEnabled: true })).toBe(true);
    expect(isSyncActive({ shell: true, replicaEnabled: false })).toBe(false);
    expect(isSyncActive({ shell: false, replicaEnabled: true })).toBe(false);
    expect(isSyncActive({ shell: false, replicaEnabled: false })).toBe(false);
  });

  it("探活未知/404（replicaEnabled=false）一律不激活", () => {
    expect(isSyncActive({ shell: true, replicaEnabled: false })).toBe(false);
  });
});
