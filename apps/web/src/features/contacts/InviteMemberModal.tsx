// M2/S7 添加成员弹窗：两种方式——邀请（建 INVITED 账号，一次性返回激活链接+复制）/直接创建 ACTIVE 账号。
import { useRef, useState } from "react";
import { Button, Input, Modal, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { buildInviteLink } from "../../api/client";
import { useOrgMemberMutations } from "./contacts-hooks";
import { errText } from "./contacts-ui";
import { COPY_FAIL_HINT_LINK, copyText } from "../../lib/clipboard";

type Mode = "invite" | "create";

export function InviteMemberModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useOrgMemberMutations();
  const [mode, setMode] = useState<Mode>("invite");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  // 邀请成功后的一次性结果（明文链接仅本次展示）
  const [inviteResult, setInviteResult] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // 复制失败时用于自动选中激活链接文本，让用户可直接按 Ctrl/⌘ + C。
  const urlInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setEmail("");
    setDisplayName("");
    setPassword("");
    setInviteResult(null);
    setCopied(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function submitInvite() {
    try {
      const res = await m.invite.mutateAsync({ email: email.trim(), displayName: displayName.trim() });
      setInviteResult({ email: res.email, url: buildInviteLink(res.inviteToken) });
      toast("已创建待激活账号", "success");
    } catch (e) {
      toast(errText(e, "邀请失败"), "error");
    }
  }

  async function submitCreate() {
    try {
      await m.create.mutateAsync({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
      });
      toast("已创建账号", "success");
      close();
    } catch (e) {
      toast(errText(e, "创建失败"), "error");
    }
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameOk = displayName.trim().length > 0 && displayName.trim().length <= 60;
  const pwOk = password.length >= 8 && password.length <= 72;

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加成员"
      width={480}
      footer={
        inviteResult ? (
          <Button variant="primary" onClick={close}>完成</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>取消</Button>
            {mode === "invite" ? (
              <Button variant="primary" disabled={!emailOk || !nameOk} loading={m.invite.isPending} onClick={submitInvite}>
                生成邀请链接
              </Button>
            ) : (
              <Button variant="primary" disabled={!emailOk || !nameOk || !pwOk} loading={m.create.isPending} onClick={submitCreate}>
                创建账号
              </Button>
            )}
          </>
        )
      }
    >
      {inviteResult ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-gx-lg bg-gx-success-bg px-3 py-2 text-gx-13 text-gx-success">
            <Icon name="check" size={15} />
            <span>已为 {inviteResult.email} 创建待激活账号</span>
          </div>
          <p className="text-gx-12 text-gx-text-tertiary">
            把下面的激活链接发给对方，打开后设置密码即可激活。该链接为一次性，离开此窗口后无法再次查看。
          </p>
          <div className="flex items-center gap-2">
            <Input ref={urlInputRef} readOnly value={inviteResult.url} className="flex-1" onFocus={(e) => e.target.select()} />
            <Button
              variant="secondary"
              icon={copied ? "check" : "copy"}
              onClick={async () => {
                if (await copyText(inviteResult.url)) {
                  setCopied(true);
                  toast("链接已复制", "success");
                  return;
                }
                toast(COPY_FAIL_HINT_LINK, "error");
                urlInputRef.current?.focus();
                urlInputRef.current?.select();
              }}
            >
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="inline-flex w-fit rounded-gx-lg border border-gx-border bg-gx-surface p-0.5">
            {([
              { v: "invite" as Mode, label: "邀请加入" },
              { v: "create" as Mode, label: "直接创建账号" },
            ]).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setMode(o.v)}
                className={`rounded-gx-sm px-3 py-1 text-gx-12 font-medium transition-colors ${
                  mode === o.v ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-tertiary hover:bg-gx-bg"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-gx-12 font-medium text-gx-text-secondary">邮箱</span>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-gx-12 font-medium text-gx-text-secondary">姓名</span>
            <Input value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} placeholder="成员的显示名称" />
          </label>

          {mode === "create" ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-gx-12 font-medium text-gx-text-secondary">初始密码</span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，不超过 72 位" autoComplete="new-password" />
              {!pwOk && password.length > 0 && (
                <span className="text-gx-11 text-gx-text-hint">密码需 8–72 位</span>
              )}
            </label>
          ) : (
            <p className="rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-tertiary">
              邀请方式先创建「待激活」账号并生成一次性激活链接，对方自行设置密码，无需在此填写密码。
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
