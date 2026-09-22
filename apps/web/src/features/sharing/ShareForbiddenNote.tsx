// apps/web/src/features/sharing/ShareForbiddenNote.tsx
// 分享弹窗里的「你没有这个库的分享权限」无权限态。数据表弹窗与文档弹窗共用同一份。
//
// 为什么单独成一块：后端收紧后，只有「可见」权（角色没被授予「可分享」、也无库管理权）的成员
// 调分享接口直接 403。此前这个 403 要么变成一句裸 toast、要么因为 GET 失败让弹窗永远停在
// 「加载中…」，用户看不出是自己没资格还是产品坏了。这里把后端那句原文放进弹窗正文，
// 并给一条明确的出路（关闭弹窗），而不是让人对着空白发呆。
//
// 只负责渲染：文案由调用方用 shareForbiddenMessage(error) 现取（后端原文优先）。

import { Button } from "../../components/ui";
import { Icon } from "../../components/icons";

export function ShareForbiddenNote({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-3">
      <div className="flex items-start gap-1.5 text-gx-12 text-gx-text-secondary">
        <Icon name="lock" size={13} className="mt-0.5 shrink-0 text-gx-text-tertiary" />
        <span>{message}</span>
      </div>
      <Button size="sm" variant="secondary" onClick={onClose}>
        关闭
      </Button>
    </div>
  );
}
