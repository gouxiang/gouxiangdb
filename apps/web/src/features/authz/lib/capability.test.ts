// M4-FE 门控 fail-closed 纯函数测试（M4-FE handoff §1 最高优先）。
// 后端 S10 翻总门前 /meta 不含 authzManage；任何"非严格 true"取值都必须判关。
import { describe, expect, it } from "vitest";
import { authzGateState, canManageAuthz } from "./capability";
import type { EnterpriseMeta } from "../../../api/client";

describe("canManageAuthz：仅 authzManage === true 放行，其余 fail-closed", () => {
  it("三态：undefined 字段 / false / true", () => {
    expect(canManageAuthz({})).toBe(false);
    expect(canManageAuthz({ authzManage: false })).toBe(false);
    expect(canManageAuthz({ authzManage: true })).toBe(true);
  });

  it("meta 为 null（探针失败/未挂载）或 undefined（未加载）→ 关", () => {
    expect(canManageAuthz(null)).toBe(false);
    expect(canManageAuthz(undefined)).toBe(false);
  });

  it("非布尔真值不放行（严格全等，防后端误发字符串/数字）", () => {
    expect(canManageAuthz({ authzManage: "true" } as unknown as EnterpriseMeta)).toBe(false);
    expect(canManageAuthz({ authzManage: 1 } as unknown as EnterpriseMeta)).toBe(false);
    expect(canManageAuthz({ enterpriseOrg: true })).toBe(false);
  });
});

describe("authzGateState：明确 on 优先；否则加载中 loading、加载完 off", () => {
  it("on：meta 明确 true 时即使 isLoading 也判 on", () => {
    expect(authzGateState({ authzManage: true }, true)).toBe("on");
    expect(authzGateState({ authzManage: true }, false)).toBe("on");
  });

  it("loading：无能力位且仍在加载（首帧不得闪编辑入口）", () => {
    expect(authzGateState(undefined, true)).toBe("loading");
    expect(authzGateState(null, true)).toBe("loading");
    expect(authzGateState({}, true)).toBe("loading");
  });

  it("off：加载结束且无 true（默认生产形态：恒关）", () => {
    expect(authzGateState(undefined, false)).toBe("off");
    expect(authzGateState(null, false)).toBe("off");
    expect(authzGateState({}, false)).toBe("off");
    expect(authzGateState({ authzManage: false }, false)).toBe("off");
  });
});
