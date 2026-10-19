// apps/web/src/features/auth/LoginPage.tsx
// 登录 / 注册页（v1 NocoDB 风格 Web 移植），空库首运行时切为「创建超级管理员」引导。
//
// #753 双栏改版：桌面（≥768）居中卡片左广告右表单；<768 单栏只显示表单。
// 左栏产品名/广告图/版权全部走品牌配置 hook（features/branding），本页不写死任何品牌字面量。
// 遵循 web-conventions：只走 hooks/client，颜色全部用 gx-* token。

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Auth } from "../../api/client";
import { takeSessionFrom } from "../../lib/session-from";
import { useAuthStore } from "../../store/auth";
import { commitLoginForActiveSource } from "../../node/activeAuth";
import { Button, Input, SegmentedControl, toast } from "../../components/ui";
import { SessionExpiredNotice } from "../../components/states";
import {
  friendlyBootstrapError,
  resolveLoginEntry,
  useBootstrapStatus,
  validateBootstrapForm,
} from "./login-bootstrap";
import { LoginBrandPanel } from "./LoginBrandPanel";
import { PasswordInput } from "./PasswordInput";

/** 左栏标语：具体卖点（README 首行产品定义），不写模板口号 */
const SLOGAN = "智能表格、知识库与画布一体化，数据全部保存在你自己的服务器上。";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const bootstrapStatus = useBootstrapStatus();
  const entry = resolveLoginEntry(bootstrapStatus);

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // R-D-17 会话过期（401）：读到「来路」说明是被拦过来的，登录后回原页并给出说明横幅
  const [sessionFrom] = useState(() => takeSessionFrom());

  // 注册入口关闭时把可能的 signup 态夹回 login，避免停在已隐藏的 tab 上
  const activeMode: "login" | "signup" = entry.signupVisible ? mode : "login";

  /** 创建超级管理员：走现有 signup（后端把首位注册者自举为 owner），成功后同样自动登录 */
  async function submitBootstrap() {
    const input = { email, displayName, password, confirmPassword };
    const invalid = validateBootstrapForm(input);
    if (invalid) return toast(invalid, "error");

    setBusy(true);
    try {
      const res = await Auth.signup({
        email: input.email.trim(),
        password,
        displayName: input.displayName.trim(),
      });
      // 首管理员引导只可能针对**本地**节点：瘦客户端不承接远端空库自举（远端 not_initialized
      // 在选路/探活阶段即 fail-closed）。故此处恒定写本地 gx-auth，不走活动源分槽出口。
      setAuth(res.token, res.user);
      // 首登强制改密（mustChangePassword=true）时闸门会挡住除白名单外的全部 /api，必须先去改密页
      navigate(res.user.mustChangePassword === true ? "/change-password" : "/");
    } catch (err) {
      toast(friendlyBootstrapError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    if (entry.bootstrap) return void submitBootstrap();

    // 自定义字段校验（原生 required 之外的额外规则）
    if (!email.trim()) return toast("请输入邮箱", "error");
    if (!password) return toast("请输入密码", "error");
    if (activeMode === "signup") {
      if (password.length < 8) return toast("密码至少 8 位", "error");
      if (!displayName.trim()) return toast("请输入昵称", "error");
    }

    setBusy(true);
    try {
      const res =
        activeMode === "signup"
          ? await Auth.signup({
              email: email.trim(),
              password,
              displayName: displayName.trim(),
            })
          : await Auth.login({ email: email.trim(), password });
      // 分槽出口：活动源是远端节点（桌面壳 remote-empty 选路态）时，token/user 落该远端节点的
      // 会话分键（gx-node-session:<nodeId>），控制器随即重推带 token 的数据源；本地源/门控关
      // （浏览器、fnOS、服务器）返回 false，照旧写 gx-auth，现网行为逐字节不变。
      if (!commitLoginForActiveSource(res.token, res.user)) {
        setAuth(res.token, res.user);
      }
      // 初始超级管理员（mustChangePassword=true）登录后闸门会挡住除白名单外的全部 /api，
      // 必须先去改密页，否则进来就是一片空白。
      // R-D-17：会话过期被拦到登录页时，登录后回到原页（来路由 client.ts 在 401 时记下）
      if (res.user.mustChangePassword === true) navigate("/change-password");
      else navigate(sessionFrom ?? "/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "操作失败";
      // 后端 401 的原文是英文（auth.ts「Invalid credentials」），直接透出会中英混排；
      // 这里翻译成用户能读懂的提示，其余错误仍按原文展示。
      toast(
        /Invalid credentials/i.test(msg) ? "邮箱或密码不正确" : msg,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    // 窄屏（单栏）顶部对齐，避免短卡片浮在屏幕中段留下大段空白；桌面双栏垂直居中
    <div className="flex min-h-screen items-start justify-center bg-gx-bg px-4 py-10 md:items-center">
      <div className="grid w-full max-w-[840px] overflow-hidden rounded-gx-xl bg-gx-surface shadow-gx-lg md:grid-cols-2">
        {/* 左栏：品牌广告区，<768 整栏隐藏（单栏只留表单） */}
        <LoginBrandPanel slogan={SLOGAN} />

        {/* 右栏：表单区。三种形态（引导 / 登录注册 / 降级纯登录）共用同一外壳 */}
        <div className="flex flex-col justify-center p-6 sm:p-8">
          <div className="mx-auto w-full max-w-[340px]">
            {/* R-D-17 会话过期：说明「为什么在这里」+ 登录后回原页。正常访问登录页时不渲染。 */}
            {sessionFrom && !entry.bootstrap && (
              <div className="mb-4">
                <SessionExpiredNotice />
              </div>
            )}

            {entry.bootstrap ? (
              <>
                <div className="mb-1 text-gx-18 font-semibold text-gx-text-primary">
                  初始化工作台
                </div>
                <div className="mb-4 text-gx-12 text-gx-text-hint">
                  创建超级管理员
                </div>
                <div className="mb-4 rounded-gx-lg bg-gx-accent-bg px-3 py-2 text-gx-12 leading-5 text-gx-text-secondary">
                  当前工作区还没有任何账号。请创建第一个账号，它将自动成为超级管理员并拥有工作区全部权限。
                </div>

                <form onSubmit={submit} className="flex flex-col gap-3">
                  <Input
                    placeholder="昵称"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="nickname"
                  />
                  <Input
                    type="email"
                    placeholder="邮箱"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                  <PasswordInput
                    placeholder="密码（至少 8 位）"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                  <PasswordInput
                    placeholder="确认密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />

                  <Button type="submit" variant="primary" block loading={busy}>
                    创建超级管理员并进入
                  </Button>
                </form>

                <div className="mt-3 text-gx-11 leading-5 text-gx-text-hint">
                  创建后请妥善保存密码；后续可在「账号设置」中修改。
                </div>
              </>
            ) : (
              <>
                <div className="mb-1 text-gx-18 font-semibold text-gx-text-primary">
                  {activeMode === "signup" ? "创建账号" : "欢迎登录"}
                </div>
                <div className="mb-4 text-gx-12 text-gx-text-hint">
                  {activeMode === "signup"
                    ? "注册后由管理员分配工作区权限"
                    : "登录后进入你的工作台"}
                </div>

                {entry.signupVisible && (
                  <div className="mb-4">
                    <SegmentedControl
                      value={activeMode}
                      onChange={(v) => setMode(v)}
                      options={[
                        { value: "login", label: "登录" },
                        { value: "signup", label: "注册" },
                      ]}
                    />
                  </div>
                )}

                <form onSubmit={submit} className="flex flex-col gap-3">
                  {activeMode === "signup" && (
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
                  <PasswordInput
                    placeholder="密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete={
                      activeMode === "signup"
                        ? "new-password"
                        : "current-password"
                    }
                  />

                  <Button type="submit" variant="primary" block loading={busy}>
                    {activeMode === "signup" ? "创建并登录" : "登录"}
                  </Button>
                </form>

                {entry.signupVisible && (
                  <button
                    type="button"
                    onClick={() =>
                      setMode(activeMode === "login" ? "signup" : "login")
                    }
                    className="mt-3 w-full text-center text-gx-12 text-gx-text-tertiary transition-colors duration-[120ms] hover:text-gx-accent"
                  >
                    {activeMode === "signup"
                      ? "已有账号？去登录"
                      : "没有账号？去注册"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
