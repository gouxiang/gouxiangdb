// M2/S7 成员编辑抽屉：多部门（主部门单选 + 兼岗多选）、只读有效角色来源清单、停用/重新激活（二次确认）。
// 企业化定位：部门归属写仍挂 manage_members（调岗/兼岗），停用改由 disable_users 门控，
// 并新增「删除账号」——物理删除、不可恢复，所以单独占一枚 delete_users，不与停用共用动词。
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { DeptDTO, OrgMemberDTO } from "@gx/shared-types";
import {
  useDepartments,
  useEffectiveRoles,
  useOrgMemberMutations,
} from "./contacts-hooks";
import { ConfirmDanger, StatusBadge, errText } from "./contacts-ui";
import { confirmIrreversible } from "../../components/feedback";

export function MemberDrawer({
  member,
  canAssignDepartments,
  canDisableUsers,
  canDeleteUsers,
  onClose,
}: {
  member: OrgMemberDTO;
  /** 部门归属写权限（调岗/兼岗），后端门控动作是 manage_members。 */
  canAssignDepartments: boolean;
  canDisableUsers: boolean;
  canDeleteUsers: boolean;
  onClose: () => void;
}) {
  const { data: depts } = useDepartments();
  const effective = useEffectiveRoles(member.id);
  const m = useOrgMemberMutations();

  // 本地编辑态：归属部门集合 + 主部门。保存时与服务端现状做 add/remove/mainDeptId diff。
  const initial = useMemo(() => {
    const memberDeptIds = new Set(member.deptMemberships.map((d) => d.departmentId));
    const main = member.deptMemberships.find((d) => d.isMain)?.departmentId ?? null;
    return { memberDeptIds, main };
  }, [member]);

  const [checked, setChecked] = useState<Set<string>>(initial.memberDeptIds);
  const [mainId, setMainId] = useState<string | null>(initial.main);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [saving, setSaving] = useState(false);

  // 切换成员时重置编辑态
  useEffect(() => {
    setChecked(initial.memberDeptIds);
    setMainId(initial.main);
  }, [initial]);

  const liveDepts = useMemo(() => depts ?? [], [depts]);
  const deptName = useMemo(() => {
    const map = new Map(liveDepts.map((d) => [d.id, d.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [liveDepts]);

  const dirty =
    checked.size !== initial.memberDeptIds.size ||
    [...checked].some((id) => !initial.memberDeptIds.has(id)) ||
    mainId !== initial.main;

  function toggleDept(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // 若移走的恰是主部门，主部门置空
        if (mainId === id) setMainId(null);
      } else {
        next.add(id);
        // 首个归属自动设为主部门
        setMainId((cur) => cur ?? id);
      }
      return next;
    });
  }

  async function save() {
    const add = [...checked].filter((id) => !initial.memberDeptIds.has(id));
    const remove = [...initial.memberDeptIds].filter((id) => !checked.has(id));
    setSaving(true);
    try {
      await m.assignDepartments.mutateAsync({
        id: member.id,
        data: {
          ...(add.length ? { add } : {}),
          ...(remove.length ? { remove } : {}),
          // 主部门变化才传；主部门必须仍在归属集合内
          ...(mainId && mainId !== initial.main ? { mainDeptId: mainId } : {}),
        },
      });
      toast("已更新部门归属", "success");
      onClose();
    } catch (e) {
      toast(errText(e, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  }

  const isDisabled = member.status === "DISABLED";
  const isInvited = member.status === "INVITED";

  return (
    <>
      <div className="absolute inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside className="absolute right-0 top-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-gx-separator bg-gx-surface shadow-xl">
        <div className="flex items-start justify-between border-b border-gx-separator px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-gx-14 font-semibold text-gx-text-primary">{member.displayName}</span>
              <StatusBadge status={member.status} />
            </div>
            <div className="truncate text-gx-12 text-gx-text-tertiary">{member.email}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-bg" aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 部门归属 */}
          <section className="mb-5">
            <div className="mb-2 text-gx-13 font-semibold text-gx-text-primary">部门归属</div>
            {!canAssignDepartments && (
              <p className="mb-2 text-gx-12 text-gx-text-hint">你没有调整部门归属的权限，以下为只读。</p>
            )}
            {liveDepts.length === 0 ? (
              <p className="text-gx-12 text-gx-text-hint">暂无部门，可先在左侧创建。</p>
            ) : (
              <div className="flex flex-col gap-1">
                {liveDepts.map((d: DeptDTO) => {
                  const inDept = checked.has(d.id);
                  const isMain = mainId === d.id;
                  return (
                    <div key={d.id} className="flex items-center gap-2 rounded-gx-sm px-1 py-1 hover:bg-gx-bg">
                      <Checkbox
                        checked={inDept}
                        disabled={!canAssignDepartments}
                        onChange={() => toggleDept(d.id)}
                        label={<span className="text-gx-13 text-gx-text-primary">{d.name}</span>}
                      />
                      <div className="ml-auto flex items-center gap-2">
                        {inDept && (
                          isMain ? (
                            <span className="rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-11 font-medium text-gx-accent">主部门</span>
                          ) : canAssignDepartments ? (
                            <button
                              type="button"
                              onClick={() => setMainId(d.id)}
                              className="rounded-full border border-gx-border px-2 py-0.5 text-gx-11 text-gx-text-tertiary hover:bg-gx-bg"
                            >
                              设为主部门
                            </button>
                          ) : null
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {canAssignDepartments && (
              <p className="mt-1.5 text-gx-11 text-gx-text-hint">勾选为兼岗；每个成员有且仅有一个主部门。</p>
            )}
          </section>

          {/* 有效组织角色（只读，含来源） */}
          <section className="mb-5">
            <div className="mb-2 text-gx-13 font-semibold text-gx-text-primary">有效组织角色</div>
            {effective.isLoading ? (
              <Spinner size={16} />
            ) : (effective.data ?? []).length === 0 ? (
              <p className="text-gx-12 text-gx-text-hint">暂无组织角色（资源权限不受此影响）。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(effective.data ?? []).map((r) => (
                  <li key={r.roleId} className="rounded-gx-lg border border-gx-separator px-2.5 py-2">
                    <div className="flex items-center gap-1.5">
                      {r.isSystem && <Icon name="crown" size={13} className="text-gx-warning" />}
                      <span className="text-gx-13 font-medium text-gx-text-primary">{r.name}</span>
                    </div>
                    <div className="mt-1 flex flex-col gap-0.5">
                      {r.sources.map((s, i) => (
                        <div key={`${s.type}-${s.id}-${i}`} className="flex items-center gap-1 text-gx-12 text-gx-text-tertiary">
                          <Icon name={s.type === "user" ? "user" : "building"} size={12} />
                          <span>
                            {s.type === "user" ? "直接授予本人" : `经部门「${s.name ?? deptName(s.id)}」继承`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 底部：保存 / 停用 / 重新激活 / 删除账号
            三件套各自门控：能调岗不一定能停用，能停用不一定能删人。 */}
        {(canAssignDepartments || canDisableUsers || canDeleteUsers) && (
          <div className="border-t border-gx-separator px-4 py-3">
            {canDisableUsers && (
              <div className="mb-2 flex gap-2">
                {isDisabled ? (
                  <Button variant="secondary" icon="refresh" block loading={m.reactivate.isPending}
                    onClick={async () => {
                      try {
                        await m.reactivate.mutateAsync(member.id);
                        toast("已重新激活，对方需重新登录", "success");
                        onClose();
                      } catch (e) {
                        toast(errText(e, "激活失败"), "error");
                      }
                    }}
                  >
                    重新激活
                  </Button>
                ) : (
                  <Button variant="danger" icon="userSlash" block disabled={isInvited}
                    title={isInvited ? "待激活账号无需停用" : "停用账号"}
                    onClick={() => setConfirmDisable(true)}
                  >
                    停用账号
                  </Button>
                )}
              </div>
            )}
            {canDeleteUsers && (
              <div className="mb-2">
                <Button variant="danger" icon="trash" block loading={m.remove.isPending}
                  onClick={async () => {
                    const ok = await confirmIrreversible({
                      title: `删除账号「${member.displayName}」`,
                      confirmText: "彻底删除账号",
                      description:
                        `将从工作区移除 ${member.email} 及其全部数据（部门归属、角色授予、令牌与评论一并清除）。` +
                        "该操作不可恢复——如果对方只是暂时不需要访问，应改用「停用账号」。",
                    });
                    if (!ok) return;
                    try {
                      await m.remove.mutateAsync(member.id);
                      toast("账号已删除", "success");
                      onClose();
                    } catch (e) {
                      toast(errText(e, "删除失败"), "error");
                    }
                  }}
                >
                  删除账号
                </Button>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>关闭</Button>
              {canAssignDepartments && (
                <Button variant="primary" disabled={!dirty || saving} loading={saving} onClick={save}>
                  保存部门
                </Button>
              )}
            </div>
          </div>
        )}
      </aside>

      <ConfirmDanger
        open={confirmDisable}
        title="停用成员"
        confirmText="确认停用"
        busy={m.disable.isPending}
        onClose={() => setConfirmDisable(false)}
        onConfirm={async () => {
          try {
            await m.disable.mutateAsync(member.id);
            toast("已停用，其登录态将在下次操作时失效", "success");
            setConfirmDisable(false);
            onClose();
          } catch (e) {
            toast(errText(e, "停用失败"), "error");
            setConfirmDisable(false);
          }
        }}
        body={
          <>
            <p>
              确定停用「<span className="font-medium">{member.displayName}</span>（{member.email}）」吗？
            </p>
            <p className="text-gx-12 text-gx-text-tertiary">
              停用后其当前登录态立即失效，下次任意操作会被退出登录；部门归属与角色授予会保留，可随时重新激活。
            </p>
          </>
        }
      />
    </>
  );
}
