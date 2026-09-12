// apps/web/src/components/ErrorBoundary.tsx
// 渲染错误边界：避免单个单元格/文档脏数据导致整页白屏。
// 用于包裹路由子树与高风险渲染区（富文本、单元格、记录抽屉）。

import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 降级 UI；缺省显示通用提示 */
  fallback?: ReactNode;
  /** 出错时的额外回调（可用于上报） */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** 出错后是否显示「重试」按钮（重置边界） */
  showReset?: boolean;
  /** 紧凑模式：用于单元格等小区域，文案更短 */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[render error]", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const compact = this.props.compact;
    return (
      <div
        className={
          compact
            ? "flex h-full w-full items-center px-2 text-gx-12 text-gx-text-hint"
            : "flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
        }
      >
        <span className={compact ? "truncate text-gx-12" : "text-gx-14 text-gx-text-primary"}>
          {compact ? "内容渲染失败" : "该内容渲染失败，其余功能不受影响"}
        </span>
        {!compact && this.props.showReset !== false ? (
          <button
            type="button"
            onClick={this.reset}
            className="rounded-gx-sm border border-gx-border px-3 py-1 text-gx-13 text-gx-text-secondary hover:bg-gx-row-hover"
          >
            重试
          </button>
        ) : null}
        {compact ? null : (
          <span className="max-w-md truncate text-gx-12 text-gx-text-hint" title={error.message}>
            {error.message}
          </span>
        )}
      </div>
    );
  }
}

export default ErrorBoundary;
