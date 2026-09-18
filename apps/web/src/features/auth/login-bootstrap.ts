// apps/web/src/features/auth/login-bootstrap.ts
// 登录页「首运行创建超级管理员」的判定与表单校验（纯逻辑 + 初始化状态探针）。
// 判定/校验与 React 解耦，是为了能在 node 环境直接单测，不依赖 DOM 与真实后端。

import { useQuery } from "@tanstack/react-query";
import { fetchBootstrapStatus, type BootstrapStatus } from "../../api/client";

/** 登录页呈现形态 */
export interface LoginEntry {
  /** true = 空库首运行：渲染「创建超级管理员」引导，不出现登录/注册 tab。 */
  bootstrap: boolean;
  /** 常规形态下注册 tab 是否可见（后端 signupOpen=false 时隐藏）。 */
  signupVisible: boolean;
}

/** 探针未完成或失败时的形态：维持现状（登录 + 注册），不把用户卡在错误页。 */
export const DEGRADED_LOGIN_ENTRY: LoginEntry = { bootstrap: false, signupVisible: true };

/** 空库首运行形态：只给创建超级管理员一条路（注册 tab 无意义，首个注册者即 owner）。 */
const BOOTSTRAP_LOGIN_ENTRY: LoginEntry = { bootstrap: true, signupVisible: false };

/**
 * 由初始化状态推导登录页形态。
 * status 为 null/undefined 表示「加载中或探针失败」——此时一律降级为现状，
 * 因为把用户锁在一个加载失败页上的代价远大于多显示一个注册 tab。
 */
export function resolveLoginEntry(status: BootstrapStatus | null | undefined): LoginEntry {
  if (!status) return DEGRADED_LOGIN_ENTRY;
  if (status.initialized === false) return BOOTSTRAP_LOGIN_ENTRY;
  // signupOpen 缺失（老后端/字段未下发）时按开放处理，避免误关注册入口。
  return { bootstrap: false, signupVisible: status.signupOpen !== false };
}

/** 引导表单原始输入（确认密码只在前端存在，不发给后端） */
export interface BootstrapFormInput {
  email: string;
  displayName: string;
  password: string;
  confirmPassword: string;
}

/**
 * 引导表单本地校验，返回首条错误文案（null = 通过）。
 * 规则与后端 signupSchema 对齐（email 格式、password ≥ 8、displayName 非空），
 * 不发明额外强度规则；确认密码一致是纯前端补充。
 */
export function validateBootstrapForm(input: BootstrapFormInput): string | null {
  const email = input.email.trim();
  if (!email) return "请输入邮箱";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "邮箱格式不正确";
  if (!input.displayName.trim()) return "请输入昵称";
  if (!input.password) return "请输入密码";
  if (input.password.length < 8) return "密码至少 8 位";
  if (input.password !== input.confirmPassword) return "两次输入的密码不一致";
  return null;
}

/** 引导创建失败的状态码 → 中文文案（后端原始串多为英文，不外抛） */
const BOOTSTRAP_ERROR_TEXT: Record<number, string> = {
  400: "输入有误：请检查邮箱格式，密码至少 8 位",
  401: "创建失败：账号状态异常，请重试",
  403: "注册入口已关闭，请联系管理员",
  409: "该邮箱已被注册，请更换邮箱或直接登录",
  429: "操作过于频繁，请稍后再试",
};

/** 把 ApiError / 网络异常收敛成一句可执行的中文提示。 */
export function friendlyBootstrapError(err: unknown): string {
  const status =
    typeof (err as { status?: unknown } | null)?.status === "number"
      ? (err as { status: number }).status
      : 0;
  if (status === 0) return "网络异常，请检查服务是否已启动";
  if (status >= 500) return "服务端异常，请稍后重试";
  return BOOTSTRAP_ERROR_TEXT[status] ?? "创建超级管理员失败，请稍后重试";
}

/** 初始化状态探针的缓存键（单测据此预置数据） */
export const BOOTSTRAP_STATUS_QK = ["auth", "bootstrap-status"] as const;

/**
 * 拉初始化状态；失败只告警并返回 null（调用方据此降级），不向上抛。
 * 探针是增强而非必经路径：它挂了也必须能正常登录。
 */
export async function loadBootstrapStatus(): Promise<BootstrapStatus | null> {
  try {
    return await fetchBootstrapStatus();
  } catch (err) {
    console.warn("[auth] bootstrap-status 查询失败，登录页降级为常规登录/注册", err);
    return null;
  }
}

/** 登录页挂载时读一次初始化状态；未拿到数据（加载中/失败）返回 null。 */
export function useBootstrapStatus(): BootstrapStatus | null {
  const { data } = useQuery({
    queryKey: BOOTSTRAP_STATUS_QK,
    queryFn: loadBootstrapStatus,
    // 探针失败就是失败，重试只会在空库场景下延迟引导出现
    retry: false,
    // 每次挂载都重新探测：刚创建完超管再登出时，不能拿「initialized=false」的旧缓存
    // 把人又推回引导页（此时再注册会被后端 409 挡下）。
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}
