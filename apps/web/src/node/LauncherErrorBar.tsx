// apps/web/src/node/LauncherErrorBar.tsx
// 启动器受控错误条（W2 错误收口）：容器持有 error 字符串，本组件只负责展示与关闭。
// message=null 时输出 null（SSR 返回空字符串），不占位。

import { Icon } from "../components/icons";
import { IconButton } from "../components/ui";

export interface LauncherErrorBarProps {
  message: string | null;
  onClose: () => void;
}

export function LauncherErrorBar({ message, onClose }: LauncherErrorBarProps) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-gx-lg border border-gx-danger bg-gx-danger-bg px-3 py-2 text-gx-13 text-gx-danger"
    >
      <span className="mt-px shrink-0">
        <Icon name="alertCircle" size={15} />
      </span>
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <IconButton
        icon="close"
        size={13}
        label="关闭错误提示"
        danger
        className="h-5 w-5 shrink-0"
        onClick={onClose}
      />
    </div>
  );
}
