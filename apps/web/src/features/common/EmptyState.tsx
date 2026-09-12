// apps/web/src/features/common/EmptyState.tsx
// 空状态通用组件

interface Props {
  message: string;
  icon?: React.ReactNode;
}

export function EmptyState({ message, icon }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-gx-text-tertiary">
      {icon}
      <p className="mt-gx-md text-gx-13">{message}</p>
    </div>
  );
}