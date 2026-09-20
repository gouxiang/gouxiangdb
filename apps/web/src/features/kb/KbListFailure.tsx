// 知识库内容列表的加载失败态（PERM-05）。
//
// 为什么单独抽个文件：KbHomePage.tsx 在改动前已经是 307 行（超 300 行上限，既存欠账），
// 这段内联进去会让它继续膨胀；抽出来只让页面净增几行。
//
// 为什么不直接复用 features/views/ViewLoadFailure（PERM-04 抽的同构组件）：
//   那份是 PERM-04 已交付、已验收的代码，把「共用」做在同一个工作树里需要**搬家 + 删除**，
//   而本次尝试搬家时，`git rm --cached` 留下的暂存删除被卷进了别人的提交（见 5e52517 事故复盘）。
//   多人共用仓库里**删除文件路径限定的提交**有实打实的风险，所以这里不再动 PERM-04 的文件，
//   是否合并到 features/common/LoadFailureState 留给你/主程单独排一个重构提交来定。
//   两者的差别也确实存在：没有 missing 分支（列表不存在「指定了却找不到」的情形），
//   且兜底句要写「知识库」而不是「数据库」。

import { ApiError } from "../../api/client";
import { ErrorState, NoPermissionState } from "../../components/states";

export interface KbListFailureProps {
  /** `useKbDocs` 抛出的原始错误。 */
  error?: unknown;
  onRetry?: () => void;
  onBack: () => void;
}

/**
 * 只按 `ApiError.status` 判真值：
 * 401/403 → 无权限态（`data-gx-no-permission="true"`），与手输**文档** URL 的表现一致；
 * 其余    → 可重试错误态（`role="alert"`）。
 * 关键是：**不许再把失败判成「列表是空的」**（那就是 PERM-05 的假空态）。
 */
export function KbListFailure({ error, onRetry, onBack }: KbListFailureProps) {
  const status = error instanceof ApiError ? error.status : undefined;

  if (status === 401 || status === 403) {
    // 文案优先用后端给的真实原因（ApiError.body.error，如「无权访问该知识库」），
    // 拿不到才退兜底句 —— 不自造权限结论。
    // 也不给 onRequest：后端没有「申请权限」链路，挂上去就是点了没反应的假入口。
    const reason = error instanceof ApiError ? error.body?.error : undefined;
    return (
      <NoPermissionState
        description={reason ?? "你不是这个知识库的成员，也没有通过分享获得访问权限。请向知识库所有者申请后再打开。"}
        onBack={onBack}
      />
    );
  }

  return (
    <ErrorState
      reason={error instanceof Error ? error.message : undefined}
      onRetry={onRetry}
      onBack={onBack}
    />
  );
}
