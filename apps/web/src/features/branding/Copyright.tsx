// 版权行展示组件（0.2.4-rc）：后台未配置版权串（空串）时渲染 null，不留空段落。
// {year} 占位的替换在 useCopyright → renderCopyright 内完成。
//
// 本派工先只导出不挂载；#753 登录页双栏改版会在页脚挂上 <Copyright />。

import { useCopyright } from "./useBranding";

export function Copyright({ className }: { className?: string }) {
  const text = useCopyright();
  if (!text) return null;
  return <p className={className}>{text}</p>;
}
