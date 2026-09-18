// apps/web/src/features/auth/ForceChangePassword.tsx
// 首次登录强制改密页
//
// 部署时由 init-admin 脚本创建的超级管理员带 mustChangePassword=true，后端闸门会把
// 白名单外的 /api/** 全部挡成 403 PASSWORD_CHANGE_REQUIRED（apps/api/src/middleware/
// mustChangePassword.ts），不先改密就会卡在空页面。本页是唯一出口：改密成功后把最新
// user 写回 auth store（mustChangePassword 回落 false），再进主界面，守卫才不会把人挡回来。
//
// 纪律：只走 api/client + store/auth，颜色/间距一律 gx-* token，结果反馈走 toast。
// 没有跳过/返回/稍后再说入口——改完才放人。

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Auth, ApiError } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { Button, Input, toast } from "../../components/ui";

/**
 * 本地校验（与后端 zod 的 8~72 对齐，apps/api/src/auth.ts:150-153）。
 * 抽成纯函数只为可单测；返回 null 表示通过，否则返回要 toast 的文案。
 */
export function validateNewPassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): string | null {
  if (!currentPassword) return "请输入当前密码";
  if (!newPassword) return "请输入新密码";
  if (newPassword.length < 8) return "新密码至少 8 位";
  if (newPassword.length > 72) return "新密码不超过 72 位";
  if (newPassword !== confirmPassword) return "两次输入的新密码不一致";
  return null;
}

export default function ForceChangePassword() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const updateUser = useAuthStore((s) => s.updateUser);
  const qc = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    // 自定义校验（原生 required 之外的规则）
    const invalid = validateNewPassword(currentPassword, newPassword, confirmPassword);
    if (invalid) return toast(invalid, "error");

    setBusy(true);
    try {
      await Auth.changePassword({ currentPassword, newPassword });
      // 改密成功后后端已把 mustChangePassword 置 false（auth.ts 与 passwordHash 同一次写），
      // 这里拉一次最新 user 写回 store，否则 App 里的守卫会立刻把人挡回本页形成死循环。
      try {
        const { user } = await Auth.me();
        setAuth(useAuthStore.getState().token ?? "", user);
      } catch {
        // GET /api/auth/me 在闸门白名单内，正常不会失败。万一网络抖动，按「改密已成功」
        // 这个事实在本地清标记，避免把用户永久卡在本页出不去。
        updateUser({ mustChangePassword: false });
      }
      qc.invalidateQueries({ queryKey: ["me"] });
      toast("密码已修改，正在进入工作台", "success");
      navigate("/");
    } catch (err) {
      // 后端错误文案在 ApiError.body.error（如当前密码填错 → 401「当前密码错误」）；
      // 直接读 err.message 会拿到 "API 401: ..." 这种带前缀的串。与
      // PersonalCenterDrawer 的改密分支（settings/PersonalCenterDrawer.tsx:348）同一模式。
      const msg =
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? "修改密码失败")
          : "修改密码失败";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gx-bg px-4">
      <div className="w-[360px] rounded-gx-xl bg-gx-surface p-6 shadow-lg">
        {/* 品牌区：与登录页一致 */}
        <div className="mb-5 text-center">
          <div className="text-gx-18 font-semibold text-gx-text-primary">构想工作台</div>
          <div className="mt-1 text-gx-12 text-gx-text-hint">智能表格 · 前后端分离重写</div>
        </div>

        {/* 为什么必须改 */}
        <div className="mb-4 rounded-gx-md bg-gx-warning-bg px-3 py-2 text-gx-12 text-gx-text-secondary">
          <div className="mb-1 font-medium text-gx-text-primary">请先修改初始密码</div>
          <div>
            当前使用的是系统生成的初始密码，出于安全需要必须先修改，修改完成后才能使用其它功能。
          </div>
          <div className="mt-1 text-gx-text-hint">新密码至少 8 位，最多 72 位。</div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            type="password"
            placeholder="当前密码（初始密码）"
            aria-label="当前密码"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          <Input
            type="password"
            placeholder="新密码"
            aria-label="新密码"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
          <Input
            type="password"
            placeholder="确认新密码"
            aria-label="确认新密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
          />

          <Button type="submit" variant="primary" block loading={busy}>
            修改密码并进入
          </Button>
        </form>
      </div>
    </div>
  );
}
