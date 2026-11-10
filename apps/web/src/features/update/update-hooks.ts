// 系统更新面板 hooks（DESIGN §6.3）：手动触发的检查 + 换票后原生导航下载。
//
// 纪律：
//   - 面板挂载【不】自动请求（enabled:false），由 owner 点「检查更新」手动触发，避免内网无外网时
//     每次进设置都打一次超时请求；
//   - 下载不走 fetch：createDownloadTicket 成功后 window.location.assign(withBase(downloadPath))，
//     浏览器以 Content-Disposition 接收文件，不会跳走当前页面；
//   - off 态（路由不注册 → 404）按「未注册功能」处理：面板用于判断是否隐藏分区，不弹错误。
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdatePrefetchDTO, UpdateStatusDTO } from "@gx/shared-types";
import {
  AdminUpdateApi,
  ApiError,
  ApiTimeoutError,
  withBase,
} from "../../api/client";
import { prefetchActionMessage, updateErrorMessage } from "./update-copy";
import { resolveDesktopUpdateIdentity } from "./desktopIdentity";

export const UPDATE_QK = {
  status: ["admin", "update", "status"] as const,
} as const;

/**
 * 两个共用 UPDATE_QK.status 的 useQuery 必须用【同一个】queryFn，防止同 key 身份漂移。
 * 非壳环境 resolveDesktopUpdateIdentity() 恒为 null，status(null) 经可选链全部归 undefined，
 * 生成的请求 URL 与历史无参调用逐字一致（现网零变化）；仅物理桌面壳内才带 channel/arch/platform。
 */
const statusQueryFn = async () =>
  AdminUpdateApi.status((await resolveDesktopUpdateIdentity()) ?? undefined);

/** 从 ApiError 体里取 code（与 pat-hooks.normalizePatError 同口径）。 */
function errorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  }
  return null;
}

/** 404＝更新功能未注册（GX_UPDATE_ENABLED=off / 非企业面挂载缺失）；面板据此隐藏分区。 */
export function isUpdateNotEnabled(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

export function useUpdateStatus() {
  const q = useQuery({
    queryKey: UPDATE_QK.status,
    queryFn: statusQueryFn,
    // 手动触发：挂载不请求，refetch() 即「检查更新」；后端另有 5 分钟 TTL 缓存。
    enabled: false,
    staleTime: 30_000,
    retry: false,
  });
  return {
    ...q,
    /** 「检查更新 / 重新检查」：强制旁路后端 TTL 缓存（force=1）。 */
    check: () => q.refetch(),
  };
}

export interface DownloadResult {
  /** 已触发浏览器原生导航下载。 */
  navigated: true;
  filename: string | null;
}

/**
 * 换票 → 原生导航下载。成功后浏览器接管下载，按钮恢复可点；失败由调用方 toast。
 * @param onNavigate 可选回调（测试用来拦截 window.location.assign）。
 */
export function useUpdateDownload(onNavigate?: (href: string) => void) {
  return useMutation<DownloadResult, unknown, void>({
    mutationFn: async () => {
      const identity = (await resolveDesktopUpdateIdentity()) ?? undefined;
      const ticket = await AdminUpdateApi.createDownloadTicket(identity);
      const href = withBase(ticket.downloadPath);
      if (onNavigate) {
        onNavigate(href);
      } else {
        // Content-Disposition=attachment：浏览器保存文件而不卸载当前 SPA。
        window.location.assign(href);
      }
      // downloadPath 形如 /api/v1/admin/update/download?ticket=…，不含文件名；
      // 文件名由响应头给出，这里仅在有需要时回传 null 占位（展示不依赖它）。
      return { navigated: true as const, filename: null };
    },
  });
}

/** 归一错误为中文短句（检查 / 换票两处共用）。 */
export function describeUpdateError(e: unknown): string {
  if (e instanceof ApiTimeoutError) return updateErrorMessage(e, () => "UPDATE_SOURCE_TIMEOUT");
  return updateErrorMessage(e, errorCode);
}

// ---------------------------------------------------------------------------
// 方案 A：后台预缓存（owner 触发后端在 NAS 本地分块预拉；就绪后下载本地秒取）
// ---------------------------------------------------------------------------

/** running 态轮询间隔：非 force status（后端只对 update 结论做 5 分钟 TTL 缓存，
 *  prefetch 快照每次实时附加），故高频轮询不会反复打上游。 */
const PREFETCH_POLL_MS = 1000;

export interface UseUpdatePrefetch {
  /** 当前 status 缓存里的预缓存快照（可能为 null：旧端/未检查）。 */
  prefetch: UpdatePrefetchDTO | null;
  /** 触发一次后台预下载（幂等：后端对 running/ready 分别返回 202/200）。 */
  startPrefetch: () => void;
  isStarting: boolean;
  /** 触发动作本身的错误中文短句（409 busy / 网络等）；非后台下载失败（后者在快照里）。 */
  startError: string | null;
  /** 最近一次触发的受理结果（onSuccess 后才有），供面板一次性 toast；busy 走 startError。 */
  lastDecision: "started" | "running" | "ready" | "busy" | null;
}

/**
 * 预缓存控制器：
 *  - 通过【同一个】status queryKey 订阅缓存，enabled:false 表示本 hook 挂载不主动请求，
 *    只实时读取面板检查后（或轮询回写后）缓存里的 prefetch 快照；
 *  - startPrefetch 成功后立即把受理快照并入 status 缓存，UI 秒切 running，不必等首个轮询；
 *  - running 期间每 1s 做一次【非 force】status refetch；ready/failed 即自动停轮询。
 */
export function useUpdatePrefetch(): UseUpdatePrefetch {
  const qc = useQueryClient();
  const statusQ = useQuery({
    queryKey: UPDATE_QK.status,
    queryFn: statusQueryFn,
    enabled: false,
    staleTime: 30_000,
    retry: false,
  });
  const { refetch } = statusQ;
  const prefetch = statusQ.data?.prefetch ?? null;
  const running = prefetch?.state === "running";

  const mutation = useMutation({
    mutationFn: async () =>
      AdminUpdateApi.startPrefetch((await resolveDesktopUpdateIdentity()) ?? undefined),
    onSuccess: (res) => {
      // 受理即回写：running/ready 立刻反映，避免首个 1s 轮询前的空窗。
      qc.setQueryData<UpdateStatusDTO>(UPDATE_QK.status, (old) =>
        old ? { ...old, prefetch: res.prefetch } : old,
      );
    },
  });

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      // 非 force：结论走后端 TTL 缓存，prefetch 快照实时，不重复打上游。
      void refetch();
    }, PREFETCH_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refetch]);

  return {
    prefetch,
    startPrefetch: () => mutation.mutate(),
    isStarting: mutation.isPending,
    startError: mutation.error ? prefetchActionMessage(mutation.error) : null,
    lastDecision: mutation.data?.decision ?? null,
  };
}
