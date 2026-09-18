// apps/web/src/features/settings/PersonalCenterDrawer.tsx
// 个人中心模块（Drawer 容器 + 4 Tab + 退出登录）
//
// 信息架构：
//   个人信息（profile）— displayName / email（只读）/ phone / bio
//   账号设置（account）— username（唯一）
//   密码修改（password）— currentPassword / newPassword / confirm
//   注销账号（danger）— 二次确认（输入"注销" + 当前密码）
//   底部 footer — 退出登录（始终在底部方便随时退出）
//
// 状态机：
//   每个 Tab 独立维护 dirty / saving / error / success，表单交互反馈即时。

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, toast } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { Form, FormActions, FormBanner, FormField, FormRow, FormSection } from "../../components/form";
import { useAuthStore } from "../../store/auth";
import {
  useUpdateMe,
  useChangePassword,
  useDeleteMe,
  useRemoveAvatar,
} from "../../api/hooks";
import type { UserDTO } from "@gx/shared-types";
import { withBase } from "../../api/client";
import { AVATAR_PALETTE } from "@gx/design-tokens";
import { ApiError } from "../../api/client";
import { authHeaders } from "../../api/authHeader";

type Tab = "profile" | "account" | "password" | "avatar" | "danger";

const TABS: { key: Tab; label: string; icon: IconName; danger?: boolean }[] = [
  { key: "profile", label: "个人信息", icon: "user" },
  { key: "account", label: "账号设置", icon: "settings" },
  { key: "password", label: "密码修改", icon: "lock" },
  { key: "avatar", label: "头像", icon: "image" },
  { key: "danger", label: "注销账号", icon: "alertCircle", danger: true },
];

// ============ 抽屉容器 ============

export function PersonalCenterDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("profile");

  // ESC 关闭 + 切 tab 时滚动条复位
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !user) return null;

  const onLogout = () => {
    logout();
    onClose();
    navigate("/login", { replace: true });
  };

  const onDeleted = () => {
    logout();
    onClose();
    navigate("/login", { replace: true });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="个人中心"
    >
      {/* 蒙版 */}
      <div
        className="absolute inset-0 bg-black/30 animate-pcdrawer-fade"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* 弹窗面板：居中、scale 入场 */}
      <div
        className="relative flex w-full max-w-[640px] max-h-[calc(100vh-64px)] flex-col rounded-gx-lg bg-gx-surface shadow-2xl animate-pcdialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gx-separator">
          <div className="flex items-center gap-2">
            <Icon name="user" size={16} className="text-gx-accent" />
            <span className="text-gx-15 font-medium text-gx-text-primary">个人中心</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-gx-lg text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary flex items-center justify-center"
            aria-label="关闭"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Body：左 Tab + 右内容 */}
        <div className="flex flex-1 min-h-0">
          <nav className="w-[160px] flex-shrink-0 border-r border-gx-separator bg-gx-bg py-3">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={
                  "flex w-full items-center gap-2 px-4 py-2 text-left text-gx-13 transition-colors " +
                  (tab === t.key
                    ? t.danger
                      ? "bg-gx-danger-bg text-gx-danger font-medium"
                      : "bg-gx-surface text-gx-accent font-medium border-l-[3px] border-gx-accent"
                    : t.danger
                      ? "text-gx-danger hover:bg-gx-danger-bg"
                      : "text-gx-text-secondary hover:bg-gx-surface")
                }
              >
                <Icon name={t.icon} size={14} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4">
            {tab === "profile" && <ProfileTab user={user} />}
            {tab === "account" && <AccountTab user={user} />}
            {tab === "password" && <PasswordTab onSuccess={onClose} />}
            {tab === "avatar" && <AvatarTab user={user} />}
            {tab === "danger" && <DangerTab onDeleted={onDeleted} />}
          </div>
        </div>

        {/* Footer：退出登录 */}
        <div className="border-t border-gx-separator px-5 py-3 bg-gx-bg flex items-center justify-between">
          <span className="text-gx-12 text-gx-text-tertiary truncate">
            {user.email}
          </span>
          <Button variant="ghost" size="sm" onClick={onLogout} icon="logout">
            退出登录
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============ 个人信息 Tab ============

function ProfileTab({ user }: { user: UserDTO }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [err, setErr] = useState<string | null>(null);
  const updateMe = useUpdateMe();
  // R-F-10 ①失焦即校验；③已报错字段在输入时实时消错（error 由当前值推导）
  const [nameTouched, setNameTouched] = useState(false);
  const nameError = nameTouched && !displayName.trim() ? "昵称不能为空" : null;
  const dirty =
    displayName !== user.displayName ||
    phone !== (user.phone ?? "") ||
    bio !== (user.bio ?? "");

  const onSave = async () => {
    setErr(null);
    if (!displayName.trim()) {
      setErr("昵称不能为空");
      return;
    }
    if (bio.length > 500) {
      setErr("个人简介不超过 500 字");
      return;
    }
    try {
      await updateMe.mutateAsync({
        displayName: displayName.trim(),
        phone: phone.trim() || null,
        bio: bio.trim() || null,
      });
      toast("个人信息已保存", "success");
    } catch (e) {
      const msg = e instanceof ApiError ? (e.body as { error?: string })?.error ?? "保存失败" : "保存失败";
      setErr(msg);
      toast(msg, "error");
    }
  };

  // 阶段 2：抽屉表单走统一骨架 —— 12 栅格 + gap 12 + 控件 34 + 错误行 16px 预留
  return (
    <Form variant="drawer" padding={false}>
      {/* R-F-13 无法归属到具体字段的服务端错误 → 表单顶部横幅 */}
      {err && <FormBanner message={err} onDismiss={() => setErr(null)} />}

      <FormSection title="基本信息" description="展示给他人的公开资料">
        <FormRow>
          <FormField label="昵称" required error={nameError} labelExtra={`${displayName.length}/60`}>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              maxLength={60}
              placeholder="显示名"
              disabled={updateMe.isPending}
            />
          </FormField>
        </FormRow>

        <FormRow>
          {/* R-D-11 只读字段：去边框去底色、用 readOnly 而非 disabled（disabled 无法选中复制） */}
          <FormField label="邮箱" help="登录账号，不可修改">
            <Input
              value={user.email}
              readOnly
              className="!border-transparent !bg-transparent !text-gx-text-tertiary"
            />
          </FormField>
        </FormRow>

        <FormRow>
          <FormField label="手机号" optional labelExtra={`${phone.length}/30`}>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={30}
              placeholder="例如 138 0000 0000"
              disabled={updateMe.isPending}
            />
          </FormField>
        </FormRow>

        <FormRow>
          <FormField
            label="个人简介"
            control="auto"
            optional
            labelExtra={`${bio.length}/500`}
            help="一句话介绍你自己"
          >
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={4}
              disabled={updateMe.isPending}
              placeholder="例如：负责产品需求池的梳理与排期"
              className="w-full rounded-gx-lg border border-gx-border bg-gx-bg px-3 py-2 text-gx-13 text-gx-text-primary outline-none focus:border-gx-accent focus:bg-gx-surface disabled:opacity-60 resize-none"
            />
          </FormField>
        </FormRow>

        <FormActions
          align="right"
          submitText="保存修改"
          onSubmit={onSave}
          submitting={updateMe.isPending}
          submitDisabled={!dirty}
          submitDisabledReason={!dirty ? "表单未改动" : undefined}
          onReset={() => {
            setDisplayName(user.displayName);
            setPhone(user.phone ?? "");
            setBio(user.bio ?? "");
            setNameTouched(false);
            setErr(null);
            toast("已恢复到修改前的内容", "info");
          }}
          resetEnabled={dirty}
        />
      </FormSection>
    </Form>
  );
}

// ============ 账号设置 Tab ============

function AccountTab({ user }: { user: UserDTO }) {
  const [username, setUsername] = useState(user.username ?? "");
  const [err, setErr] = useState<string | null>(null);
  const updateMe = useUpdateMe();
  // R-F-10 ①失焦即校验；③已报错字段在输入时实时消错
  const [touched, setTouched] = useState(false);
  const dirty = username !== (user.username ?? "");

  const validateUsername = (s: string): string | null => {
    if (!s.trim()) return "用户名不能为空";
    if (s.length < 3 || s.length > 24) return "用户名需 3-24 字符";
    if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "仅支持字母/数字/下划线/连字符";
    return null;
  };

  const onSave = async () => {
    setErr(null);
    const v = validateUsername(username);
    if (v) {
      setErr(v);
      return;
    }
    try {
      await updateMe.mutateAsync({ username: username.trim() });
      toast("用户名已更新", "success");
    } catch (e) {
      const msg = e instanceof ApiError ? (e.body as { error?: string })?.error ?? "保存失败" : "保存失败";
      setErr(msg);
      toast(msg, "error");
    }
  };

  return (
    <Form variant="drawer" padding={false}>
      {err && <FormBanner message={err} onDismiss={() => setErr(null)} />}

      <FormSection title="账号标识" description="唯一用户名，用于 @ 提及、URL 等">
        <FormRow>
          <FormField
            label="用户名"
            required
            error={touched ? validateUsername(username) : null}
            help="3-24 字符，仅字母/数字/_/-"
            labelExtra={`${username.length}/24`}
          >
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={24}
              placeholder="例如 alice_2026"
              disabled={updateMe.isPending}
            />
          </FormField>
        </FormRow>

        <FormActions
          align="right"
          submitText="保存修改"
          onSubmit={onSave}
          submitting={updateMe.isPending}
          submitDisabled={!dirty}
          submitDisabledReason={!dirty ? "表单未改动" : undefined}
          onReset={() => {
            setUsername(user.username ?? "");
            setTouched(false);
            setErr(null);
          }}
          resetEnabled={dirty}
        />
      </FormSection>

      <FormSection title="第三方账号" description="微信 / GitHub / Google 绑定（即将上线）">
        <FormRow>
          <FormField label="绑定状态" control="auto">
            <div className="rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-4 py-6 text-center text-gx-12 text-gx-text-tertiary">
              暂未开放，敬请期待
            </div>
          </FormField>
        </FormRow>
      </FormSection>
    </Form>
  );
}

// ============ 密码修改 Tab ============

function PasswordTab({ onSuccess }: { onSuccess: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cp = useChangePassword();

  // 密码强度（弱 1 / 中 2 / 强 3）
  const strength = useMemo(() => passwordStrength(next), [next]);
  const dirty = current.length > 0 || next.length > 0 || confirm.length > 0;
  // R-F-10 ①失焦即校验；③已报错字段在输入时实时消错（error 由当前值推导，输入即重算）
  const [touched, setTouched] = useState({ current: false, next: false, confirm: false });
  const currentError = touched.current && !current ? "请输入当前密码" : null;
  const nextError =
    touched.next && next.length > 0
      ? next.length < 8
        ? "新密码至少 8 位"
        : next.length > 72
          ? "新密码不超过 72 位"
          : null
      : null;
  const confirmError =
    touched.confirm && confirm.length > 0 && next !== confirm ? "两次输入的新密码不一致" : null;

  const onSave = async () => {
    setErr(null);
    if (!current) return setErr("请输入当前密码");
    if (next.length < 8) return setErr("新密码至少 8 位");
    if (next.length > 72) return setErr("新密码不超过 72 位");
    if (next !== confirm) return setErr("两次输入的新密码不一致");
    try {
      await cp.mutateAsync({ currentPassword: current, newPassword: next });
      toast("密码已修改", "success");
      setCurrent("");
      setNext("");
      setConfirm("");
      // 修改成功后关闭抽屉（用户通常不希望立即看到此页面）
      setTimeout(onSuccess, 600);
    } catch (e) {
      const msg = e instanceof ApiError ? (e.body as { error?: string })?.error ?? "修改失败" : "修改失败";
      setErr(msg);
    }
  };

  return (
    <Form variant="drawer" padding={false}>
      {err && <FormBanner message={err} onDismiss={() => setErr(null)} />}

      <FormSection title="修改密码" description="定期更换密码可提高账号安全">
        <FormRow>
          <FormField label="当前密码" required error={currentError}>
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              onBlur={() => setTouched((p) => ({ ...p, current: true }))}
              autoComplete="current-password"
              disabled={cp.isPending}
            />
          </FormField>
        </FormRow>

        <FormRow>
          <FormField
            label="新密码"
            required
            error={nextError}
            help="至少 8 位，建议字母+数字+符号混合"
          >
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              onBlur={() => setTouched((p) => ({ ...p, next: true }))}
              autoComplete="new-password"
              disabled={cp.isPending}
            />
            {next.length > 0 && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex flex-1 gap-1">
                  {[1, 2, 3].map((s) => (
                    <div
                      key={s}
                      className={
                        "h-1 flex-1 rounded-full " +
                        (strength >= s
                          ? s === 1
                            ? "bg-gx-danger"
                            : s === 2
                              ? "bg-gx-warning"
                              : "bg-gx-success"
                          : "bg-gx-bg")
                      }
                    />
                  ))}
                </div>
                <span className="text-gx-11 text-gx-text-tertiary">
                  {strength <= 1 ? "弱" : strength === 2 ? "中" : "强"}
                </span>
              </div>
            )}
          </FormField>
        </FormRow>

        <FormRow>
          <FormField label="确认新密码" required error={confirmError}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => setTouched((p) => ({ ...p, confirm: true }))}
              autoComplete="new-password"
              disabled={cp.isPending}
            />
          </FormField>
        </FormRow>

        <FormActions
          align="right"
          submitText="修改密码"
          onSubmit={onSave}
          submitting={cp.isPending}
          submitDisabled={!dirty}
          submitDisabledReason={!dirty ? "请先填写密码" : undefined}
          onReset={() => {
            setCurrent("");
            setNext("");
            setConfirm("");
            setTouched({ current: false, next: false, confirm: false });
            setErr(null);
          }}
          resetEnabled={dirty}
        />
      </FormSection>
    </Form>
  );
}

// ============ 头像 Tab ============

const AVATAR_ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_COMPRESS_THRESHOLD = 1024 * 1024; // 超过 1MB 才压缩

function AvatarTab({ user }: { user: UserDTO }) {
  const updateUser = useAuthStore((s) => s.updateUser);
  const removeAvatar = useRemoveAvatar();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null); // 本地预览 objectURL
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // preview 为 blob:（withBase 原样返回）；后端 avatarUrl 为 /uploads/... 根路径，子路径下需加 base 前缀。
  const displayAvatar = preview ?? (user.avatarUrl ? withBase(user.avatarUrl) : null);
  const initial = (user.displayName ?? user.email ?? "?").charAt(0).toUpperCase();

  const onSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset 允许重选同一文件
    if (!file) return;
    setErr(null);

    // 1) 类型校验
    if (!AVATAR_ALLOWED.includes(file.type)) {
      setErr("仅支持 JPG / PNG / WebP / GIF 格式");
      return;
    }
    // 2) 大小校验
    if (file.size > AVATAR_MAX_BYTES) {
      setErr("头像不能超过 5MB");
      return;
    }

    // 3) 本地预览
    const url = URL.createObjectURL(file);
    setPreview(url);

    // 4) 压缩（>1MB 压到 512px + 0.85）
    setBusy(true);
    setProgress(0);
    try {
      const blob = await compressImage(file);
      const res = await uploadAvatarXHR(blob, file.type, (p) => setProgress(p));
      updateUser(res.user);
      toast("头像已更新", "success");
      URL.revokeObjectURL(url);
      setPreview(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "上传失败";
      setErr(msg);
      toast(msg, "error");
      // 保留本地预览让用户看到选中的图，可重试
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const onRemove = async () => {
    setErr(null);
    try {
      const res = await removeAvatar.mutateAsync();
      updateUser(res.user);
      setPreview(null);
      toast("头像已移除", "success");
    } catch {
      setErr("移除失败，请重试");
    }
  };

  return (
    <Form variant="drawer" padding={false}>
      {err && <FormBanner message={err} onDismiss={() => setErr(null)} />}

      <FormSection title="头像" description="支持 JPG / PNG / WebP / GIF，最大 5MB">
        <FormRow>
          <FormField label="当前头像" control="auto">
            <div className="flex items-center gap-4">
              {displayAvatar ? (
                <img
                  src={displayAvatar}
                  alt="头像"
                  className="h-20 w-20 rounded-full border border-gx-border object-cover"
                />
              ) : (
                <span
                  className="flex h-20 w-20 items-center justify-center rounded-full text-gx-24 font-semibold text-white"
                  style={{ backgroundColor: avatarColor(user.displayName ?? user.email ?? "?") }}
                >
                  {initial}
                </span>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="upload"
                    loading={busy}
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    {busy ? "上传中..." : "上传新头像"}
                  </Button>
                  {user.avatarUrl && (
                    <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy || removeAvatar.isPending}>
                      移除
                    </Button>
                  )}
                </div>
                <p className="text-gx-11 text-gx-text-tertiary">
                  建议使用正方形图片；超过 1MB 将自动压缩
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={onSelect}
                disabled={busy}
              />
            </div>
          </FormField>
        </FormRow>

        {/* 上传进度条（R-D-28 长任务进度） */}
        {progress !== null && (
          <FormRow>
            <FormField label="上传进度" control="auto" labelExtra={`${progress}%`}>
              <div className="h-1.5 overflow-hidden rounded-full bg-gx-bg">
                <div
                  className="h-full rounded-full bg-gx-accent transition-all duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </FormField>
          </FormRow>
        )}
      </FormSection>
    </Form>
  );
}

// ============ 注销账号 Tab ============

function DangerTab({ onDeleted }: { onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const del = useDeleteMe();
  const ready = confirm === "注销" && password.length > 0;

  const onDelete = async () => {
    setErr(null);
    if (!ready) return;
    try {
      await del.mutateAsync({ password });
      toast("账号已注销", "success");
      onDeleted();
    } catch (e) {
      const msg = e instanceof ApiError ? (e.body as { error?: string })?.error ?? "注销失败" : "注销失败";
      setErr(msg);
    }
  };

  return (
    <Form variant="drawer" padding={false}>
      {err && <FormBanner message={err} onDismiss={() => setErr(null)} />}

      <FormSection title="危险操作">
        <FormRow>
          <FormField label="注销后果" control="auto">
            <div className="rounded-gx-lg border border-gx-danger/40 bg-gx-danger-bg px-4 py-3">
              <div className="flex items-center gap-2 text-gx-danger">
                <Icon name="alertCircle" size={14} />
                <span className="text-gx-13 font-medium">危险操作</span>
              </div>
              <p className="mt-1 text-gx-12 text-gx-text-secondary">
                注销账号将永久删除你的个人信息、评论以及你能被访问的链接，且无法恢复。
                如果你仍是某些 Base 的唯一 owner，请先转让 owner 再注销。
              </p>
            </div>
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection title="二次确认" description='请输入「注销」二字 + 当前密码'>
        <FormRow>
          <FormField label='输入"注销"以确认' required>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="注销"
              disabled={del.isPending}
            />
          </FormField>
        </FormRow>

        <FormRow>
          <FormField label="当前密码" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={del.isPending}
            />
          </FormField>
        </FormRow>

        {/* R-F-15 按钮区固定底部、右对齐；R-F-17 条件不满足时主按钮禁用并说明原因 */}
        <FormActions
          align="right"
          submitText="永久注销账号"
          onSubmit={onDelete}
          submitting={del.isPending}
          submitDisabled={!ready}
          submitDisabledReason={
            confirm !== "注销"
              ? '请先在上方输入「注销」二字'
              : password.length === 0
                ? "请输入当前密码"
                : undefined
          }
          danger
        />
      </FormSection>
    </Form>
  );
}

// ============ 共享小组件 ============

function passwordStrength(s: string): 0 | 1 | 2 | 3 {
  if (s.length === 0) return 0;
  let score = 0;
  if (s.length >= 8) score++;
  if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) score++;
  if (/[^A-Za-z0-9]/.test(s) && s.length >= 10) score++;
  return score as 0 | 1 | 2 | 3;
}

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

/** 头像压缩：超过阈值时缩到最长边 512px + JPEG quality 0.85（保留 PNG 透明则按原格式） */
async function compressImage(file: File): Promise<Blob> {
  if (file.size < AVATAR_COMPRESS_THRESHOLD) return file;
  try {
    const img = await loadImage(URL.createObjectURL(file));
    const MAX = 512;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), file.type === "image/png" ? "image/png" : "image/jpeg", 0.85),
    );
    return blob ?? file;
  } catch {
    // 压缩失败则原样上传
    return file;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** XHR 上传头像（带进度回调），成功返回 { user } */
function uploadAvatarXHR(
  blob: Blob,
  mimeType: string,
  onProgress: (percent: number) => void,
): Promise<{ user: UserDTO }> {
  const token = useAuthStore.getState().token;
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] ?? "jpg";
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", withBase("/api/auth/me/avatar"));
    // 飞牛 CGI 网关会把 Authorization 当自家令牌校验并吞掉请求，故统一用 X-GX-Token。
    for (const [k, v] of Object.entries(authHeaders(token))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(json);
        else reject(new Error(json?.error ?? "上传失败"));
      } catch {
        reject(new Error("上传响应解析失败"));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误，请重试"));
    const fd = new FormData();
    fd.append("file", blob, `avatar.${ext}`);
    xhr.send(fd);
  });
}