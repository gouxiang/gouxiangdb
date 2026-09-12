// apps/web/src/features/kb/useDocPersistence.ts
// 文档/画布统一持久化 hook（协同解决"保存"与"不丢内容"）：
//  - markDirty(content)：内容每次变更调用（画布 onValueChange / 文档 onChange），内部防抖自动保存 + 写本地草稿
//  - saveNow()：手动"保存"按钮，立即 PUT 到后端（绝不触发本地下载），成功 toast + 清草稿
//  - beforeunload / pagehide / 路由卸载：若有未落库内容，尽力同步 flush（sendBeacon 兜底）
//  - 加载时若存在比服务端更新的本地草稿，提供 recoveredDraft 供 UI 提示恢复
//  - status: saved | saving | unsaved，驱动顶栏反馈

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../../components/ui";
import { KbApi, API_BASE_URL, ApiError, type KbDocDTO } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { saveDraft, loadDraft, clearDraft, hasRecoverableDraft, type Draft } from "./draft";

export type SaveStatus = "saved" | "saving" | "unsaved";

export function useDocPersistence(
  docId: string,
  kbId: string,
  serverContent: string | undefined,
  canEdit: boolean,
  serverVersion?: number,
) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [recovered, setRecovered] = useState<Draft | null>(null);

  const pending = useRef<string | null>(null); // 待保存的最新内容
  const lastSaved = useRef<string>(serverContent ?? ""); // 已成功落库的内容
  const baseContent = useRef<string>(serverContent ?? ""); // 服务端基线（草稿对比用）
  // S-1 乐观锁：当前已知的服务端版本；保存携带 baseVersion，409=他人已保存
  const versionRef = useRef<number | undefined>(serverVersion);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const docIdRef = useRef(docId);
  docIdRef.current = docId;

  // 保存成功后，把最新 content 同步写回 React Query 的单文档缓存。
  // 根因：useDoc 设置了 staleTime 5 分钟且不做窗口聚焦 refetch，文档切换时 useDoc
  // 在 staleTime 内直接返回缓存里的旧 doc.content，编辑器用旧内容初始化，表现为
  // "保存提示成功、切走再切回内容回退、刷新页面才恢复"。这里用 setQueryData 原地更新
  // 缓存（而非 invalidate 重拉），既保证切回读到最新内容，又不触发后台 refetch 覆盖
  // 编辑器正在持有的本地状态。DocEditorPage 与 CanvasEditorPage 共用本 hook，一并修复。
  const syncDocCache = useCallback(
    (id: string, content: string, contentVersion?: number | null) => {
      qc.setQueryData<KbDocDTO>(["kb", "doc", id], (old) =>
        old ? { ...old, content, ...(contentVersion != null ? { contentVersion } : {}) } : old,
      );
    },
    [qc],
  );

  // 服务端内容到位后初始化
  useEffect(() => {
    if (serverContent === undefined) return;
    lastSaved.current = serverContent;
    baseContent.current = serverContent;
    versionRef.current = serverVersion;
    pending.current = null;
    setStatus("saved");
    // 检查可恢复草稿
    const d = hasRecoverableDraft(docId, serverContent);
    setRecovered(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, serverContent === undefined ? "" : serverContent, serverVersion]);

  const persist = useCallback(
    async (content: string, opts: { manual?: boolean } = {}) => {
      if (!canEdit) return;
      if (content === lastSaved.current) {
        pending.current = null;
        setStatus("saved");
        return;
      }
      saving.current = true;
      setStatus("saving");
      try {
        const res = await KbApi.saveContent(docIdRef.current, { content, baseVersion: versionRef.current });
        lastSaved.current = content;
        if (res.contentVersion != null) versionRef.current = res.contentVersion;
        pending.current = null;
        setStatus("saved");
        clearDraft(docIdRef.current);
        syncDocCache(docIdRef.current, content, res.contentVersion);
        if (opts.manual) toast("已保存到云端", "success");
      } catch (e) {
        setStatus("unsaved");
        // 落库失败：内容留在本地草稿，绝不丢
        saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
        // S-1：版本冲突（他人已保存）——本地内容已入草稿，提示并刷新缓存供用户合并
        const conflict = e instanceof ApiError && e.status === 409;
        if (conflict) {
          void qc.invalidateQueries({ queryKey: ["kb", "doc", docIdRef.current] });
          toast("文档已被他人修改，你的内容已保留在本地草稿，请刷新后合并", "error");
        } else if (opts.manual) {
          toast(e instanceof Error ? `保存失败：${e.message}` : "保存失败，已保留本地草稿", "error");
        }
      } finally {
        saving.current = false;
      }
    },
    [canEdit],
  );

  // 内容变更（编辑中高频调用）
  const markDirty = useCallback(
    (content: string) => {
      if (!canEdit) return;
      pending.current = content;
      if (content !== lastSaved.current) setStatus("unsaved");
      // 本地草稿（节流写，崩溃/刷新兜底）
      saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        if (pending.current != null) void persist(pending.current);
      }, 1200);
    },
    [canEdit, persist],
  );

  // 手动保存（按钮）
  const saveNow = useCallback(async () => {
    if (debounce.current) clearTimeout(debounce.current);
    const content = pending.current ?? lastSaved.current;
    await persist(content, { manual: true });
  }, [persist]);

  // 同步 flush（卸载/切路由/关页面）：用 keepalive fetch 尽力带走，页面不阻塞；草稿已先行兜底
  const flush = useCallback(() => {
    const content = pending.current;
    if (content == null || content === lastSaved.current || !canEdit) return;
    // 先留草稿兜底（即使网络请求没发出去也不丢）
    saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
    try {
      const token = useAuthStore.getState().token;
      void fetch(`${API_BASE_URL}/api/kb/docs/${docIdRef.current}/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ content, baseVersion: versionRef.current }),
        keepalive: true,
      })
        .then(async (r) => {
          if (r.ok) {
            lastSaved.current = content;
            try {
              const j = (await r.json()) as { contentVersion?: number | null };
              if (j.contentVersion != null) versionRef.current = j.contentVersion;
            } catch { /* 版本号缺失不影响 */ }
            clearDraft(docIdRef.current);
            syncDocCache(docIdRef.current, content);
          }
        })
        .catch(() => {});
    } catch {
      /* 草稿已兜底 */
    }
  }, [canEdit, syncDocCache]);

  // 卸载 / 关闭页面前 flush
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (pending.current != null && pending.current !== lastSaved.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onHide = () => flush();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onHide);
      flush(); // 路由切换卸载时
    };
  }, [flush]);

  // 恢复草稿
  const recoverDraft = useCallback((): string | null => {
    const d = loadDraft(docId);
    if (d) {
      pending.current = d.content;
      lastSaved.current = baseContent.current; // 仍以服务端为已保存基线，恢复内容待保存
      setStatus("unsaved");
      setRecovered(null);
      return d.content;
    }
    return null;
  }, [docId]);

  const discardDraft = useCallback(() => {
    clearDraft(docId);
    setRecovered(null);
    pending.current = null;
  }, [docId]);

  return { status, markDirty, saveNow, flush, recovered, recoverDraft, discardDraft };
}
