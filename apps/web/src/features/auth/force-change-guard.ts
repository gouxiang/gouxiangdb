// apps/web/src/features/auth/force-change-guard.ts
// 首次登录强制改密：路由常量 + 守卫判定（纯逻辑，可单测）
//
// 背景：部署时 init-admin 建的超级管理员带 mustChangePassword=true，后端闸门会把白名单
// 外的 /api/** 全挡成 403 PASSWORD_CHANGE_REQUIRED（apps/api/src/middleware/
// mustChangePassword.ts）。前端必须在登录后把人按到改密页，否则所有页面拿不到数据、卡空白。

/**
 * 强制改密页路径。子路径部署时 BrowserRouter 的 basename 由 main.tsx 按
 * import.meta.env.BASE_URL 注入，应用内一律写根绝对路径（与 /login 等既有路由一致）；
 * useLocation().pathname 同样是去掉 basename 后的值，可直接与该常量比较。
 */
export const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * 是否应把用户按到改密页：已登录且 user.mustChangePassword=true，且当前不在改密页。
 * mustChangePassword 是可选字段（旧后端/存量响应不带该键），按 falsy 处理。
 */
export function shouldForceChangePassword(user: { mustChangePassword?: boolean } | null, pathname: string): boolean {
  return user?.mustChangePassword === true && pathname !== CHANGE_PASSWORD_PATH;
}
