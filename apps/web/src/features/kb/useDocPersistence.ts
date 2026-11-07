// apps/web/src/features/kb/useDocPersistence.ts
// 文档/画布统一持久化 hook（协同解决"保存"与"不丢内容"）：
//  - markDirty(content)：内容每次变更调用（画布 onValueChange / 文档 onChange），内部防抖自动保存 + 写本地草稿
//  - saveNow()：手动"保存"按钮，立即把最新内容送入串行保存链（绝不触发本地下载），成功 toast + 清草稿
//  - beforeunload / pagehide / 路由卸载：若有未落库内容，尽力同步 flush（keepalive fetch 兜底）
//  - 加载时若存在比服务端更新的本地草稿，提供 recoveredDraft 供 UI 提示恢复
//  - status: saved | saving | unsaved，驱动顶栏反馈
//
// ★ 在途串行化（修复 A，根治单人假 409）：
//   同一 docId 任意时刻最多只有一个 PUT 在途（inFlightRef 互斥）。防抖自动保存、手动保存、
//   冲突后「保留我的版本」全部汇入唯一的 drain()；在途期间的新内容只覆盖 pending.current，
//   待在途 PUT 回来后再以「最新内容 + 刚回写的最新 baseVersion」发下一个 PUT。N 次快速改动
//   因此塌缩成一条串行链，绝不并发两个携带相同 baseVersion 的 PUT，从根上消除单人无协作却
//   自撞乐观锁 409 的问题。冲突（409）待裁决期间 drain 暂停，不自动续发，避免重复刷冲突框。
//
// ★ Y 通道接管（yOwned，修复 0.3.0 两个真机 bug 的统一根因）：
//   桌面壳构建注入 VITE_OFFLINE_Y=1，文档页建立真实 Yjs 协同会话。此时整篇 Markdown 草稿与
//   REST 乐观锁 PUT 仍是单机语义，与 Y 通道并存会出两类事故：
//     · Bug A（草稿恢复条反复复活）：Y 远端回放无条件 onChange→markDirty→saveDraft，而协同态
//       不发 PUT、drain 成功后的 clearDraft 永不触发，重进页面加载 effect 又据残留草稿弹恢复条。
//     · Bug B（单人假 409）：服务端协同冷归结抬高 contentVersion 却无版本回灌，WS 掉线时
//       collabActive 变 false 误降级走 REST PUT，携带过期 baseVersion 撞条件更新 count=0 → 409。
//   yOwned 与第 6 参 collabActive 的语义差别（二者不可互换）：
//     · collabActive 仅 status==="connected"，掉线（reconnecting/offline）即 false；
//     · yOwned = isCollabBindingStatus(status, Y_OFFLINE)，覆盖所有「Y 已绑定并接管本文档持久化」
//       的状态（门控开时含 connecting/reconnecting/offline），与 WysiwygEditor 的 Y 绑定真值同源。
//   yOwned=true 时本 hook 全面让位：不发任何整篇 REST PUT（markDirty 防抖/flush keepalive/saveNow）、
//   加载时普通残留草稿不弹恢复条。仅保留 markDirty 的 saveDraft 作「源码态」崩溃兜底——源码模式
//   （SourceEditor 纯 textarea，无 Y 绑定）下的文字改动在切回所见即所得前不进 Y.Doc，这份整篇
//   草稿是其唯一落地兜底；由 localMergedTick 合并后经 clearDraftUnlessSourceUnmerged 条件清理（见
//   DocEditorPage）。
//   P1-2 source 模式安全网：第 8 参 sourceMode=true 时，yOwned 分支的 saveDraft 带 sourceUnmerged 标记。
//   该标记让草稿在 Y 接管期仍保留「恢复草稿」入口（加载/接管切换 effect 的 resolveYOwnedRecovered），
//   且不被 gx-y 合并确认或在途 PUT 成功后的条件清理误删；非 source 的 markDirty 同 key 覆盖即解除标记。
//   P1-1 drain 闸门：drain 的 while 续体与 finally 补轮均加 !yOwnedRef——翻转前已在途的 PUT 走完，
//   翻转后绝不凭残留 pending 再发整篇 PUT。P2-1 加载 effect 在 yOwned 下置 "synced"（非 "saved"），
//   避免重连 refetch 回灌版本时误报「已保存到云端」。P2-2 yOwned 下 beforeunload 不弹离开确认。
//   恢复条与接管态的对齐分两道 effect：加载 effect 管「doc 到达晚于协同」（yOwned=true 时仅保留
//   sourceUnmerged 源码草稿、普通草稿置 null）；另有一个依赖 [yOwned, docId] 的切换 effect 管
//   「doc 缓存先到、协同后连」——重进页面时首帧 status=idle(yOwned=false) 加载 effect 已据草稿弹条，
//   WS 建连 yOwned 翻转时由它经 resolveYOwnedRecovered 收回普通草稿（保留 sourceUnmerged）；退回
//   REST(true→false) 则在正文已到位时重算，保证 REST 真源下合法草稿恢复条仍可达。
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../../components/ui";
import { KbApi, ApiError, type KbDocDTO } from "../../api/client";
import { dataSourceResolver } from "../../node/datasource";
import {
  saveDraft,
  loadDraft,
  clearDraft,
  clearDraftUnlessSourceUnmerged,
  hasRecoverableDraft,
  type Draft,
} from "./draft";
import { extractCanvasEmbeds, extractTableEmbeds } from "./mentions";

/**
 * saved   —— 已整篇 PUT 落库（单机/协同不可用时的路径）。
 * synced  —— 协同模式：内容已进房间，由服务端统一落库。
 *   ★ 两者不能混用：协同下握手成功只代表「内容进了房间」，正文落库是服务端 30s 冷归结
 *     的事，此时写「已保存到云端」是谎报（用户会以为关掉浏览器也没事）。故单独一档，
 *     文案用「已同步」，与「已保存」的持久化承诺区分开。
 */
export type SaveStatus = "saved" | "synced" | "saving" | "unsaved";

/** 单文档正文缓存键（与 kb-hooks.ts 的 QK.doc 完全一致，精确 3 键，避免误命中 4 键 share 查询）。 */
const docQueryKey = (id: string) => ["kb", "doc", id] as const;

/**
 * 覆盖前的画布/数据表内嵌引用防丢比对（A3）：
 * 服务端最新正文里存在、但本地待覆盖正文里缺失的引用集合。非空即意味着「保留我的版本」
 * 会抹掉别人已保存的画布/表格引用，必须拦截。纯函数，便于单测。
 */
export function missingEmbeds(serverSrc: string, localSrc: string): {
  canvas: string[];
  tables: { tableId: string; viewId: string | null }[];
} {
  const localCanvas = new Set(extractCanvasEmbeds(localSrc));
  const localTableKeys = new Set(
    extractTableEmbeds(localSrc).map((t) => `${t.tableId}:${t.viewId ?? ""}`),
  );
  const canvas = extractCanvasEmbeds(serverSrc).filter((id) => !localCanvas.has(id));
  const tables = extractTableEmbeds(serverSrc).filter(
    (t) => !localTableKeys.has(`${t.tableId}:${t.viewId ?? ""}`),
  );
  return { canvas, tables };
}

/**
 * yOwned（Y 接管）态的恢复条决策（P1-2）：Y.Doc 是真源，普通 Y 回放产生的残留整篇草稿不得弹条；
 * 唯独带 sourceUnmerged 标记的源码模式草稿（SourceEditor 的改动从未回流 Y.Doc）要保留恢复入口，
 * 否则用户在源码模式的编辑会被静默清空且无入口。纯读，node 可测。
 */
function resolveYOwnedRecovered(docId: string): Draft | null {
  const d = loadDraft(docId);
  return d?.sourceUnmerged ? d : null;
}

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
  /**
   * Y 通道是否已绑定并接管本文档持久化（默认 false，与引入前逐字一致）。
   * 与 collabActive 的关键差别：collabActive 仅认 "connected"，WS 短暂掉线即 false（会误降级走
   * REST PUT 携带过期 baseVersion 撞假 409，即 Bug B）；yOwned 由 isCollabBindingStatus 计算，
   * 门控开时覆盖 connecting/reconnecting/offline 全部 Y 绑定态，语义＝「Y 已接管，REST 必须让位」。
   * 传 true 时：不发任何整篇 PUT、不排防抖/keepalive、加载时不弹草稿恢复条；仅保留 markDirty 的
   * saveDraft 作源码态（无 Y 绑定窗口）崩溃兜底。非 Y 接管路径（false）行为逐字不变。
   */
  yOwned = false,
  /**
   * 当前是否处于源码（source）模式（默认 false，与引入前逐字一致；画布 5 参、既有测试不传即 false）。
   * 仅在 yOwned 接管时有意义：source 模式下 SourceEditor 是无 Y 绑定的纯 textarea，其 markDirty
   * 写的整篇草稿尚未回流 Y.Doc，需给草稿打 sourceUnmerged 标记以保留恢复入口、且不被 gx-y 合并确认
   * （localMergedTick → clearDraftUnlessSourceUnmerged）误清。非 source 或非 yOwned 路径行为不变。
   */
  sourceMode = false,
) {
  // 用 ref 读取，避免把 collabActive 变成下面所有回调的依赖（否则每次协同状态变化都会换引用）
  const collabActiveRef = useRef(collabActive);
  collabActiveRef.current = collabActive;
  // 同理用 ref 读 yOwned：协同状态（含掉线/重连）频繁变化不应让 markDirty/flush/saveNow 换引用。
  const yOwnedRef = useRef(yOwned);
  yOwnedRef.current = yOwned;
  // sourceMode 同理用 ref：模式切换不换 markDirty 等回调引用。
  const sourceModeRef = useRef(sourceMode);
  sourceModeRef.current = sourceMode;
  // 记录上一次渲染的 yOwned，供下方「接管态切换 effect」判 false→true / true→false 边沿。
  // 初值 false：与协同会话初始 status="idle"（yOwned 必为 false）一致，首挂载不会误判为切换。
  const prevYOwnedRef = useRef(false);
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [recovered, setRecovered] = useState<Draft | null>(null);
  /**
   * 阶段 4 · R-D-18 冲突（409）：保存撞上他人已保存时置位，由页面就地渲染
   * `<ConflictNotice>`（「查看最新版本 / 保留我的版本」二选一），禁止静默覆盖。
   * conflictRef 是事件循环内同步维护的权威值（state 仅驱动 UI），drain 在同一次 await
   * 链路里据此立即暂停；conflict state 镜像供渲染，二者一起置位/清零。
   */
  const [conflict, setConflictState] = useState<{ currentVersion: number | null } | null>(null);
  const conflictRef = useRef<{ currentVersion: number | null } | null>(null);
  const setConflict = useCallback((next: { currentVersion: number | null } | null) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);

  const pending = useRef<string | null>(null); // 待保存的最新内容（在途期间被新编辑持续覆盖）
  const lastSaved = useRef<string>(serverContent ?? ""); // 已成功落库的内容
  const baseContent = useRef<string>(serverContent ?? ""); // 服务端基线（草稿对比用）
  // S-1 乐观锁：当前已知的服务端版本；保存携带 baseVersion，409=他人已保存
  const versionRef = useRef<number | undefined>(serverVersion);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★ 修复 A：同 docId 单在途 PUT 互斥位。取代旧的死变量 saving（旧变量只写不读，无互斥效果）。
  const inFlightRef = useRef(false);
  // 强制下一轮 PUT 即使内容与 lastSaved 字面相同也要发出（冲突后「保留我的版本」覆盖写）。
  const forceRef = useRef(false);
  // 链上是否挂着一次手动保存的成功提示：排空后统一弹一次，避免在途合并时漏提示或多轮重复弹。
  const manualNotifyRef = useRef(false);
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  // canEdit 用 ref 读，drain/flush 不必把它放进依赖、也不会因权限变化换回调引用。
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  // 保存成功后，把最新 content 同步写回 React Query 的单文档缓存。
  // 根因：useDoc 设置了 staleTime 5 分钟且不做窗口聚焦 refetch，文档切换时 useDoc
  // 在 staleTime 内直接返回缓存里的旧 doc.content，编辑器用旧内容初始化，表现为
  // "保存提示成功、切走再切回内容回退、刷新页面才恢复"。这里用 setQueryData 原地更新
  // 缓存（而非 invalidate 重拉），既保证切回读到最新内容，又不触发后台 refetch 覆盖
  // 编辑器正在持有的本地状态。DocEditorPage 与 CanvasEditorPage 共用本 hook，一并修复。
  const syncDocCache = useCallback(
    (id: string, content: string, contentVersion?: number | null) => {
      qc.setQueryData<KbDocDTO>(docQueryKey(id), (old) =>
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
    // P2-1：yOwned 接管态下重连 refetch 会重跑本 effect 回灌 contentVersion（Bug B 修复目的，
    // 上面几行初始化一个都不许动），但不能因此把状态打成「已保存到云端」——协同态正文落库是服务端
    // 冷归结的事，此刻只保证内容在房间内，应显示「已同步」。非接管态维持原「已保存」语义。
    setStatus(yOwnedRef.current ? "synced" : "saved");
    // 检查可恢复草稿。
    // ★ yOwned（Y 通道接管）时普通残留草稿不弹恢复条（Bug A 根治）：Y 远端回放会无条件回流
    //   onChange→markDirty→saveDraft 产生残留草稿，但内容真源已是 Y.Doc，弹「恢复草稿」会让用户在
    //   CRDT 内容与整篇旧草稿间二选一，既误导又可能覆盖协同结果。P1-2 例外：带 sourceUnmerged 标记的
    //   源码模式草稿（从未回流 Y.Doc）必须保留恢复入口，否则源码编辑会被静默清空（resolveYOwnedRecovered）。
    const d = yOwnedRef.current
      ? resolveYOwnedRecovered(docId)
      : hasRecoverableDraft(docId, serverContent);
    setRecovered(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, serverContent === undefined ? "" : serverContent, serverVersion]);

  // Y 接管态切换时让 recovered 的显隐真正跟随 Y 接管，而不是只在 doc 到达时算一次。
  // ★ 堵「重进页面」时序缺口（Bug A 主场景）：React Query 缓存命中（staleTime 5 分钟内重进）时
  //   doc 首帧即到，此时协同会话 status 仍恒为 "idle"、yOwned=false，上面的加载 effect 已据残留
  //   草稿 setRecovered(非空) 弹了恢复条；随后 WS 建连 status→connecting/connected、yOwned 转 true，
  //   但加载 effect 依赖不含协同状态、不会重跑，恢复条会一直挂着。本 effect 用布尔 state 本身作依赖
  //   （不能只靠 ref，否则不触发），在 yOwned 翻转的那一渲染执行，把 recovered 与接管态对齐：
  //     · false→true（进入 Y 接管）：普通残留整篇草稿收回（→ null）；唯 P1-2 带 sourceUnmerged 的
  //       源码模式草稿保留恢复入口（resolveYOwnedRecovered），因它从未回流 Y.Doc、不能被静默清空；
  //     · true→false（协同被 denied 等终态、真源切回 REST）：若服务端正文已是 string，重新据草稿算
  //       一次，让 REST 真源下的合法草稿恢复条仍可达；正文未到（undefined）则置 null，等加载 effect。
  //   依赖用 [yOwned, docId]：docId 切换时 prev 与当前同值（均按新会话重算），不产生误切换。
  useEffect(() => {
    const wasOwned = prevYOwnedRef.current;
    const nowOwned = yOwnedRef.current;
    // 无论是否发生切换都先对齐 prev：本 effect 仅在 [yOwned, docId] 变化时触发，
    // 故 docId 变化而 yOwned 未变时 wasOwned===nowOwned，直接 no-op（docId 基线归加载 effect 管）。
    prevYOwnedRef.current = nowOwned;
    if (wasOwned === nowOwned) return; // 非接管态切换：不动 recovered（避免与加载 effect 打架）
    if (nowOwned) {
      // false→true 进入 Y 接管：普通残留草稿收回（Y.Doc 为真源）；但 P1-2 的 sourceUnmerged
      // 源码草稿从未回流 Y.Doc，必须保留恢复入口，不能在上升沿一并抹掉。
      setRecovered(resolveYOwnedRecovered(docId));
    } else if (typeof serverContent === "string") {
      // true→false 退回 REST 真源：服务端正文已到位则重算，让合法草稿恢复条仍可达。
      setRecovered(hasRecoverableDraft(docId, serverContent));
    } else {
      // 正文未到：先置 null，待加载 effect 在 serverContent 到达时按非接管基线初始化。
      setRecovered(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yOwned, docId]);

  /**
   * 唯一的串行保存泵（修复 A 核心）。
   * 入口若已有 PUT 在途直接 return——本次新内容已由 markDirty/saveNow 写进 pending.current，
   * 会被在途那一轮的 while 循环顺带消费，绝不发出第二个并发 PUT。
   * while 每轮只在「有待保存内容、相对上次落库有变化、可编辑、无冲突待裁决」时发 PUT；
   * 成功后回写版本与 lastSaved、清草稿、同步缓存；若在途期间又涌入新内容则继续下一轮，
   * 且下一轮携带的是上一轮刚回写的最新 baseVersion（杜绝相同 baseVersion 的并发/连发）。
   */
  const drain = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!canEditRef.current) return;
    inFlightRef.current = true;
    try {
      // P1-1：while 续体加 !yOwnedRef 闸门。yOwned 翻转前已在途的那一轮 PUT 无法 abort、让它走完
      // （进 while 时 yOwned 仍可能为 false）；但翻转后即便 pending 有残留也不得再发新一轮整篇 PUT，
      // 否则会在 Y 已接管后与 CRDT 抢写、并用过期 baseVersion 撞假 409。yOwned 恒 false（画布/非协同）
      // 时该条件恒真，行为与引入前逐字一致。
      while (
        canEditRef.current &&
        conflictRef.current == null &&
        !yOwnedRef.current &&
        (forceRef.current ||
          (pending.current != null && pending.current !== lastSaved.current))
      ) {
        const content = pending.current ?? lastSaved.current;
        setStatus("saving");
        try {
          const res = await KbApi.saveContent(docIdRef.current, {
            content,
            baseVersion: versionRef.current,
          });
          lastSaved.current = content;
          forceRef.current = false;
          if (res.contentVersion != null) versionRef.current = res.contentVersion;
          // 仅当在途期间没有涌入更新的内容时才清空 pending，否则保留最新内容供下一轮发送
          if (pending.current === content) pending.current = null;
          // P1-2 补强：在途 PUT 可能是 yOwned 翻转前调度、翻转后才回来（P1-1 允许它走完）。
          // 若在途期间用户已在 source 模式写入 sourceUnmerged 草稿（从未进 Y、也不在本次 PUT 的
          // content 里），无条件 clearDraft 会把它抹掉、违背「source 编辑不丢」。改用条件清理：
          // 无标记时与 clearDraft 逐字等价（非协同/画布路径 sourceUnmerged 恒不存在 → 零回归）。
          clearDraftUnlessSourceUnmerged(docIdRef.current);
          syncDocCache(docIdRef.current, content, res.contentVersion);
          // 手动保存的成功提示在整条链排空后统一给出一次（见 while 之后），不在每轮重复弹。
        } catch (e) {
          forceRef.current = false;
          setStatus("unsaved");
          // 落库失败：内容留在本地草稿，绝不丢
          saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
          const conflictErr = e instanceof ApiError && e.status === 409;
          if (conflictErr) {
            // S-1 版本冲突（他人已保存）：本地内容已入草稿。置位冲突态并暂停 drain，
            // 由用户在「查看最新版本 / 保留我的版本」间二选一（R-D-18），不自动重发。
            const cur =
              (e.body as { currentVersion?: number | null } | undefined)?.currentVersion ?? null;
            setConflict({ currentVersion: cur });
            void qc.invalidateQueries({ queryKey: docQueryKey(docIdRef.current) });
          } else {
            toast(e instanceof Error ? `保存失败：${e.message}` : "保存失败，已保留本地草稿", "error");
          }
          // 无论 409 还是网络错误都跳出：409 待裁决；网络错误退避（下次 markDirty/saveNow 再触发）
          break;
        }
      }
      // 正常排空（无冲突、无新内容）→ 已落库；若仍有 pending 说明是冲突/出错跳出，保持 unsaved
      const drained =
        conflictRef.current == null &&
        !forceRef.current &&
        (pending.current == null || pending.current === lastSaved.current);
      if (drained) {
        setStatus("saved");
        // 链排空后才兑现手动保存提示：在途合并、多轮塌缩都只弹这一次。
        if (manualNotifyRef.current) {
          manualNotifyRef.current = false;
          toast("已保存到云端", "success");
        }
      }
    } finally {
      inFlightRef.current = false;
      // 在途期间又有新编辑、且当前没有冲突待裁决：补一轮把最新内容发出去（仍是单在途，不并发）。
      // P1-1：同样加 !yOwnedRef 闸门——在途期间 Y 接管翻转后，finally 不得凭残留 pending 补轮发新 PUT。
      if (
        conflictRef.current == null &&
        canEditRef.current &&
        !yOwnedRef.current &&
        (forceRef.current ||
          (pending.current != null && pending.current !== lastSaved.current))
      ) {
        void drain();
      }
    }
  }, [qc, setConflict, syncDocCache]);

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
  }, [setConflict]);

  /**
   * R-D-18「保留我的版本」：以服务端最新版本号为新基线，把本地内容覆盖写回。
   * ★ A3 覆盖前 embed 防丢：先确保单文档缓存是服务端最新正文，比对其中的画布/数据表
   *   内嵌引用是否有「服务端有、本地无」的缺失；有缺失则拦截，不发任何 PUT、保留冲突态，
   *   引导用户改走「查看最新版本」或补回引用后再保存，防止静默抹掉别人已保存的引用。
   *   无缺失时把基线挪到 currentVersion，再经 drain 发 force 保存（仍走单在途串行链）。
   * @returns 是否放行（true=已进入覆盖保存；false=被拦截，调用方无需额外处理，提示已就地给出）
   */
  const keepMineVersion = useCallback(async (): Promise<boolean> => {
    const cur = conflictRef.current;
    if (cur == null) return false;
    const id = docIdRef.current;
    const key = docQueryKey(id);

    // 先确保拿到服务端最新正文：409 时已 invalidate，这里 refetch/ensure 一次；取不到不盲目覆盖。
    let serverDoc: KbDocDTO | undefined;
    try {
      serverDoc = await qc.ensureQueryData<KbDocDTO>({
        queryKey: key,
        queryFn: () => KbApi.doc(id).then((r) => r.doc),
        staleTime: 0,
      });
    } catch {
      toast("暂时无法获取服务端最新内容，请稍后重试「保留我的版本」", "error");
      return false;
    }
    const serverSrc = serverDoc?.content;
    if (typeof serverSrc !== "string") {
      toast("服务端最新内容暂不可用，为避免丢失已阻止覆盖，请稍后重试", "error");
      return false;
    }

    const localSrc = pending.current ?? lastSaved.current;
    const { canvas, tables } = missingEmbeds(serverSrc, localSrc);
    const missingCount = canvas.length + tables.length;
    if (missingCount > 0) {
      // 拦截：不挪基线、不清冲突、不发 PUT，ConflictNotice 保持在屏幕上供用户改选。
      toast(
        `本地版本缺少 ${missingCount} 个画布/表格引用，为避免丢失已阻止覆盖，请改用「查看最新版本」或重新插入后再保存`,
        "error",
      );
      return false;
    }

    // 无引用丢失：基线跟到服务端最新版本，清冲突，把本地内容作为待保存项交给串行链强制发出。
    if (cur.currentVersion != null) versionRef.current = cur.currentVersion;
    setConflict(null);
    pending.current = localSrc;
    // 本地内容可能与 lastSaved 字面相同（冲突期间未再编辑），置 force 保证这一次一定发出 PUT。
    forceRef.current = true;
    void drain();
    return true;
  }, [drain, qc, setConflict]);

  // 内容变更（编辑中高频调用）
  const markDirty = useCallback(
    (content: string) => {
      if (!canEditRef.current) return;
      pending.current = content;
      // ★ yOwned（Y 通道接管，含掉线/重连窗口）：内容真源是 Y.Doc，REST 全面让位（根治 Bug B
      //   掉线误降级、携带过期 baseVersion 撞假 409）。不排防抖 drain、不发 PUT，状态直接 synced。
      //   仍保留一次 saveDraft 作「源码态」崩溃兜底：源码模式（SourceEditor 纯 textarea，无 Y 绑定）
      //   的文字改动在切回所见即所得前不进 Y.Doc，这份整篇草稿是其唯一落地兜底；Y 接管期间不弹
      //   恢复条（见加载 effect），内容经 Y 合并确认后由页面 localMergedTick 清掉该草稿键。
      if (yOwnedRef.current) {
        if (debounce.current) clearTimeout(debounce.current);
        // P1-2：source 模式（SourceEditor 纯 textarea、无 Y 绑定）下的 markDirty 改动不进 Y.Doc，
        // 给草稿打 sourceUnmerged 标记——加载/接管切换 effect 据此保留恢复入口，且 gx-y 合并确认
        // （clearDraftUnlessSourceUnmerged）不会误清它。非 source 的 markDirty 不带标记，同 key 再次
        // 写入即自然解除（如切回所见即所得后 Y 回放覆盖写入普通草稿）。
        if (sourceModeRef.current) {
          saveDraft(docIdRef.current, {
            content,
            baseContent: baseContent.current,
            sourceUnmerged: true,
          });
        } else {
          saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
        }
        setStatus("synced");
        return;
      }
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
      // 冲突待裁决期间不自动续发：只更新 pending 与草稿，等用户二选一后再保存，避免重复 409。
      if (conflictRef.current != null) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        void drain();
      }, 1200);
    },
    [drain],
  );

  // 手动保存（按钮）：把最新内容送入串行链；若已有 PUT 在途，drain 入口直接 return，
  // 最新内容已在 pending 中，会被在途链顺带消费——绝不与在途 PUT 并行发第二个请求。
  const saveNow = useCallback(async () => {
    if (debounce.current) clearTimeout(debounce.current);
    // ★ yOwned（Y 通道接管，含掉线/重连）：绝不发整篇 PUT——即便此刻 collabActive 因 WS 短暂掉线
    //   为 false 也不放行（Bug B 正是这个窗口用过期 baseVersion 撞假 409）。给协同态反馈即可。
    // 协同可用：内容随打随同步，服务端统一落库 —— 不再发整篇 PUT。
    // 但必须给反馈：按钮点了没反应是"反馈缺失"，用户会怀疑没保存上。
    if (yOwnedRef.current || collabActiveRef.current) {
      setStatus("synced");
      toast("已在协同中实时同步，无需手动保存", "success");
      return;
    }
    if (conflictRef.current != null) return; // 冲突待裁决：不绕过冲突态强发
    if (!canEditRef.current) return;
    const content = pending.current ?? lastSaved.current;
    pending.current = content;
    // 挂一次手动保存成功提示：无论本次是否并入已在途的链，排空时都只兑现一次 toast。
    manualNotifyRef.current = true;
    await drain();
  }, [drain]);

  // 同步 flush（卸载/切路由/关页面）：用 keepalive fetch 尽力带走，页面不阻塞；草稿已先行兜底。
  // ★ A2：若 drain 正有 PUT 在途，直接返回——绝不再发一个携带相同 baseVersion 的 PUT 自撞 409；
  //   在途那一轮本身就带着最新 pending，成功后会清草稿/同步缓存，flush 无需重复。
  const flush = useCallback(() => {
    if (inFlightRef.current) return;
    // ★ yOwned（Y 通道接管，含掉线/重连窗口）：卸载/切路由/关页面也绝不发整篇 keepalive PUT——
    //   既避免本地快照与 CRDT 抢写（DESIGN §3.3），也杜绝用过期 baseVersion 在冷归结后撞假 409。
    //   最新内容已由 markDirty 逐次 saveDraft 落盘（源码态崩溃安全网），此处无需再写草稿，直接返回。
    if (yOwnedRef.current) return;
    const content = pending.current;
    if (content == null || content === lastSaved.current || !canEditRef.current) return;
    // 先留草稿兜底（即使网络请求没发出去也不丢）
    saveDraft(docIdRef.current, { content, baseContent: baseContent.current });
    // 协同可用：整篇 PUT 会让本地快照与 CRDT 抢写（DESIGN §3.3），flush 一并让位
    if (collabActiveRef.current) return;
    // 冲突待裁决：卸载兜底也不得绕过乐观锁强发，交由草稿在下次打开时恢复/裁决。
    if (conflictRef.current != null) return;
    try {
      // S2：同步读当前数据源拼 URL/头（flush 可能在卸载关页时触发，不能 async 化）。
      const dsUrl = dataSourceResolver.baseFor(
        `/api/kb/docs/${docIdRef.current}/content`,
      );
      const dsHeaders = dataSourceResolver.headers();
      void fetch(dsUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...dsHeaders },
        body: JSON.stringify({ content, baseVersion: versionRef.current }),
        keepalive: true,
      })
        .then(async (r) => {
          if (r.ok) {
            lastSaved.current = content;
            let cv: number | null = null;
            try {
              const j = (await r.json()) as { contentVersion?: number | null };
              if (j.contentVersion != null) {
                versionRef.current = j.contentVersion;
                cv = j.contentVersion;
              }
            } catch { /* 版本号缺失不影响 */ }
            clearDraft(docIdRef.current);
            // A2 补第三参：连同 contentVersion 一起回写缓存，避免切回时读到旧版本号
            syncDocCache(docIdRef.current, content, cv);
          }
        })
        .catch(() => {});
    } catch {
      /* 草稿已兜底 */
    }
  }, [syncDocCache]);

  // 卸载 / 关闭页面前 flush：先清掉挂起的防抖定时器，避免卸载后定时器再触发 drain，
  // 再做一次同步 flush 尽力带走未落库内容。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (debounce.current) clearTimeout(debounce.current);
      flush();
      // P2-2：yOwned 接管下内容归 Y/gx-y 累积、source 改动另有整篇草稿兜底，且顶栏显示「已同步」，
      // 再弹原生「离开将丢失未保存更改」与已同步自相矛盾。故追加 !yOwnedRef，接管态绝不弹离开确认框。
      if (
        !yOwnedRef.current &&
        pending.current != null &&
        pending.current !== lastSaved.current
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onHide = () => {
      if (debounce.current) clearTimeout(debounce.current);
      flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onHide);
      if (debounce.current) clearTimeout(debounce.current);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
