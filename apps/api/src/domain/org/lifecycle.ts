// M2 账号生命周期状态机（计划 §5-D）。
// S4：接受邀请（INVITED -> ACTIVE，一次性激活码，发带 tv JWT）。
// S6：disableUser / reactivateUser / assertNotLastOwner（本文件在 S6 扩充）。

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { HttpError } from "../../guards.js";
import { withWriteTx } from "../../db.js";
import { USER_STATUS, issueToken } from "./authState.js";

/** 激活码明文 -> sha256 摘要（与建邀请时同一算法）。 */
export function hashInviteToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

export interface AcceptInviteResult {
  token: string;
  user: { id: string; email: string; displayName: string; status: string };
}

/**
 * 接受邀请：公开端点（不要求登录）。
 * 成功 -> ACTIVE、设置密码/可选昵称、清空 inviteTokenHash（一次性）、签发带 tv JWT。
 * 失败 -> 404（token 无效或已被使用：摘要已清空无法再命中，统一 404 避免账号枚举）。
 */
export async function acceptInvite(input: {
  token: unknown;
  password: unknown;
  displayName?: unknown;
}): Promise<AcceptInviteResult> {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (token.length === 0) throw new HttpError(400, "缺少激活令牌");
  if (password.length < 8 || password.length > 72) {
    throw new HttpError(400, "密码至少 8 位、不超过 72 位");
  }
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim() !== ""
      ? input.displayName.trim().slice(0, 60)
      : null;

  const hash = hashInviteToken(token);
  return withWriteTx("org.member.acceptInvite", async (tx) => {
    const user = await tx.user.findFirst({ where: { inviteTokenHash: hash } });
    // 无匹配：token 错误或已使用（成功激活时已清空 hash）。统一 404。
    if (!user) throw new HttpError(404, "激活链接无效或已被使用");
    if (user.status !== USER_STATUS.INVITED) {
      // 防御：非 INVITED 却仍挂着 hash 的异常态不允许经此路径改密。
      throw new HttpError(409, "账号已激活，无法重复使用邀请链接");
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        status: USER_STATUS.ACTIVE,
        passwordHash,
        inviteTokenHash: null,
        ...(displayName ? { displayName } : {}),
      },
    });
    const jwt = await issueToken(updated.id, updated.tokenVersion);
    return {
      token: jwt,
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        status: updated.status,
      },
    };
  });
}
