// ViewSettingsPanel「重置为默认视图」行为测试（#561）。
//
// 锁三件事：
//   ① view.userPrefs 非 null（用户已自定义）→ 按钮可点，点击调 resetViewPrefs 删除自己的 prefs；
//   ② view.userPrefs === null（当前为默认视图）→ 按钮禁用，并带 title「当前为默认视图」；
//   ③ 重置成功 toast「已恢复视图默认设置」。
//
// node 环境、无 jsdom：用受控 Button 替身捕获每个按钮的 props（disabled/title/onClick/children），
// SSR 渲染面板后取出「重置为默认视图」按钮，在外部直接调用其 onClick，再断言替身 mutation。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { defaultViewConfig } from "@gx/shared-types";
import type { PermissionSet, ViewDTO, ViewUserPrefs } from "@gx/shared-types";
import type { ReactNode } from "react";

const resetPrefsSpy = vi.fn(async () => true);
const toastSpy = vi.fn();

interface FakeButtonProps {
  children?: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}
let capturedButtons: FakeButtonProps[] = [];

vi.mock("../../../api/hooks", () => ({
  useViews: () => ({ data: [] }),
  useGXMutations: () => ({
    resetViewPrefs: { mutateAsync: resetPrefsSpy },
    updateView: { mutateAsync: vi.fn(async () => ({})) },
    duplicateView: { mutateAsync: vi.fn(async () => ({})) },
    deleteView: { mutateAsync: vi.fn(async () => ({})) },
  }),
}));
vi.mock("../../../components/ui", () => ({
  toast: (...a: unknown[]) => toastSpy(...a),
  Button: (p: FakeButtonProps) => {
    capturedButtons.push(p);
    return <span data-mock="button">{p.children}</span>;
  },
  Input: () => <span data-mock="input" />,
  SegmentedControl: () => <span data-mock="segmented" />,
}));
vi.mock("../../../components/feedback", () => ({
  confirmIrreversible: vi.fn(async () => false),
}));
vi.mock("../../views/FormConfigSection", () => ({
  default: () => <span data-mock="form-section" />,
}));
vi.mock("../ViewAdminConfigSection", () => ({
  default: () => <span data-mock="admin-section" />,
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ baseId: "b1" }),
  useNavigate: () => vi.fn(),
}));

import ViewSettingsPanel from "../ViewSettingsPanel";

const TABLE_ID = "t1";

const PREFS: ViewUserPrefs = {
  version: 1,
  filters: null,
  sorts: [],
  search: "abc",
  rowHeight: "tall",
  collapsedGroupKeys: [],
  groupByFieldId: null,
  aggregations: {},
};

function makeView(userPrefs: ViewUserPrefs | null): ViewDTO {
  return {
    id: "v1",
    tableId: TABLE_ID,
    name: "网格视图",
    type: "grid",
    lockMode: "collaborative",
    order: 0,
    config: defaultViewConfig(),
    userPrefs,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ViewDTO;
}

// 普通成员也应能重置自己的偏好（与 canManageSchema 无关）。
const PERM_MEMBER: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: true,
  canComment: true,
  canView: true,
};

function renderPanel(userPrefs: ViewUserPrefs | null): FakeButtonProps {
  capturedButtons = [];
  render(
    <ViewSettingsPanel
      view={makeView(userPrefs)}
      tableId={TABLE_ID}
      permissions={PERM_MEMBER}
      onClose={() => undefined}
      embedded
    />,
  );
  const btn = capturedButtons.find((b) => b.children === "重置为默认视图");
  if (!btn) throw new Error("未找到「重置为默认视图」按钮");
  return btn;
}

beforeEach(() => {
  resetPrefsSpy.mockReset();
  toastSpy.mockReset();
  resetPrefsSpy.mockResolvedValue(true);
});

describe("① 用户已自定义（userPrefs 非 null）：可重置", () => {
  it("按钮不被禁用、无禁用 title", () => {
    const btn = renderPanel(PREFS);
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBeUndefined();
  });

  it("点击调 resetViewPrefs（删除自己的 prefs），不带结构权也能调", async () => {
    const btn = renderPanel(PREFS);
    await btn.onClick?.();
    expect(resetPrefsSpy).toHaveBeenCalledTimes(1);
    expect(resetPrefsSpy).toHaveBeenCalledWith({ viewId: "v1", tableId: TABLE_ID });
  });

  it("重置成功 toast 提示", async () => {
    const btn = renderPanel(PREFS);
    await btn.onClick?.();
    expect(toastSpy).toHaveBeenCalledWith("已恢复视图默认设置", "success");
  });
});

describe("② 当前为默认视图（userPrefs === null）：按钮禁用", () => {
  it("disabled 为 true", () => {
    const btn = renderPanel(null);
    expect(btn.disabled).toBe(true);
  });

  it("带 title「当前为默认视图」", () => {
    const btn = renderPanel(null);
    expect(btn.title).toBe("当前为默认视图");
  });

  it("点击不触发 resetViewPrefs（handler 提前返回）", async () => {
    const btn = renderPanel(null);
    await btn.onClick?.();
    expect(resetPrefsSpy).not.toHaveBeenCalled();
  });
});
