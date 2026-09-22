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
import { authHeaders } from "../../api/authHeader";
import { saveDraft, loadDraft, clearDraft, hasRecoverableDraft, type Draft } from "./draft";

/**
 * saved   —— 已整篇 PUT 落库（单机/协同不可用时的路径）。
 * synced  —— 协同模式：内容已进房间，由服务端统一落库。
 *   ★ 两者不能混用：协同下握手成功只代表「内容进了房间」，正文落库是服务端 30s 冷归结
 *     的事，此时写「已保存到云端」是谎报（用户会以为关掉浏览器也没事）。故单独一档，
 *     文案用「已同步」，与「已保存」的持久化承诺区分开。
 */
export type SaveStatus = "saved" | "synced" | "saving" | "unsaved";

export function useDocPersistence(
  docId: string,
  kbId: string,
  serverContent: string | undefined,
  canEdit: boolean,
  serverVersion?: number,
  /**
   * 阶段 2 · 协同分支（**渐进增强，不是替换**）：
   * 协同连接可用时为 true → 不再整篇 PUT（内容由服务端统一落库，整篇 PUT 会与 CRDT 抢写、
   * 且撞 DESIGN §3.3 的乐观锁语义）；不可用时为 false → 原样走现有的防抖 1200ms PUT。
   * 本地草稿照写不误：它是崩溃兜底，与谁负责落库无关。
   */
  collabActive = false,
) {
  // 用 ref 读取，避免把 collabActive 变成下面所有回调的依赖（否则每次协同状态变化都会换引用）
  const collabActiveRef = useRef(collabActive);
  collabActiveRef.current = collabActive;
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [recovered, setRecovered] = useState<Draft | null>(null);
  /**
   * 阶段 4 · R-D-18 冲突（409）：保存撞上他人已保存时置位，由页面就地渲染
   * `<ConflictNotice>`（「查看最新版本 / 保留我的版本」二选一），禁止静默覆盖。
   * 带上服务端回给的 currentVersion，供「保留我的版本」以新版本号为基线重写。
   */
  const [conflict, setConflict] = useState<{ currentVersion: number | null } | null>(null);
  const conflictRef = useRef<{ currentVersion: number | null } | null>(null);
  conflictRef.current = conflict;

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
    async (content: string, opts: { manual?: boolean; force?: boolean } = {}) => {
      if (!canEdit) return;
      // force：冲突后「保留我的版本」重写时，内容可能与 lastSaved 字面相同，必须跳过短路
      if (!opts.force && content === lastSaved.current) {
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
        // S-1：版本冲突（他人已保存）——本地内容已入草稿；置位冲突态让页面就地提示，
        // 由用户二选一（R-D-18），不再只用一条 toast 把决定权静默交给"刷新"。
        const conflictErr = e instanceof ApiError && e.status === 409;
        if (conflictErr) {
          const cur = (e.body as { currentVersion?: number | null } | undefined)?.currentVersion ?? null;
          setConflict({ currentVersion: cur });
          void qc.invalidateQueries({ queryKey: ["kb", "doc", docIdRef.current] });
        } else if (opts.manual) {
          toast(e instanceof Error ? `保存失败：${e.message}` : "保存失败，已保留本地草稿", "error");
        }
      } finally {
        saving.current = false;
      }
    },
    [canEdit, qc],
  );

  /**
   * R-D-18「查看最新版本」：丢弃本地未落库内容，基线跟到服务端最新版本号。
   * 页面调用后应 refetch 并把编辑器内容重置为服务端值（本 hook 不持有编辑器状态）。
   * 本地草稿同步清除——用户已明确选择以服务端版本为准。
   */
  const takeLatestVersion = useCallback(() => {
    const cur = conflictRef.current;
    if (cur?.currentVersion != null) versionRef.current = cur.currentVersion;
    pending.current = null;
    clearDraft(docIdRef.current);
    setConflict(null);
    setStatus("saved");
  }, []);

  /**
   * R-D-18「保留我的版本」：以服务端最新版本号为新基线，把本地内容覆盖写回。
   * 走 force 跳过「与上次已保存内容相同」的短路，确保这一次一定会发出 PUT。
   */
  const keepMineVersion = useCallback(async () => {
    const cur = conflictRef.current;
    if (cur?.currentVersion != null) versionRef.current = cur.currentVersion;
    setConflict(null);
    const content = pending.current ?? lastSaved.current;
    await persist(content, { manual: true, force: true });
  }, [persist]);

  // 内容变更（编辑中高频调用）
  const markDirty = useCallback(
    (content: string) => {
      if (!canEdit) return;
      pending.current = content;
      if (content !== lastSaved.current) setStatus("unsaved");
      // 本地草稿（节流写，崩溃/刷新兜底）—— 协同接通时也照写：草稿是崩溃兜底，不是落库手段
      saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
      // 协同可用：内容已在房间内，由服务端统一落库，不再整篇 PUT（见参数注释）。
      // 状态用 synced 而非 saved：此刻只保证"进了房间"，不保证已落进正文表。
      if (collabActiveRef.current) {
        if (debounce.current) clearTimeout(debounce.current);
        setStatus("synced");
        return;
      }
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
    // 协同可用：内容随打随同步，服务端统一落库 —— 不再发整篇 PUT。
    // 但必须给反馈：按钮点了没反应是"反馈缺失"，用户会怀疑没保存上。
    if (collabActiveRef.current) {
      setStatus("synced");
      toast("已在协同中实时同步，无需手动保存", "success");
      return;
    }
    const content = pending.current ?? lastSaved.current;
    await persist(content, { manual: true });
  }, [persist]);

  // 同步 flush（卸载/切路由/关页面）：用 keepalive fetch 尽力带走，页面不阻塞；草稿已先行兜底
  const flush = useCallback(() => {
    const content = pending.current;
    if (content == null || content === lastSaved.current || !canEdit) return;
    // 先留草稿兜底（即使网络请求没发出去也不丢）
    saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
    // 协同可用：整篇 PUT 会让本地快照与 CRDT 抢写（DESIGN §3.3），flush 一并让位
    if (collabActiveRef.current) return;
    try {
      const token = useAuthStore.getState().token;
      void fetch(`${API_BASE_URL}/api/kb/docs/${docIdRef.current}/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
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

  // 新文档 / 新版本基线：清掉上一份文档遗留的冲突态，避免串台误报
  useEffect(() => {
    setConflict(null);
  }, [docId]);

  return {
    status,
    markDirty,
    saveNow,
    flush,
    recovered,
    recoverDraft,
    discardDraft,
    conflict,
    takeLatestVersion,
    keepMineVersion,
  };
}
