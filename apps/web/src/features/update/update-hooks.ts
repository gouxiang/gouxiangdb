// 系统更新面板 hooks（DESIGN §6.3）：手动触发的检查 + 换票后原生导航下载。
//
// 纪律：
//   - 面板挂载【不】自动请求（enabled:false），由 owner 点「检查更新」手动触发，避免内网无外网时
//     每次进设置都打一次超时请求；
//   - 下载不走 fetch：createDownloadTicket 成功后 window.location.assign(withBase(downloadPath))，
//     浏览器以 Content-Disposition 接收文件，不会跳走当前页面；
//   - off 态（路由不注册 → 404）按「未注册功能」处理：面板用于判断是否隐藏分区，不弹错误。
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AdminUpdateApi,
  ApiError,
  ApiTimeoutError,
  withBase,
} from "../../api/client";
import { updateErrorMessage } from "./update-copy";

export const UPDATE_QK = {
  status: ["admin", "update", "status"] as const,
} as const;

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
    queryFn: () => AdminUpdateApi.status(),
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
      const ticket = await AdminUpdateApi.createDownloadTicket();
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
