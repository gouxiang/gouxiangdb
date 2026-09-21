// apps/web/src/features/kb/usePublicDocEditing.ts
// 公开分享页的「正文/画布编辑」React 包装：把保存状态机接到组件上，核心 409 逻辑在
// publicDocSave.ts（纯函数，可单测）。每篇文档各自维护自己的 baseUpdatedAt 基线。
//
// 关键点：本地键入只写 ref（不 setState），避免每次按键都让整页重渲染；
// 内容真正进入 state 只有两处——加载（含切换文档）与 409 被服务端最新内容覆盖。
// 后者会自增 revision，页面据此重挂载编辑器/画布把新内容灌进去。

import { useEffect, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { PublicApi } from "../../api/client";
import { performPublicDocSave } from "./publicDocSave";

export function usePublicDocEditing({
  token,
  docId,
  kind,
  content,
  baseUpdatedAt,
  canEdit,
}: {
  token: string | undefined;
  docId: string | undefined;
  kind: string | undefined;
  /** 从读取接口拿到的正文（加载初值 / 切换文档时的新值） */
  content: string;
  /** 从读取接口拿到的乐观锁基线 */
  baseUpdatedAt: string | undefined;
  canEdit: boolean;
}) {
  const [editorContent, setEditorContent] = useState(content);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const localRef = useRef(content);
  const baseRef = useRef(baseUpdatedAt);
  const saveRef = useRef<() => void>(() => {});

  // 切换文档：重置本地内容与基线（每篇各自一份）
  useEffect(() => {
    setEditorContent(content);
    localRef.current = content;
    baseRef.current = baseUpdatedAt;
    setRevision(0);
    setSaving(false);
  }, [docId, baseUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveNow() {
    if (!canEdit || !docId || !token || saving) return;
    setSaving(true);
    const outcome = await performPublicDocSave(
      (args) => PublicApi.updateDocContent(token, docId, args),
      { content: localRef.current, baseUpdatedAt: baseRef.current ?? "" },
    );
    setSaving(false);
    if (outcome.status === "saved") {
      baseRef.current = outcome.updatedAt ?? baseRef.current;
      setEditorContent(localRef.current);
    } else if (outcome.status === "conflict") {
      // 他人已改：换成服务端最新内容 + 推进基线，并让编辑器重挂载；本次保存不重发
      baseRef.current = outcome.updatedAt;
      localRef.current = outcome.content ?? localRef.current;
      setEditorContent(outcome.content ?? localRef.current);
      setRevision((r) => r + 1);
    }
    toast(outcome.message, outcome.status === "saved" ? "success" : "error");
  }
  saveRef.current = () => void saveNow();

  // Cmd/Ctrl+S 保存（正文；画布由 DrawnixCanvas 自己拦截，这里不抢）
  useEffect(() => {
    if (!canEdit || kind === "canvas") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S") && !e.altKey) {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, kind]);

  return {
    /** 当前应展示的正文（加载初值 / 409 后被服务端最新值覆盖） */
    content: editorContent,
    /** 409 覆盖计数：>0 时页面据此给编辑器换 key 重挂载 */
    revision,
    saving,
    /** 编辑器/画布 onChange：只记本地，不触发重渲染 */
    setLocalContent: (md: string) => {
      localRef.current = md;
    },
    saveNow,
  };
}
