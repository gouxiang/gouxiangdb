// apps/web/src/components/feedback.tsx
// 阶段 3 · 确认弹窗危险分级（UI-SPEC v1.0 R-D-23 / R-D-24）
//
//   R-D-23 危险操作分级：
//     L1 无确认        —— 切换视图、展开折叠等随时可反悔的操作
//     L2 普通确认弹窗   —— 可恢复的批量操作（软删除、归档）
//     L3 需输入名称确认 —— 删除库 / 删除表这类大范围不可逆入口
//     L4 不可恢复红色确认 —— 彻底删除、清空回收站
//     L5 需二次勾选 + 输入 —— 注销工作区、销毁密钥等毁灭级
//   R-D-24 确认弹窗主按钮文案必须是**具体动词**（「彻底删除」「清空回收站」），
//          禁止「确定 / OK / 是」这种无信息量的词。
//
// 用法（不新增依赖，纯 Promise + 模块级宿主，与 toast 同一套路）：
//   const ok = await confirmAction({
//     title: "删除 3 条记录",
//     confirmText: "删除 3 条记录",
//     level: 2,
//     description: "记录会先进入回收站，30 天内可恢复。",
//   });
//   if (ok) { ... }
//
// 宿主 <ConfirmHost /> 必须在应用根挂载一次（见 main.tsx）。

import { useEffect, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button, FOCUS_RING, Modal } from "./ui";
import { Icon } from "./icons";

/** R-D-23 危险分级：1 最轻，5 最重。 */
export type DangerLevel = 1 | 2 | 3 | 4 | 5;

export interface ConfirmOptions {
  /** 弹窗标题（说清对象，如「删除视图「按状态分组」」） */
  title: ReactNode;
  /** R-D-24 主按钮文案：必须是具体动词 + 对象名，禁止「确定」 */
  confirmText: string;
  /** 危险分级，缺省 L2（普通确认） */
  level?: DangerLevel;
  /** 正文说明：后果 + 是否可恢复 */
  description?: ReactNode;
  /** L3 / L5：需用户原样输入该名称才能确认（如库名 / 表名） */
  confirmName?: string;
  /** L5：二次勾选文案（毁灭级确认） */
  acknowledgeText?: string;
  /** 次按钮文案，缺省「取消」 */
  cancelText?: string;
  /** 对象数量（用于「删除 3 条记录」这类文案的语义补充，可选） */
  count?: number;
}

interface PendingConfirm extends ConfirmOptions {
  level: DangerLevel;
  resolve: (ok: boolean) => void;
}

let pending: PendingConfirm | null = null;
const confirmListeners = new Set<() => void>();

function emitConfirm() {
  for (const l of confirmListeners) l();
}

/**
 * 请求一次确认。L1 直接放行（不弹窗）。
 * 同一时刻只允许一个确认挂起：新的请求会把旧的按「取消」结算，避免 Promise 悬挂。
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const level = options.level ?? 2;
  if (level <= 1) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    pending?.resolve(false);
    pending = { ...options, level, resolve };
    emitConfirm();
  });
}

/** L2 软删除类快捷入口：可恢复，普通确认。 */
export function confirmSoftDelete(opts: Omit<ConfirmOptions, "level"> & { level?: 2 }): Promise<boolean> {
  return confirmAction({ ...opts, level: 2 });
}

/** L4 彻底删除 / 清空回收站：不可恢复，红色确认。 */
export function confirmIrreversible(opts: Omit<ConfirmOptions, "level">): Promise<boolean> {
  return confirmAction({ ...opts, level: 4 });
}

/**
 * 「关闭会丢失未保存改动」确认（R-F-20「表单有未保存改动时，关闭弹窗/抽屉需二次确认」）。
 *
 * 走 L2 普通确认即可（改动还没丢，用户只是被拦一下）。
 *
 * 替换原生 `window.confirm` 的两个理由：
 *   ① 原生 confirm 在自动化测试环境（jsdom / node 无 UI 实现）会挂死或恒返回默认值，
 *      关闭路径因此无法被断言——这是本次替换的现实动因；
 *   ② 原生弹窗文案与按钮不可控，与 R-D-24「主按钮必须是具体动词」冲突。
 *
 * @returns true = 用户确认放弃改动，调用方应继续关闭；false = 保留当前弹窗。
 */
export function confirmDiscardChanges(opts?: {
  /** 覆盖说明文案（默认说明"未保存的改动会被丢弃"） */
  description?: ReactNode;
  /** 覆盖主按钮文案（默认「放弃改动」，具体动词，不用「确定」） */
  confirmText?: string;
  /** 次按钮文案，默认「继续编辑」（比「取消」更贴合语境） */
  cancelText?: string;
}): Promise<boolean> {
  return confirmAction({
    title: "放弃未保存的改动？",
    confirmText: opts?.confirmText ?? "放弃改动",
    cancelText: opts?.cancelText ?? "继续编辑",
    level: 2,
    description: opts?.description ?? "关闭后这些改动不会保存，也无法找回。",
  });
}

/**
 * 清空表数据（R-D-23 L3）。
 *
 * 与「删除数据表」不同：服务端 `POST /tables/:id/clear` 是**软删**全部记录（进回收站，
 * 30 天内可恢复），但只回 `{ ok: true }`，**不返回被清掉的 id 列表**——因此做不出
 * 「一键撤销」的 toast（不知道该恢复哪些）。故：
 *   - 升到 L3（需原样输入表名）而不是 L2，用强度补偿缺失的撤销；
 *   - 文案明说「没有一键撤销，需到回收站逐条恢复」，不谎称可撤销（R-D-22 的精神是
 *     「删除必须给用户退路」，退路在回收站，不是假按钮）。
 */
export function confirmClearTable(opts: { tableName: string; scopedToView?: boolean }): Promise<boolean> {
  return confirmAction({
    title: `清空「${opts.tableName}」的数据`,
    confirmText: "清空数据",
    cancelText: "取消",
    level: 3,
    confirmName: opts.tableName,
    description: `${opts.scopedToView ? "当前视图内" : "整张表"}的记录会被清空并移入回收站，30 天内可在回收站恢复。清空没有一键撤销，需要在回收站逐条恢复。`,
  });
}

/**
 * R-D-23 分级 → 确认强度的纯映射（抽出来便于单测，组件内部同样走它）。
 * L1 无确认（不弹窗）；L2 普通；L3 需输入名称；L4 不可恢复红色；L5 勾选 + 输入。
 */
export interface ConfirmGate {
  /** 是否弹窗（L1 为 false） */
  modal: boolean;
  /** L3+：需原样输入名称 */
  needName: boolean;
  /** L5：需二次勾选 */
  needCheck: boolean;
  /** L4+：主按钮走 danger 红底 */
  danger: boolean;
}

export function confirmGateFor(
  level: DangerLevel,
  o: { confirmName?: string; acknowledgeText?: string },
): ConfirmGate {
  return {
    modal: level >= 2,
    needName: level >= 3 && typeof o.confirmName === "string" && o.confirmName.length > 0,
    needCheck: level >= 5 && typeof o.acknowledgeText === "string" && o.acknowledgeText.length > 0,
    danger: level >= 4,
  };
}

function ConfirmBody({
  req,
  onDone,
}: {
  req: PendingConfirm;
  onDone: (ok: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [checked, setChecked] = useState(false);

  const gate = confirmGateFor(req.level, req);
  const nameOk = !gate.needName || name.trim() === (req.confirmName ?? "").trim();
  const blocked = !nameOk || (gate.needCheck && !checked);
  const danger = gate.danger;

  return (
    <div className="flex flex-col gap-3">
      {req.description && (
        <div className="text-gx-13 leading-5 text-gx-text-secondary">{req.description}</div>
      )}

      {gate.needName && (
        <label className="flex flex-col gap-1.5">
          <span className="text-gx-12 text-gx-text-secondary">
            请输入 <span className="font-medium text-gx-text-primary">{req.confirmName}</span> 以确认
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={req.confirmName}
            className={clsx(
              "h-8 w-full rounded-gx-lg border bg-gx-surface px-2.5 text-gx-13 text-gx-text-primary",
              "placeholder:text-gx-text-hint transition-colors duration-[120ms]",
              nameOk ? "border-gx-border hover:border-gx-border-strong" : "border-gx-danger",
              "focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50",
            )}
          />
        </label>
      )}

      {gate.needCheck && (
        <label className="flex items-start gap-2 text-gx-12 text-gx-text-secondary">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-gx-accent"
          />
          <span>{req.acknowledgeText}</span>
        </label>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setName("");
            setChecked(false);
            onDone(false);
          }}
        >
          {req.cancelText ?? "取消"}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          size="sm"
          disabled={blocked}
          disabledReason={
            !nameOk
              ? `请输入「${req.confirmName}」以确认`
              : gate.needCheck && !checked
                ? "请先勾选确认"
                : undefined
          }
          onClick={() => {
            setName("");
            setChecked(false);
            onDone(true);
          }}
        >
          {req.confirmText}
        </Button>
      </div>
    </div>
  );
}

/**
 * 确认弹窗宿主：全局挂一次。
 * 渲染落在 <Modal> 内，复用统一浮层规格（宽 480 / 圆角 12 / 遮罩 / 阴影 lg）。
 */
export function ConfirmHost() {
  const [req, setReq] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    const l = () => setReq(pending);
    confirmListeners.add(l);
    return () => {
      confirmListeners.delete(l);
    };
  }, []);

  if (!req) return null;

  const close = (ok: boolean) => {
    const cur = pending;
    pending = null;
    cur?.resolve(ok);
    setReq(null);
    emitConfirm();
  };

  const danger = req.level >= 4;

  return (
    <Modal
      open
      // P0-④a：确认弹窗要能盖在画布/文档编辑弹窗（gx-z-canvas-modal 820）之上，
      // 否则「关闭编辑弹窗时的二次确认」整个被编辑弹窗挡住（看不见也点不到）。
      // 抬高确认层而不是调低 canvas-modal —— 后者本就该压住页面内容。
      zClass="gx-z-modal-nested"
      onClose={() => close(false)}
      title={
        <span className="flex items-center gap-2">
          {danger && <Icon name="alertCircle" size={15} className="text-gx-danger" />}
          {req.title}
        </span>
      }
      width={480}
    >
      <ConfirmBody req={req} onDone={close} />
    </Modal>
  );
}
