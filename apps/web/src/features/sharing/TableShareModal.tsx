// apps/web/src/features/sharing/TableShareModal.tsx
// 数据表分享弹窗：档位（只读 / 可编辑）+ 默认视图 + 链接列表。
//
// 入口在统一视图外壳 ViewShell 的「更多」菜单（六类视图都有），此前数据表视图里没有任何
// 分享入口（旧的「分享数据·规划中」占位已按产品要求下线）。
//
// 权限口径：前端不算权限。
//   · 「可编辑」是否置灰 = **后端** GET /share 现算的 canGrantEdit（判的是"本人对**这一张表**的
//     update"，与建链接时的 assertSharerCanGrantEdit 是同一次判定）。未加载/出错一律按 false
//     （fail-closed），不用库级 canEditData 猜——那是聚合位，本库任一表可写就为真，置灰会偏松。
//   · 列表里的档位一律显示 effectiveMode；degraded=true 的那条由 ShareLinkList 显示降级提示。

import { useEffect, useState } from "react";
import type { ShareMode } from "@gx/shared-types";
import { Button, Modal, Select, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { confirmAction } from "../../components/feedback";
import { useViews } from "../../api/hooks";
import { COPY_FAIL_HINT_LINK, copyText } from "../../lib/clipboard";
import {
  revokeErrorMessage,
  shareErrorMessage,
  shareForbiddenMessage,
  submitTableShare,
  useCreateTableShareLink,
  useRevokeTableShareLink,
  useTableShareLinks,
} from "./share-hooks";
import { ShareModeField } from "./ShareModeField";
import { ShareLinkList, shareUrlOf } from "./ShareLinkList";
import { ShareForbiddenNote } from "./ShareForbiddenNote";

export interface TableShareModalProps {
  tableId: string;
  /** 当前视图：作为新链接默认视图的初值（可改） */
  viewId: string;
  open: boolean;
  onClose: () => void;
}

export function TableShareModal({ tableId, viewId, open, onClose }: TableShareModalProps) {
  const links = useTableShareLinks(open ? tableId : null);
  const { data: views } = useViews(open ? tableId : null);
  const create = useCreateTableShareLink();
  const revoke = useRevokeTableShareLink();

  const [mode, setMode] = useState<ShareMode>("view");
  const [defaultViewId, setDefaultViewId] = useState(viewId);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 后端现算的「本人能否开可编辑」；数据未到 / 出错时按不能（fail-closed）。
  const canGrantEdit = links.data?.canGrantEdit ?? false;
  // 角色没被授予「可分享」且无库管理权时，GET 列表直接 403：列表读不出来、链接也建不了，
  // 弹窗不该停在「正在读取…」，而要把后端那句权限原因摆出来。
  const forbidden = shareForbiddenMessage(links.error);

  // 换表 / 切视图后重开弹窗：默认视图跟着当前视图走（用户多半就想分享眼前这一屏）
  useEffect(() => {
    if (open) setDefaultViewId(viewId);
  }, [open, viewId]);
  // 本人已无编辑权时不允许停留在「可编辑」档位上（比如刚被降权），回落只读。
  useEffect(() => {
    if (!canGrantEdit) setMode("view");
  }, [canGrantEdit]);

  async function copyLink(url: string) {
    if (await copyText(shareUrlOf(url))) {
      toast("链接已复制", "success");
      return;
    }
    toast(COPY_FAIL_HINT_LINK, "error");
  }

  async function generate() {
    await submitTableShare({
      tableId,
      mode,
      viewId: defaultViewId || undefined,
      create: (p) => create.mutateAsync(p),
    });
  }

  async function close(linkId: string, url: string) {
    const ok = await confirmAction({
      title: "关闭分享链接",
      confirmText: "关闭链接",
      cancelText: "取消",
      level: 2,
      description: `链接「${shareUrlOf(url)}」会立即失效，正在使用它的人将失去访问。需要时可以再生成一条。`,
    });
    if (!ok) return;
    setBusyId(linkId);
    try {
      await revoke.mutateAsync({ tableId, linkId });
      toast("已关闭链接", "success");
    } catch (e) {
      toast(revokeErrorMessage(e), "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="分享这张数据表" width={560} footer={<Button onClick={onClose}>完成</Button>}>
      <div className="space-y-4">
        <section>
          <div className="mb-1.5 text-gx-12 text-gx-text-secondary">持链者权限</div>
          <ShareModeField
            value={mode}
            onChange={setMode}
            canGrantEdit={canGrantEdit}
            disabledReason="你本人对这张表没有编辑权，因此不能创建可编辑的分享链接"
          />
        </section>

        <section>
          <div className="mb-1.5 text-gx-12 text-gx-text-secondary">链接打开的默认视图</div>
          <Select
            value={defaultViewId}
            onChange={(e) => setDefaultViewId(e.target.value)}
            options={[
              { value: "", label: "不指定（后端取第一个视图）" },
              ...(views ?? []).map((v) => ({ value: v.id, label: v.name })),
            ]}
            className="h-8 w-full max-w-[22rem]"
            aria-label="链接打开的默认视图"
          />
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-gx-12 text-gx-text-secondary">已生成的链接</div>
            <Button size="sm" variant="primary" icon="plus" loading={create.isPending} onClick={() => void generate()}>
              生成链接
            </Button>
          </div>

          {links.isLoading ? (
            <div className="py-6 text-center text-gx-12 text-gx-text-hint">正在读取分享链接…</div>
          ) : forbidden ? (
            <ShareForbiddenNote message={forbidden} onClose={onClose} />
          ) : links.isError ? (
            <div className="flex items-start gap-1.5 rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-3 text-gx-12 text-gx-text-tertiary">
              <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
              {/* 未开分享 / 无权访问时后端的 403 文案就是答案，原样显示 */}
              <span>{shareErrorMessage(links.error, "读取分享链接失败")}</span>
            </div>
          ) : (
            <ShareLinkList
              links={links.data?.links ?? []}
              busyId={busyId}
              onCopy={(l) => void copyLink(l.url)}
              onRevoke={(l) => void close(l.id, l.url)}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}
