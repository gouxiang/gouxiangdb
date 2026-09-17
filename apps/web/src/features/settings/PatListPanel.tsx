// M6-FE 设置 → MCP 接入（SPEC §7 PatList）：PAT 列表 + 新建（一次性明文弹窗）+ 吊销（二次确认）。
//
// 契约：apps/api/src/routes/v1/pats.ts（GET/POST/DELETE /api/v1/pats）。
// 纪律：全部走 api/client.ts（禁裸 fetch）；图标仅 icons.tsx；gx-* token；无 emoji；写操作 toast。
// 一次性明文：token 仅存组件 state（createdToken），关闭即置 null 焚毁，绝不写入浏览器本地存储或 URL。
import { useState } from "react";
import { Badge, Button, EmptyState, Modal, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { CreatePatInput, PatMetadata } from "../../api/client";
import { CreatePatForm } from "./CreatePatForm";
import { PatTokenModal } from "./PatTokenModal";
import { normalizePatError, useCreatePat, usePatList, useRevokePat } from "./pat-hooks";
import {
  NEVER_EXPIRY_WARNING,
  PAT_STATE_LABEL,
  REVOKE_WARNING,
  canRevoke,
  fmtPatTime,
  orderScopes,
  patErrorText,
  patExpiryLabel,
  patTokenState,
  requiresNeverExpiryConfirm,
  scopeLabel,
} from "./pat-labels";

/** 令牌列表行：名称/状态、前缀（前 14 字符）、权限范围中文标签、创建/最后使用/有效期、吊销按钮。 */
export function PatRow({ pat, onRevoke }: { pat: PatMetadata; onRevoke: (p: PatMetadata) => void }) {
  const state = patTokenState(pat);
  const stateClass =
    state === "active" ? "text-gx-success" : state === "expired" ? "text-gx-warning" : "text-gx-text-hint";
  return (
    <div className="flex items-center gap-3 border-b border-gx-separator px-3 py-2.5 last:border-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-gx-13 text-gx-text-primary">{pat.name}</span>
        <span className={["text-gx-11", stateClass].join(" ")}>{PAT_STATE_LABEL[state]}</span>
      </div>
      <span className="w-40 truncate font-mono text-gx-12 text-gx-text-tertiary">{pat.tokenPrefix}…</span>
      <span className="flex w-56 flex-wrap gap-1">
        {orderScopes(pat.scopes).map((s) => (
          <Badge key={s}>{scopeLabel(s)}</Badge>
        ))}
      </span>
      <span className="w-32 text-gx-12 text-gx-text-tertiary">{fmtPatTime(pat.createdAt)}</span>
      <span className="w-32 text-gx-12 text-gx-text-tertiary">
        {pat.lastUsedAt ? fmtPatTime(pat.lastUsedAt) : "从未使用"}
      </span>
      <span className="w-32 text-gx-12 text-gx-text-tertiary">{patExpiryLabel(pat.expiresAt)}</span>
      <div className="flex w-16 justify-end">
        {canRevoke(pat) ? (
          <Button variant="ghost" size="sm" className="text-gx-danger" onClick={() => onRevoke(pat)}>
            吊销
          </Button>
        ) : (
          <span className="text-gx-12 text-gx-text-hint">已吊销</span>
        )}
      </div>
    </div>
  );
}

/** 吊销二次确认（pat 为 null 即关闭）。 */
export function RevokeConfirmModal({
  pat,
  busy,
  onClose,
  onConfirm,
}: {
  pat: PatMetadata | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={!!pat}
      title="吊销令牌"
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            确认吊销
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-gx-13 text-gx-text-secondary">
        <p>{REVOKE_WARNING}</p>
        {pat && (
          <p>
            令牌：<span className="font-medium text-gx-text-primary">{pat.name}</span>
            <span className="ml-1 font-mono text-gx-12 text-gx-text-tertiary">（{pat.tokenPrefix}…）</span>
          </p>
        )}
      </div>
    </Modal>
  );
}

/** 永不过期强警示二次确认（C-3）。 */
export function NeverExpiryConfirmModal({
  open,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="确认签发永不过期的令牌"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            返回修改
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            仍然签发
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-2 text-gx-13 text-gx-text-secondary">
        <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0 text-gx-warning" />
        <span>{NEVER_EXPIRY_WARNING}</span>
      </div>
    </Modal>
  );
}

export function PatListPanel() {
  const listQ = usePatList();
  const create = useCreatePat();
  const revoke = useRevokePat();

  // 一次性明文：仅存组件 state（created）；onClose 置 null 即焚，绝不写入浏览器本地存储或 URL。
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<PatMetadata | null>(null);
  const [pendingNever, setPendingNever] = useState<CreatePatInput | null>(null);

  function doCreate(input: CreatePatInput) {
    setPendingNever(null);
    create.mutate(input, {
      onSuccess: (r) => setCreated({ token: r.token, name: r.name }),
      onError: (e) => toast(patErrorText(normalizePatError(e)), "error"),
    });
  }

  // 永不过期 → 先弹强警示二次确认；其余直接签发。
  function handleCreate(input: CreatePatInput) {
    if (requiresNeverExpiryConfirm(input.expiresInDays)) setPendingNever(input);
    else doCreate(input);
  }

  function confirmRevoke() {
    const pat = pendingRevoke;
    if (!pat) return;
    revoke.mutate(pat.id, {
      onSuccess: () => {
        setPendingRevoke(null);
        toast("已吊销令牌", "success");
      },
      onError: (e) => {
        setPendingRevoke(null);
        toast(patErrorText(normalizePatError(e)), "error");
      },
    });
  }

  const items = listQ.data ?? [];

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <p className="text-gx-13 text-gx-text-tertiary">
        为 AI 客户端（本地脚本、桌面 AI 助手等）签发访问令牌。令牌代表你的身份，请按最小权限原则仅授予所需的权限范围。
      </p>

      <CreatePatForm onCreate={handleCreate} busy={create.isPending} />

      <div className="flex flex-col gap-2">
        <h3 className="text-gx-14 font-semibold text-gx-text-primary">已签发的令牌</h3>
        {listQ.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon="keyRound" title="还没有令牌" description="使用上方表单签发第一枚访问令牌。" />
        ) : (
          <div className="rounded-gx-lg border border-gx-border">
            <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
              <span className="flex-1">名称</span>
              <span className="w-40">前缀</span>
              <span className="w-56">权限范围</span>
              <span className="w-32">创建时间</span>
              <span className="w-32">最后使用</span>
              <span className="w-32">有效期</span>
              <span className="w-16 text-right">操作</span>
            </div>
            {items.map((p) => (
              <PatRow key={p.id} pat={p} onRevoke={setPendingRevoke} />
            ))}
          </div>
        )}
      </div>

      <PatTokenModal
        token={created?.token ?? null}
        name={created?.name}
        onClose={() => setCreated(null)}
      />

      <RevokeConfirmModal
        pat={pendingRevoke}
        busy={revoke.isPending}
        onClose={() => setPendingRevoke(null)}
        onConfirm={confirmRevoke}
      />

      <NeverExpiryConfirmModal
        open={!!pendingNever}
        busy={create.isPending}
        onClose={() => setPendingNever(null)}
        onConfirm={() => pendingNever && doCreate(pendingNever)}
      />
    </div>
  );
}
