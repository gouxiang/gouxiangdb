// apps/web/src/features/settings/MembersPanel.tsx
// 库 / 知识库设置页里的「谁能访问这个库」——只读台账 + 库级「允许分享」开关。
//
// 权限核心模型落地前，这里是一张逐库逐人的成员名册（加人 / 改角色 / 踢人三个写端点）。
// 模型改成「角色 × 库」单一裁决后，后端把这三个端点一并下线（bases.ts / kb/members.ts
// 同款注释）：名册不再是授权入口，留着写按钮就是点了必 404 的死入口。
// 现在这里只回答一个问题——哪些角色覆盖到这个库、各覆盖多少人；
// 要改谁能进来，去通讯录改这个人的角色，或去权限管理改角色的库视野。
//
// 两条纪律：
//   - 超级管理员与管理员不配库视野也能进所有库，必须单独列人数。不列的话页面会显示
//     「没有任何角色能访问本库」，管理员照着这个错误结论去补授权，越补越乱。
//   - fail-closed：台账没回来 / 出错 / 还在加载，一律按「看不到也改不了」渲染——
//     开关不出现（不是置灰；置灰等于告诉别人这里有个门）。

import { useNavigate } from "react-router-dom";
import { Button, Switch, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useLibraryAccess, useRoleScopesShareEnabled } from "../../api/hooks";
import { useMyRoleRefs } from "./role-permission/role-permission-hooks";
import type { LibraryKind } from "@gx/shared-types";

export function LibraryAccessPanel({
  kind,
  libraryId,
}: {
  kind: LibraryKind;
  libraryId: string;
}) {
  const navigate = useNavigate();
  const access = useLibraryAccess(kind, libraryId);
  const { roleIds, isSuperOrAdmin, isLoading: myLoading } = useMyRoleRefs();
  const setShareEnabled = useRoleScopesShareEnabled();

  const vis = access.data ?? null;
  // 谁能开这个开关：对该库有管理权的角色成员，或超级管理员 / 管理员。
  // 三个信号任一没回来都判 false（加载中、出错、空数据）。
  const canToggleShare =
    !access.isLoading && !access.isError && !myLoading && !!vis
      ? isSuperOrAdmin || vis.roles.some((r) => r.canManage && roleIds.has(r.roleId))
      : false;

  async function flipShare(next: boolean) {
    try {
      await setShareEnabled.mutateAsync({ kind, libraryId, enabled: next });
      toast(next ? "已允许分享这个库" : "已关闭这个库的分享", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败，可能你没有这个库的分享管理权", "error");
    }
  }

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="users" size={20} className="mt-0.5 shrink-0 text-gx-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-gx-14 font-medium text-gx-text-primary">谁能访问这个库</div>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
            权限按角色配置，下面是当前覆盖到本库的角色与人数。要改谁能进来，请到权限管理里改角色的库视野，
            或到通讯录改这个人属于哪个角色。
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

      {access.isLoading && (
        <div className="mt-3 text-gx-12 text-gx-text-hint">正在读取这个库的角色覆盖…</div>
      )}

      {access.isError && (
        <div className="mt-3 flex items-start gap-1.5 text-gx-12 text-gx-text-tertiary">
          <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
          <span>角色覆盖读取失败，暂时无法判断是否允许分享。</span>
        </div>
      )}

      {vis && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            <CoverageChip icon="crown" text={`超级管理员 ${vis.implicitSuperAdminCount} 人（不配也能进）`} />
            <CoverageChip icon="shield" text={`管理员 ${vis.implicitAdminCount} 人（不配也能进）`} />
            {vis.roles.length === 0 && (
              <span className="text-gx-11 text-gx-text-hint">还没有任何角色通过库视野覆盖到本库。</span>
            )}
          </div>

          {vis.roles.length > 0 && (
            <div className="overflow-hidden rounded-gx-lg border border-gx-border">
              <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-1.5 text-gx-12 font-medium text-gx-text-secondary">
                <span className="flex-1">角色</span>
                <span className="w-20">在本库</span>
                <span className="w-20 text-right">人数</span>
              </div>
              {vis.roles.map((r) => (
                <div
                  key={r.roleId}
                  className="flex items-center gap-3 border-b border-gx-separator px-3 py-1.5 last:border-0"
                >
                  <span className="flex flex-1 items-center gap-1.5 text-gx-13 text-gx-text-primary">
                    {r.systemKey ? (
                      <Icon name="crown" size={12} className="shrink-0 text-gx-warning" />
                    ) : (
                      <Icon name="shield" size={12} className="shrink-0 text-gx-text-tertiary" />
                    )}
                    <span className="truncate">{r.roleName}</span>
                  </span>
                  <span className="w-20 text-gx-12 text-gx-text-secondary">
                    {r.canManage ? "可管理" : "可见"}
                  </span>
                  <span className="w-20 text-right text-gx-12 tabular-nums text-gx-text-tertiary">
                    {r.memberCount}
                  </span>
                </div>
              ))}
            </div>
          )}

          {canToggleShare ? (
            <div className="flex flex-col gap-1 border-t border-gx-separator pt-2.5">
              <Switch
                checked={vis.shareEnabled}
                onChange={(v) => void flipShare(v)}
                label={<span className="text-gx-13">允许把这个库的内容分享出去</span>}
              />
              <p className="text-gx-11 text-gx-text-hint">
                关掉之后再外发的链接会失效；外部人始终只读，分享不提供任何写能力。
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 border-t border-gx-separator pt-2.5 text-gx-11 text-gx-text-tertiary">
              <Icon name="lock" size={12} className="mt-0.5 shrink-0" />
              <span>
                「允许分享」只有对本库有管理权的角色、超级管理员与管理员能开；当前登录者不在其中，所以这里没有开关。
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CoverageChip({
  icon,
  text,
}: {
  icon: "crown" | "shield";
  text: string;
}) {
  return (
    <span
      title={text}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-secondary"
    >
      <Icon name={icon} size={11} className="shrink-0 text-gx-text-tertiary" />
      <span className="truncate">{text}</span>
    </span>
  );
}
