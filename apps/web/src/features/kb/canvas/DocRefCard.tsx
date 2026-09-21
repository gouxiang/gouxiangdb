// apps/web/src/features/kb/canvas/DocRefCard.tsx
// 画布节点角标关联卡（B 形态，KB-EDITOR-ROUND-5 瘦身为纯几何/尺寸适配层）。
// 取数 / body / 编辑弹窗全部收敛到 RefEmbedCard；本文件只保留：
//   - localStorage 尺寸持久化（gx-canvas-refsize-<nodeId>，默认 380×300，min 280×200）
//   - window pointermove/up 拖拽（liveSize 闭包防快速松手写旧值）
//   - 节点右侧 / 翻左兜底定位
//   - 跳转 navigate、onClose、右下角 resize 手柄

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCanvasBoard, type ScreenRect } from "./canvas-context";
import type { GxDocRef } from "./types";
import { RefEmbedCard } from "./RefEmbedCard";
import { gxRefNavTarget } from "./gx-ref-target";

const MIN_W = 280;
const MIN_H = 200;

function sizeStorageKey(nodeId: string) {
  return `gx-canvas-refsize-${nodeId}`;
}

export function DocRefCard({
  nodeId,
  ref_,
  nodeRect,
  canEdit,
  kbId,
  publicToken,
  onClose,
}: {
  nodeId: string;
  ref_: GxDocRef;
  nodeRect: ScreenRect;
  canEdit: boolean;
  kbId?: string;
  publicToken?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const rt = useCanvasBoard();
  // 裁剪层尺寸：nodeRect 已是裁剪层本地坐标，钳制边界用裁剪层宽高（嵌套画布不溢出框体）
  const vw = rt?.viewport.width || window.innerWidth;
  const vh = rt?.viewport.height || window.innerHeight;

  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(sizeStorageKey(nodeId));
      if (raw) {
        const p = JSON.parse(raw) as { w?: number; h?: number };
        return { w: p.w ?? 380, h: p.h ?? 300 };
      }
    } catch { /* ignore */ }
    return { w: 380, h: 300 };
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // resize 手柄元素：拖拽期间对其 setPointerCapture，使 pointermove 目标锁定在手柄、
  // 传播路径绕开卡片 body 里那张内嵌只读画布（它在捕获阶段 stopPropagation pointermove，
  // 否则向缩小方向（鼠标移入卡片）时 window 收不到 move，表现为"只能放大不能缩小"）。
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  // 拖拽调尺寸：pointer 事件挂 window；松手时持久化一次
  useEffect(() => {
    // 拖拽过程中的最新尺寸用闭包变量实时保存：setSize 的重渲染是异步的，
    // 若 onUp 紧接最后一次 onMove（快速松手），sizeRef.current 仍是旧值，
    // 会把初始 380×300 错误持久化到 localStorage。
    let liveSize: { w: number; h: number } | null = null;
    function onMove(e: PointerEvent) {
      const st = resizeStartRef.current;
      if (!st) return;
      liveSize = {
        w: Math.max(MIN_W, st.w + (e.clientX - st.x)),
        h: Math.max(MIN_H, st.h + (e.clientY - st.y)),
      };
      setSize(liveSize);
    }
    function onUp(e: PointerEvent) {
      if (!resizeStartRef.current) return;
      resizeStartRef.current = null;
      try {
        // 优先用拖拽中的实时尺寸，兜底 sizeRef（异常序列时）
        localStorage.setItem(sizeStorageKey(nodeId), JSON.stringify(liveSize ?? sizeRef.current));
      } catch { /* ignore */ }
      document.body.style.userSelect = "";
      liveSize = null;
      // 释放指针捕获（手柄可能已随重渲染更换，容错处理）
      try {
        resizeHandleRef.current?.releasePointerCapture?.(e.pointerId);
      } catch { /* ignore */ }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [nodeId]);

  function startResize(e: React.PointerEvent) {
    if (!canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    const s = sizeRef.current;
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: s.w, h: s.h };
    // 关键：锁定指针到手柄，绕开内嵌画布对 pointermove 的捕获期拦截（见上注释）
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      resizeHandleRef.current = e.currentTarget as HTMLDivElement;
    } catch { /* ignore */ }
    document.body.style.userSelect = "none";
  }

  // 位置：跟随节点；默认右侧，右缘空间不足翻左侧，再不足贴节点左上角。
  // 边界统一用裁剪层（nodeRect 已是裁剪层本地坐标），画布嵌在弹窗/分栏时也不溢出框体。
  const margin = 24;
  let x = nodeRect.x + nodeRect.width + margin;
  if (x + size.w > vw - 12) x = nodeRect.x - size.w - margin;
  if (x < 12) x = Math.max(12, Math.min(nodeRect.x, Math.max(12, vw - size.w - 12)));
  let y = Math.max(12, nodeRect.y - 20);
  if (y + size.h > vh - 12) y = Math.max(12, vh - size.h - 12);

  // doc/canvas 的旧跳转形（单一真源，勿改形）；table 的目标在数据表侧。
  const docTarget = ref_.kind === "canvas" ? `/kb/${kbId}/canvas/${ref_.docId}` : `/kb/${kbId}/doc/${ref_.docId}`;
  const navTarget = ref_.kind === "table" ? gxRefNavTarget(ref_, kbId) : kbId ? docTarget : null;

  function jump() {
    if (navTarget) navigate(navTarget);
  }

  return (
    <RefEmbedCard
      gxRef={ref_}
      kbId={kbId}
      publicToken={publicToken}
      canEdit={canEdit}
      containerClassName="gx-z-canvas-card absolute flex flex-col overflow-hidden rounded-gx-lg border border-gx-separator bg-gx-surface shadow-2xl"
      containerStyle={{ left: x, top: y, width: size.w, height: size.h }}
      onContainerPointerDown={(e) => e.stopPropagation()}
      jumpEnabled={!!navTarget}
      onJump={jump}
      onClose={onClose}
      trailingNode={
        // 仅可编辑时提供 resize：viewer 公开页 pointerdown 被只读层拦截，拖不动也不应误导
        canEdit ? (
          <div
            ref={resizeHandleRef}
            className="absolute bottom-0 right-0 z-10 flex h-4 w-4 touch-none cursor-nwse-resize items-center justify-center text-gx-text-hint hover:text-gx-accent"
            onPointerDown={startResize}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </div>
        ) : null
      }
    />
  );
}
