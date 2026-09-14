// 公共用户字段投影：剥离 passwordHash，前端可直接使用。
// auth.ts（/me、signup、login）与 meAvatar 路由共用，避免字段集合分叉。

import type { User } from "@prisma/client";

type PublicUserSource = Pick<
  User,
  "id" | "email" | "displayName" | "username" | "phone" |
  "avatarUrl" | "bio" | "createdAt" | "updatedAt"
>;

export function publicUser(u: PublicUserSource) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    username: u.username,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt?.toISOString() ?? null,
  };
}
