// 视图加载失败态（PERM-04）：把 ViewRouter 里「拉不到视图」的三种结局收敛成一个组件。
//
// 背景（WALK-权限组合-2026-09-20 · PERM-04）：ViewRouter 原先只有 `viewsLoading` 一个分支，
// 任何「视图拿不到」的情形（403 / 500 / 视图已被删）都掉进同一个 `<Spinner />` 里永久转圈。
// 这里给出**终态**：能判权限就给无权限态，不能判就给可重试的错误态，绝不回到「继续等」。
//
// 抽成独立文件有两个原因：
//   ① ViewRouter.tsx 受「单文件 ≤300 行」公约约束，这段加进去会到 304 行；
//   ② 它是纯展示组件（无 hooks、无请求），可以在 node 环境里用 renderToStaticMarkup 直接
//     断言——apps/web 没有 jsdom，ViewRouter 本体依赖 router.QueryClient 反而不好测。

import { ApiError } from "../../api/client";
import { ErrorState, NoPermissionState } from "../../components/states";

export interface ViewLoadFailureProps {
  /** TanStack query 抛出的原始错误；视图列存在但 URL 上的 viewId 找不到时为 undefined。 */
  error?: unknown;
  /** 视图列表已加载、但 URL 指定的 viewId 不在其中（视图被删 / 旧链接失效）。 */
  viewMissing?: boolean;
  onRetry?: () => void;
  onBack: () => void;
}

/**
 * 只按 `ApiError.status` 判真值，**不做「先渲染、等后端 403 打回」**。
 * 401/403 → 无权限态（`data-gx-no-permission="true"`）；其余 → 可重试错误态（`role="alert"`）。
 */
export function ViewLoadFailure({ error, viewMissing, onRetry, onBack }: ViewLoadFailureProps) {
  const status = error instanceof ApiError ? error.status : undefined;
  const denied = status === 401 || status === 403;

  if (denied) {
    // 文案优先用后端给的真实原因（ApiError.body.error，如「无权访问该 Base」），
    // 拿不到才退 generic 兜底句 —— 不自己编造权限结论（与清空表/删库「文案必须合乎后端真相」同一要求）。
    // 也不给 onRequest：后端没有「申请权限」这条链路，挂上去就是一个点了没反应的按钮
    // —— 与本次要治的「先给你入口再说」是同一种毛病。
    const reason =
      error instanceof ApiError
        ? error.body?.error
        : error instanceof Error
          ? error.message
          : undefined;
    return (
      <NoPermissionState
        description={reason ?? "你没有查看这个数据库的权限。请向库所有者或管理员申请后再打开。"}
        onBack={onBack}
      />
    );
  }

  const missing = viewMissing && !error;
  return (
    <ErrorState
      title={missing ? "视图不存在" : "加载失败"}
      reason={
        missing
          ? "这个视图可能已被删除，或者链接已经失效。"
          : error instanceof Error
            ? error.message
            : undefined
      }
      onRetry={missing ? undefined : onRetry}
      onBack={onBack}
    />
  );
}
