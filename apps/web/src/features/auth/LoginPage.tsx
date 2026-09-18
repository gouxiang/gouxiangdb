// apps/web/src/features/auth/LoginPage.tsx
// 登录 / 注册页（v1 NocoDB 风格 Web 移植）
// 遵循 web-conventions：只走 hooks/client，颜色全部用 gx-* token

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Auth } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { Button, Input, SegmentedControl, toast } from "../../components/ui";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    // 自定义字段校验（原生 required 之外的额外规则）
    if (!email.trim()) return toast("请输入邮箱", "error");
    if (!password) return toast("请输入密码", "error");
    if (mode === "signup") {
      if (password.length < 8) return toast("密码至少 8 位", "error");
      if (!displayName.trim()) return toast("请输入昵称", "error");
    }

    setBusy(true);
    try {
      const res =
        mode === "signup"
          ? await Auth.signup({ email: email.trim(), password, displayName: displayName.trim() })
          : await Auth.login({ email: email.trim(), password });
      setAuth(res.token, res.user);
      navigate("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "操作失败";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gx-bg px-4">
      <div className="w-[360px] rounded-gx-xl bg-gx-surface p-6 shadow-lg">
        {/* 品牌区 */}
        <div className="mb-5 text-center">
          <div className="text-gx-18 font-semibold text-gx-text-primary">构想工作台</div>
          <div className="mt-1 text-gx-12 text-gx-text-hint">智能表格 · 前后端分离重写</div>
        </div>

        <div className="mb-4 flex justify-center">
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "login", label: "登录" },
              { value: "signup", label: "注册" },
            ]}
          />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <Input
              placeholder="昵称"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
          )}
          <Input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <Input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />

          <Button type="submit" variant="primary" block loading={busy}>
            {mode === "signup" ? "创建并登录" : "登录"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="mt-3 w-full text-center text-gx-12 text-gx-text-tertiary hover:text-gx-accent"
        >
          {mode === "signup" ? "已有账号？去登录" : "没有账号？去注册"}
        </button>
      </div>
    </div>
  );
}
