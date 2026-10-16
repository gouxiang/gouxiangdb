// apps/web/src/node/nodeMessages.ts
// 启动器「添加/连接远端节点」各失败分类 → 面向用户的确定中文文案（主设计 §7.3 fail-closed）。
//
// 单一事实源：UI 各处（欢迎页/添加节点表单/悬浮气泡/401 回流）都从这里取文案，
// 避免同一错误在不同界面说法不一。detail（状态码/原始版本号）仅供调试日志，不直接展示。
// 纯字符串映射，node 环境可直接单测。

import type { HandshakeErrorCode, LoginErrorCode } from "./handshake";

/** 握手（探活/能力）失败文案，严格对齐主设计 §7.3 表格。 */
export function handshakeErrorMessage(code: HandshakeErrorCode): string {
  switch (code) {
    case "unreachable":
      return "无法连接到该节点，请检查网址与网络后重试";
    case "not_a_node":
      return "该地址不是可用的构想工作台节点";
    case "version_incompatible":
      return "节点版本不受支持，请联系节点管理员升级";
    case "not_initialized":
      return "该节点尚未完成初始化，请先在节点本机创建管理员";
    case "bad_response":
      return "该节点返回了无法识别的响应，请确认地址无误或联系节点管理员";
    default:
      return "无法连接到该节点，请检查网址与网络后重试";
  }
}

/** 账号登录环节失败文案。 */
export function loginErrorMessage(code: LoginErrorCode): string {
  switch (code) {
    case "unreachable":
      return "无法连接到该节点，请检查网络后重试";
    case "invalid_credentials":
      return "邮箱或密码错误";
    case "signup_closed":
      return "该节点已关闭访问，请联系节点管理员";
    case "must_change_password":
      return "该账号需要先修改密码，请按节点引导完成改密";
    case "error":
    default:
      return "登录失败，请稍后重试";
  }
}

/** 表单本地校验 / 注册表查重失败（请求都还没发出）。 */
export type AddNodeFormErrorCode =
  | "invalid_url" // 网址规范化失败（空/含空格/非法 host/非 http(s)）
  | "duplicate" // 同规范化基址的远端节点已在注册表
  | "missing_credentials" // 需要登录但没给账号或密码
  | "label_invalid"; // 可选显示名非法（空白串等）

export function formErrorMessage(code: AddNodeFormErrorCode): string {
  switch (code) {
    case "invalid_url":
      return "请输入有效的节点网址，例如 http://192.168.1.5:3001";
    case "duplicate":
      return "该节点已在列表中，直接连接即可";
    case "missing_credentials":
      return "请输入该节点的账号和密码";
    case "label_invalid":
    default:
      return "节点名称无效";
  }
}

/** 连接流程的统一失败分类（供编排器/UI 一处收口）。 */
export type AddNodeErrorKind =
  | { stage: "form"; code: AddNodeFormErrorCode }
  | { stage: "handshake"; code: HandshakeErrorCode }
  | { stage: "login"; code: LoginErrorCode };

/** 由统一分类取最终展示文案。 */
export function addNodeErrorMessage(kind: AddNodeErrorKind): string {
  if (kind.stage === "form") return formErrorMessage(kind.code);
  if (kind.stage === "handshake") return handshakeErrorMessage(kind.code);
  return loginErrorMessage(kind.code);
}
