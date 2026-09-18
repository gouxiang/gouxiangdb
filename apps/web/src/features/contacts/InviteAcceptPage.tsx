// M2/S7 公开邀请接受页 /invite/:token：登录前凭一次性激活码设置密码、激活账号并登录。
// 不挂 AppShell/登录守卫；激活成功写入 auth store 后跳工作台。
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { acceptOrgInvite, ApiError } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { Button, Input } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { UserDTO } from "@gx/shared-types";

export default function InviteAcceptPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== password2) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await acceptOrgInvite({
        token,
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      // 激活返回的 user 是 UserDTO 的安全子集；补齐本地展示所需的可空字段（进入应用后 useMe 会回拉全量）。
      const now = new Date().toISOString();
      const user: UserDTO = {
        id: res.user.id,
        email: res.user.email,
        displayName: res.user.displayName,
        username: res.user.displayName,
        phone: null,
        avatarUrl: null,
        bio: null,
        createdAt: now,
        updatedAt: null,
      };
      setAuth(res.token, user);
      setDone(true);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.body?.error ?? "激活失败");
      } else {
        setError("网络错误，请稍后重试");
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gx-bg px-4">
      <div className="w-full max-w-sm rounded-gx-xl border border-gx-separator bg-gx-surface p-6 shadow-lg">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-gx-lg bg-gx-accent-bg text-gx-accent">
            <Icon name="keyRound" size={18} />
          </span>
          <div>
            <div className="text-gx-16 font-semibold text-gx-text-primary">接受邀请</div>
            <div className="text-gx-12 text-gx-text-tertiary">设置密码以激活你的工作区账号</div>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-gx-12 font-medium text-gx-text-secondary">姓名（可选）</span>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="你的称呼"
              autoComplete="name"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-gx-12 font-medium text-gx-text-secondary">登录密码</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-gx-12 font-medium text-gx-text-secondary">确认密码</span>
            <Input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </label>

          {error && (
            <div className="flex items-center gap-1.5 rounded-gx-sm bg-gx-danger-bg px-2.5 py-1.5 text-gx-12 text-gx-danger" role="alert">
              <Icon name="alertCircle" size={13} />
              <span>{error}</span>
            </div>
          )}
          {done && (
            <div className="rounded-gx-sm bg-gx-success-bg px-2.5 py-1.5 text-gx-12 text-gx-success">
              激活成功，正在进入工作区…
            </div>
          )}

          <Button type="submit" variant="primary" block loading={submitting} className="mt-1">
            激活并登录
          </Button>
        </form>
      </div>
    </div>
  );
}
