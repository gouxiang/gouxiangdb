// M2/S7 部门「添加已有成员」弹层：把系统里已存在的成员加进本部门（部门 → 成员方向的唯一入口）。
//
// 与 MemberList 的「添加」区分开：后者是建账号（InviteMemberModal），本弹层只做既有成员的归属写入。
// 数据源与写操作都复用 contacts-hooks（OrgMembers.list / assignDepartments），不新建人员数据结构。
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Modal, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { DeptDTO } from "@gx/shared-types";
import { useOrgMembers, useOrgMemberMutations } from "./contacts-hooks";
import { assignableMembers } from "./lib/dept-members";
import { StatusBadge, errText } from "./contacts-ui";

export function AddDeptMembersModal({
  dept,
  onClose,
}: {
  dept: DeptDTO;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  // 搜索 300ms 防抖（与 MemberList 同口径），避免每敲一个键就打一次服务端。
  useEffect(() => {
    const t = setTimeout(() => setQ(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  // 全量目录（不按部门过滤），归属信息随 DTO 一起回来，前端即可判重。
  const query = useOrgMembers({ q, deptId: null, status: null });
  const m = useOrgMemberMutations();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // 已在本部门的成员不进候选（后端 add 是 upsert 不报错，靠前端挡住无声重复写）。
  const candidates = useMemo(
    () => assignableMembers(query.items, dept.id),
    [query.items, dept.id],
  );

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function submit() {
    const targets = candidates.filter((x) => chosen.has(x.id));
    if (targets.length === 0) return;
    setSaving(true);
    try {
      const results = await Promise.allSettled(
        targets.map((t) =>
          m.assignDepartments.mutateAsync({
            id: t.id,
            data: {
              add: [dept.id],
              // 后端 add 建行 isMain=0；原本没有任何部门的人必须顺带给主部门（一人一主）。
              // 同请求内 add 先落行再校验 mainDeptId 归属，顺序安全。
              ...(t.deptMemberships.length === 0 ? { mainDeptId: dept.id } : {}),
            },
          }),
        ),
      );
      const okCount = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.find((r) => r.status === "rejected");
      // 部门树的 memberCount 走 departments 查询，members 的 invalidate 覆盖不到。
      void qc.invalidateQueries({ queryKey: ["org", "departments"] });
      if (okCount > 0) toast(`已把 ${okCount} 位成员加入「${dept.name}」`, "success");
      if (failed) {
        toast(errText((failed as PromiseRejectedResult).reason, "添加失败"), "error");
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`添加已有成员到「${dept.name}」`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
          <Button
            variant="primary"
            icon="userPlus"
            disabled={chosen.size === 0}
            loading={saving}
            onClick={() => void submit()}
          >
            添加{chosen.size > 0 ? `（${chosen.size}）` : ""}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gx-text-hint"
          />
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索姓名或邮箱…"
            className="h-8 pl-7"
          />
        </div>

        {query.isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="text-gx-13 text-gx-danger">
              {errText(query.error, "成员列表加载失败")}
            </span>
            <Button variant="ghost" onClick={() => void query.refetch()}>重试</Button>
          </div>
        ) : query.isLoading ? (
          <div className="flex items-center justify-center py-10"><Spinner size={20} /></div>
        ) : candidates.length === 0 ? (
          <div className="py-10 text-center text-gx-12 text-gx-text-hint">
            {query.items.length === 0
              ? "没有匹配的成员"
              : "匹配到的成员都已在本部门，无需重复添加"}
          </div>
        ) : (
          <>
            <ul className="max-h-[46vh] divide-y divide-gx-separator overflow-y-auto rounded-gx-lg border border-gx-separator">
              {candidates.map((u) => (
                <li key={u.id}>
                  <label className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gx-row-hover">
                    <Checkbox checked={chosen.has(u.id)} onChange={() => toggle(u.id)} />
                    <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">
                      {u.displayName}
                    </span>
                    <span className="max-w-[45%] truncate text-gx-11 text-gx-text-hint">{u.email}</span>
                    <StatusBadge status={u.status} />
                  </label>
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <button
                type="button"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="self-center text-gx-12 text-gx-accent hover:underline disabled:opacity-60"
              >
                {query.isFetchingNextPage ? "加载中…" : "加载更多成员"}
              </button>
            )}
          </>
        )}

        <p className="text-gx-11 text-gx-text-hint">
          已在本部门的成员不会出现在列表里；原本没有部门的成员加入后会以该部门为主部门。
        </p>
      </div>
    </Modal>
  );
}
