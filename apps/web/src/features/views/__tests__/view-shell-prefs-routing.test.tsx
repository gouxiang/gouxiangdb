// ViewShell 视图配置分流行为测试（#561）。
//
// 锁三件事：
//   ① 普通成员（canManageSchema=false）的纯使用态改动 → saveViewPrefs（写自己的 prefs），
//      不触碰共享 updateView；
//   ② 管理者（canManageSchema=true）的使用态改动，以及任何人的结构层改动 → 原 updateView；
//   ③ saveViewPrefs 失败 → toast 报错（乐观回滚路径被触发）。
//
// node 环境，无 jsdom：用 react-dom/server 渲染外壳，children render-prop 里捕获
// onUpdateConfig 引用，渲染结束后在外部直接调用它（setState 在 SSR 后是 no-op，
// 但分流判定与 mutateAsync 调用会真实执行），再断言替身 mutation 的调用参数。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { defaultViewConfig } from "@gx/shared-types";
import type { PermissionSet, ViewDTO } from "@gx/shared-types";
import type { ViewShellArgs } from "../ViewShell";

const savePrefsSpy = vi.fn(
  async (_p: { viewId: string; tableId: string; prefs: Record<string, unknown> }) => ({}),
);
const updateViewSpy = vi.fn(async () => ({}));
const toastSpy = vi.fn();

vi.mock("../../../api/hooks", () => ({
  useTables: () => ({ data: [] }),
  useGXMutations: () => ({
    saveViewPrefs: { mutateAsync: savePrefsSpy },
    updateView: { mutateAsync: updateViewSpy },
    resetViewPrefs: { mutateAsync: vi.fn(async () => true) },
    createRecord: { mutateAsync: vi.fn(async () => ({})) },
    duplicateView: { mutateAsync: vi.fn(async () => ({})) },
    clearTable: { mutateAsync: vi.fn(async () => ({})) },
    updateTable: { mutateAsync: vi.fn(async () => ({})) },
  }),
}));
vi.mock("../../../components/ui", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));
vi.mock("../../../components/interaction", () => ({
  useWriteGuard: () => ({ run: (_k: string, fn: () => unknown) => fn(), isBusy: () => false }),
}));
vi.mock("../../../components/confirm-table", () => ({
  confirmClearTable: vi.fn(async () => false),
}));
vi.mock("../../../components/EntityIconPicker", () => ({
  EntityIconPicker: () => <span data-mock="icon-picker" />,
}));
vi.mock("../../grid/ViewSwitcher", () => ({
  ViewSwitcher: () => <span data-mock="view-switcher" />,
}));
vi.mock("../../grid/GridToolbar", () => ({
  GridToolbar: () => <span data-mock="grid-toolbar" />,
}));
vi.mock("../../grid/GridView", () => ({
  TableViewIoDialogs: () => <span data-mock="io-dialogs" />,
}));
vi.mock("../../sharing/TableShareModal", () => ({
  TableShareModal: () => <span data-mock="share-modal" />,
}));
vi.mock("../../shell/ViewSettingsModal", () => ({
  ViewSettingsModal: () => <span data-mock="view-settings-modal" />,
}));

import { ViewShell } from "../ViewShell";

const BASE_ID = "b1";
const TABLE_ID = "t1";
const VIEW_ID = "v1";

function makeView(): ViewDTO {
  return {
    id: VIEW_ID,
    tableId: TABLE_ID,
    name: "网格视图",
    type: "grid",
    lockMode: "collaborative",
    order: 0,
    config: defaultViewConfig(),
    userPrefs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ViewDTO;
}

const PERM_MEMBER: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: true,
  canComment: true,
  canView: true,
};
const PERM_ADMIN: PermissionSet = { ...PERM_MEMBER, canManageSchema: true };

/** 渲染外壳并捕获 children 收到的 onUpdateConfig。 */
function renderAndCapture(permissions: PermissionSet): ViewShellArgs["onUpdateConfig"] {
  let captured: ViewShellArgs["onUpdateConfig"] | null = null;
  render(
    <ViewShell
      baseId={BASE_ID}
      tableId={TABLE_ID}
      viewId={VIEW_ID}
      view={makeView()}
      permissions={permissions}
    >
      {(args) => {
        captured = args.onUpdateConfig;
        return <span>content</span>;
      }}
    </ViewShell>,
  );
  if (!captured) throw new Error("未捕获到 onUpdateConfig");
  return captured;
}

beforeEach(() => {
  savePrefsSpy.mockReset();
  updateViewSpy.mockReset();
  toastSpy.mockReset();
  savePrefsSpy.mockResolvedValue({});
  updateViewSpy.mockResolvedValue({});
});

describe("① 普通成员：纯使用态改动走 saveViewPrefs", () => {
  it("搜索（search）写入个人 prefs，不调 updateView", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ search: "abc" });
    expect(savePrefsSpy).toHaveBeenCalledTimes(1);
    expect(savePrefsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: VIEW_ID,
        tableId: TABLE_ID,
        prefs: expect.objectContaining({ search: "abc" }),
      }),
    );
    expect(updateViewSpy).not.toHaveBeenCalled();
  });

  it("排序（sorts）写入个人 prefs", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ sorts: [{ fieldId: "f1", direction: "desc" }] });
    expect(savePrefsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prefs: expect.objectContaining({ sorts: [{ fieldId: "f1", direction: "desc" }] }),
      }),
    );
    expect(updateViewSpy).not.toHaveBeenCalled();
  });

  it("聚合（aggregations）写入个人 prefs", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ aggregations: { f9: "sum" } });
    expect(savePrefsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prefs: expect.objectContaining({ aggregations: { f9: "sum" } }),
      }),
    );
  });

  it("prefs 补丁不含结构层键", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ rowHeight: "tall" });
    const arg = savePrefsSpy.mock.calls[0][0] as { prefs: Record<string, unknown> };
    expect(arg.prefs).not.toHaveProperty("hiddenFieldIds");
    expect(arg.prefs).not.toHaveProperty("fieldOrder");
    expect(arg.prefs).not.toHaveProperty("version");
  });
});

describe("② 管理者 / 结构层改动走原 updateView", () => {
  it("管理者的使用态改动（search）仍走共享 updateView", () => {
    const onUpdateConfig = renderAndCapture(PERM_ADMIN);
    onUpdateConfig({ search: "abc" });
    expect(updateViewSpy).toHaveBeenCalledTimes(1);
    expect(savePrefsSpy).not.toHaveBeenCalled();
  });

  it("普通成员的结构层改动（hiddenFieldIds）走 updateView，不写 prefs", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ hiddenFieldIds: ["f1"] });
    expect(updateViewSpy).toHaveBeenCalledTimes(1);
    expect(savePrefsSpy).not.toHaveBeenCalled();
  });

  it("普通成员的行颜色（rowColor）走 updateView", () => {
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ rowColor: { mode: "none", conditions: [] } });
    expect(updateViewSpy).toHaveBeenCalledTimes(1);
    expect(savePrefsSpy).not.toHaveBeenCalled();
  });
});

describe("③ saveViewPrefs 失败：toast 报错（乐观回滚）", () => {
  it("普通成员保存 prefs 被拒时提示错误", async () => {
    savePrefsSpy.mockRejectedValueOnce(new Error("网络错误"));
    const onUpdateConfig = renderAndCapture(PERM_MEMBER);
    onUpdateConfig({ search: "abc" });
    await Promise.resolve();
    await Promise.resolve();
    expect(toastSpy).toHaveBeenCalledWith("网络错误", "error");
    expect(updateViewSpy).not.toHaveBeenCalled();
  });
});
