// apps/web/src/features/settings/SettingsPage.tsx
// 设置中心：左二级导航（概览/数据表/危险操作）+ 内容区
// 顶部返回按钮回到上一个视图；支持 #tables 等 hash 直达 tab
//
// 权限口径（不要再加回来）：「成员与权限」「分享」两个 tab 已移除 ——
// 全站唯一的权限配置入口是「工作区设置 → 权限管理」，那里同时管组织角色、
// 各库成员与分享、资源授权策略。这里只留本库自身的信息与结构设置。

import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  useBase,
  useBaseStats,
  useTables,
  useFields,
  useGXMutations,
} from "../../api/hooks";
import { Button, EmptyState, Input, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { EntityIconPicker } from "../../components/EntityIconPicker";
// 阶段 4：危险操作统一走 feedback.tsx 的 L1~L5 分级（R-D-23 / R-D-24）
import { confirmIrreversible, confirmSoftDelete, confirmClearTable } from "../../components/feedback";
import { toastDeleted } from "../../components/interaction";
import { colors } from "@gx/design-tokens";

type Tab = "overview" | "tables" | "danger";

const TABS: { key: Tab; label: string; icon: "grid" | "table" | "alertCircle" }[] = [
  { key: "overview", label: "概览", icon: "grid" },
  { key: "tables", label: "数据表", icon: "table" },
  { key: "danger", label: "危险操作", icon: "alertCircle" },
];

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-card-bg p-4">
      <div className="text-gx-24 font-semibold text-gx-text-primary">{value}</div>
      <div className="mt-1 text-gx-12 text-gx-text-tertiary">{label}</div>
    </div>
  );
}

function TableStatRow({ baseId, tableId, name, recordCount, canManageSchema }: {
  baseId: string;
  tableId: string;
  name: string;
  recordCount: number;
  canManageSchema: boolean;
}) {
  const navigate = useNavigate();
  const { data: fields } = useFields(tableId);
  const m = useGXMutations();

  // 阶段 4 · R-D-23 L2（软删除进回收站，可恢复）+ R-I-08（toast 带撤销）
  async function removeTable() {
    if (!baseId) return;
    const ok = await confirmSoftDelete({
      title: `删除数据表「${name}」`,
      confirmText: "删除数据表",
      description: "数据表会移入回收站，30 天内可恢复。",
    });
    if (!ok) return;
    try {
      await m.deleteTable.mutateAsync({ tableId, baseId });
      navigate(`/base/${baseId}`);
      toastDeleted({
        message: `已删除数据表「${name}」`,
        restoredMessage: `已恢复数据表「${name}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id: tableId, kind: "table", baseId }),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  // 阶段 4 · R-D-23 L3：清空是软删进回收站，但服务端不回 id 列表 → 做不出一键撤销，
  // 用「输入表名确认」的强度补偿（与顶栏同一口径）。
  async function clearTable() {
    if (!baseId) return;
    const ok = await confirmClearTable({ tableName: name });
    if (!ok) return;
    try {
      await m.clearTable.mutateAsync({ tableId });
      toast("已清空数据，记录已移入回收站", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-gx-separator px-3 py-2.5">
      <Icon name="table" size={15} className="text-gx-text-tertiary" />
      <button
        type="button"
        onClick={() => navigate(`/base/${baseId}/table/${tableId}`)}
        className="flex-1 text-left text-gx-13 text-gx-text-primary hover:text-gx-accent"
      >
        {name}
      </button>
      <span className="text-gx-12 text-gx-text-tertiary">字段 {fields?.length ?? 0}</span>
      <span className="text-gx-12 text-gx-text-tertiary">记录 {recordCount}</span>
      {canManageSchema && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => m.duplicateTable.mutate({ tableId })}>
            复制
          </Button>
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={() => void clearTable()}>
            清空
          </Button>
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={() => void removeTable()}>
            删除
          </Button>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { baseId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const hashTab = location.hash.replace("#", "") as Tab;
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.key === hashTab) ? hashTab : "overview");

  const baseQ = useBase(baseId ?? null);
  const statsQ = useBaseStats(baseId ?? null);
  const { data: tables } = useTables(baseId ?? null);
  const m = useGXMutations();

  const perms = baseQ.data?.permissions;
  const canManageBase = perms?.canManageBase ?? false;
  const canManageSchema = perms?.canManageSchema ?? false;

  const [name, setName] = useState(baseQ.data?.name ?? "");
  const [iconColor, setIconColor] = useState(baseQ.data?.iconColor ?? colors.accent);
  const [icon, setIcon] = useState<string | null>(baseQ.data?.icon ?? null);
  // 阶段 4：删除库的确认已改走 feedback.tsx 的分级弹窗（现为 L4），不再需要页内 Modal 的开关与输入框状态

  // base 加载后同步名称
  useEffect(() => {
    if (baseQ.data) {
      setName(baseQ.data.name);
      setIconColor(baseQ.data.iconColor);
      setIcon(baseQ.data.icon);
    }
  }, [baseQ.data]);

  // 权限治理第二批：无 canManageBase 时左侧导航里就不该出现「危险操作」，
  // 否则点进去是一块空白（内容区已被隐藏）。已停在该 tab 上的要主动回退到概览。
  const visibleTabs = TABS.filter((t) => canManageBase || t.key !== "danger");
  useEffect(() => {
    if (!canManageBase && tab === "danger") setTab("overview");
  }, [canManageBase, tab]);

  async function saveBase() {
    if (!baseId || !canManageBase) return;
    try {
      await m.updateBase.mutateAsync({ baseId, data: { name, iconColor, icon } });
      toast("已保存", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", "error");
    }
  }

  // R-D-23 L4（不可恢复）+ R-D-24（主按钮用具体动词，不用「确定」）
  //
  // 回收站（apps/api/src/routes/records.ts:214 /trash）只列 record / table / field 三类，
  // **不含 base**；且其候选表只查 `deletedAt: null`（records.ts:220）——`DELETE /bases/:baseId`
  // （apps/api/src/routes/bases.ts:267）软删库的同时把它下面的 table 也标了 deletedAt，
  // 于是这些表与记录同样不再出现在回收站里。删库后 UI 无任何恢复入口，实质等同不可恢复 → L4。
  // 保留 confirmName：L4 仍要求原样输入库名，只是在此之上叠加红色主按钮（confirmGateFor L4）。
  async function deleteBase() {
    if (!baseId) return;
    const baseName = baseQ.data?.name ?? "";
    const ok = await confirmIrreversible({
      confirmName: baseName,
      title: `删除数据库「${baseName}」`,
      confirmText: "删除数据库",
      description:
        "库内所有数据表、记录与视图都会被删除，分享链接也随之失效。回收站不收数据库，因此无法从回收站恢复，也没有撤销入口。",
    });
    if (!ok) return;
    try {
      await m.deleteBase.mutateAsync(baseId);
      toast("已删除数据库", "success");
      navigate("/");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  return (
    <div className="flex h-full bg-gx-surface">
      {/* 左侧二级导航 */}
      <div className="w-[180px] shrink-0 border-r border-gx-separator bg-gx-bg p-2">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={[
              "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left text-gx-13",
              tab === t.key ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
            ].join(" ")}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部返回 */}
        <div className="flex h-12 items-center gap-2 border-b border-gx-separator px-3">
          <button
            type="button"
            onClick={() => navigate(`/base/${baseId}`)}
            className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-bg"
            title="返回"
          >
            <Icon name="chevronLeft" size={16} />
          </button>
          <span className="text-gx-14 font-semibold text-gx-text-primary">
            {TABS.find((t) => t.key === tab)?.label}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === "overview" && (
            <div className="flex flex-col gap-6">
              {baseId && (
                <div className="rounded-gx-lg border border-gx-border bg-gx-surface p-4">
                  <div className="flex items-center gap-3">
                    <Icon name="link" size={20} className="text-gx-accent" />
                    <div className="flex-1">
                      <div className="text-gx-14 font-medium text-gx-text-primary">数据库关系图</div>
                      <div className="mt-0.5 text-gx-12 text-gx-text-tertiary">
                        可视化当前数据库内所有数据表与跨表关联，便于梳理结构
                      </div>
                    </div>
                    <Button variant="primary" icon="link" onClick={() => navigate(`/base/${baseId}/erd`)}>
                      查看 ERD
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-4 gap-3">
                <StatCard label="数据表" value={statsQ.data?.tableCount ?? 0} />
                <StatCard label="记录" value={statsQ.data?.recordCount ?? 0} />
                <StatCard label="字段" value={statsQ.data?.fieldCount ?? 0} />
                <StatCard label="成员" value={statsQ.data?.memberCount ?? 0} />
              </div>

              <div className="rounded-gx-lg border border-gx-border p-4">
                <div className="mb-3 text-gx-14 font-medium text-gx-text-primary">Base 信息</div>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    {/* 原「色块 + 12 色板」升级为统一「图标 + 颜色」选择器：
                        选中即时写库（走 updateBase），失败由 EntityIconPicker 统一 toast。 */}
                    <EntityIconPicker
                      icon={icon}
                      iconColor={iconColor}
                      defaultIcon="database"
                      defaultColor={colors.accent}
                      readOnly={!canManageBase}
                      ariaLabel="数据库图标与颜色"
                      onChange={async (next) => {
                        if (!baseId) return;
                        const updated = await m.updateBase.mutateAsync({
                          baseId,
                          // iconColor 必须原样透传（含 null = 恢复默认色）：此前写的是 `?? iconColor`，
                          // 等于把旧色又发回去，后端永远收不到 null，「恢复默认」清不掉颜色。
                          data: { iconColor: next.iconColor, icon: next.icon },
                        });
                        setIconColor(updated.iconColor);
                        setIcon(updated.icon);
                      }}
                    />
                    {canManageBase ? (
                      <span className="text-gx-12 text-gx-text-hint">
                        选择后立即生效；名称仍需点「保存」。
                      </span>
                    ) : (
                      <span className="text-gx-12 text-gx-text-hint">仅所有者可修改</span>
                    )}
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <div className="mb-1 text-gx-12 text-gx-text-tertiary">名称</div>
                      {/* 权限治理第二批：改库名属管理类操作，无权限时不给灰掉的 input
                          —— 按 R-D-11 约定走「只读可复制」而非 disabled（disabled 无法选中复制）。 */}
                      {canManageBase ? (
                        <Input value={name} onChange={(e) => setName(e.target.value)} />
                      ) : (
                        <div className="flex h-8 items-center">
                          <span className="select-text text-gx-13 text-gx-text-primary">{name}</span>
                        </div>
                      )}
                    </div>
                    {canManageBase && (
                      <Button variant="primary" onClick={saveBase}>
                        保存
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* 成员与分享已从本页移除：全站唯一的权限入口是「工作区设置 → 权限管理」，
                  这里只留一句引导，不再挂第二份编辑界面（两处都能改＝口径分裂）。 */}
              <div className="flex flex-col gap-3 rounded-gx-lg border border-gx-border bg-gx-surface p-4 sm:flex-row sm:items-center">
                <Icon name="users" size={20} className="shrink-0 text-gx-accent" />
                <div className="min-w-0 flex-1">
                  <div className="text-gx-14 font-medium text-gx-text-primary">成员与权限</div>
                  <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
                    谁可以访问这个库、谁能改、谁能分享，统一在「工作区设置 → 权限管理」里配置。
                  </p>
                </div>
                <Button
                  variant="secondary"
                  icon="shield"
                  onClick={() => navigate("/workspace/settings/authz")}
                >
                  前往权限管理
                </Button>
              </div>
            </div>
          )}

          {tab === "tables" && (
            <div className="rounded-gx-lg border border-gx-border">
              {(tables ?? []).map((t) => (
                <TableStatRow
                  key={t.id}
                  baseId={baseId!}
                  tableId={t.id}
                  name={t.name}
                  recordCount={t.recordCount}
                  canManageSchema={canManageSchema}
                />
              ))}
              {(!tables || tables.length === 0) && (
                <EmptyState
                  icon="table"
                  title="还没有数据表"
                  description="数据表是结构化数据的容器，建库后即可在此新增。"
                />
              )}
            </div>
          )}

          {/* 权限治理第二批：删库是不可逆破坏性操作，无权限时整个危险操作区都不渲染
              （连同「仅所有者可执行此操作」一起消失——入口不存在了，提示没有意义）。 */}
          {canManageBase && tab === "danger" && (
            <div className="rounded-gx-lg border border-gx-danger bg-gx-danger-bg p-4">
              <div className="text-gx-14 font-medium text-gx-danger">删除 Base</div>
              <div className="mt-1 text-gx-12 text-gx-text-secondary">
                删除后该库及其下所有数据表与记录都会被删除，分享链接也随之失效。回收站只收记录、数据表和字段，不含数据库，因此删除后无法从回收站恢复，也没有撤销入口。
              </div>
              <div className="mt-3">
                <Button variant="danger" onClick={() => void deleteBase()}>
                  删除整个 Base
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
