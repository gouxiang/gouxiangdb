// 授权 UI 数据 hooks（react-query）。范式参考 features/update/update-hooks.ts。
//
// 纪律：
//   - useLicenseStatus 30s 轮询；off/404/网络失败一律回落 available:false 稳定兜底，
//     不向上抛红色错误（授权是旁路能力，绝不能因为授权口不可用而炸主界面）；
//   - activate/refresh/import 的「接收链拒绝」是 resolve（outcome.ok=false），
//     只有 HTTP/网络错误才 reject；成功（ok=true）才 invalidate status；
//   - 反馈轮询 60s；status.feedback 角标随 status 30s 刷新。
import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  LicenseContactInput,
  LicenseOutcomeDTO,
  LicenseStatusDTO,
  LicenseSyncResultDTO,
} from "@gx/shared-types";
import {
  LicenseApi,
  isLicenseDisabled,
  type FeedbackPollView,
} from "../../api/license";
import { useLicenseGateStore } from "../../store/licenseGate";
import { useActiveSession } from "../../node/activeSession";

export const LICENSE_QK = {
  status: ["license", "status"] as const,
  feedback: ["license", "feedback"] as const,
};

/** off/未 boot 的稳定兜底（字段补齐，组件无需到处判 undefined）。 */
export const LICENSE_DISABLED_STATUS: LicenseStatusDTO = {
  available: false,
  mode: "off",
  verdict: "bypassed",
  verdictLabel: "未启用授权",
  seats: null,
  usedSeats: null,
  isAdmin: false,
  adminEmail: null,
  orgName: null,
  licensedTo: null,
  expiresAt: null,
  version: null,
  everCommercial: false,
  fingerprintShort: "",
  baseUrl: "",
  online: false,
  lastHeartbeatAt: null,
  lastAttemptAt: null,
  syncing: false,
  deploymentId: null,
  platform: null,
  feedback: { unread: 0, open: 0 },
};

const STATUS_POLL_MS = 30_000;
const FEEDBACK_POLL_MS = 60_000;

/** useLicenseStatus 的返回：data 恒为完整 DTO（未加载/失败时是 off 兜底），绝不 undefined。 */
export type LicenseStatusResult = Omit<UseQueryResult<LicenseStatusDTO>, "data"> & {
  data: LicenseStatusDTO;
};

/** GET /status + 稳定兜底；随状态恢复自动解除挂起态。 */
export function useLicenseStatus(): LicenseStatusResult {
  const session = useActiveSession();
  const clearSuspended = useLicenseGateStore((s) => s.clearSuspended);
  // 授权 BFF 所有端点都要登录态：未认证（/login、/launcher、公开分享/邀请页）绝不发请求，
  // 否则 /status 401 会被 apiFetch 当作会话失效处理，把用户从豁免页硬跳走。
  const authenticated = session.authenticated;
  const q = useQuery<LicenseStatusDTO>({
    queryKey: LICENSE_QK.status,
    enabled: authenticated,
    queryFn: async () => {
      try {
        const data = await LicenseApi.status();
        // 后端 off 回包只带部分字段，与兜底合并保证形状完整；available=true 时字段齐全。
        return { ...LICENSE_DISABLED_STATUS, ...data };
      } catch (e) {
        if (isLicenseDisabled(e)) return LICENSE_DISABLED_STATUS;
        throw e;
      }
    },
    // 网络错/500 不弹红、不重试轰炸：回落兜底，等下一个 30s 轮询自然恢复。
    retry: false,
    refetchInterval: authenticated ? STATUS_POLL_MS : false,
    staleTime: 10_000,
  });

  const status = q.data;
  // 裁决离开 {expired,invalid}（续费/刷新/激活成功）或授权关闭：立即解除全屏挂起。
  // verdict 仍是 expired/invalid 时不主动 clear——该用户可能确实还在挂起名单内。
  useEffect(() => {
    if (!status) return;
    if (!status.available || (status.verdict !== "expired" && status.verdict !== "invalid")) {
      clearSuspended();
    }
  }, [status, clearSuspended]);

  // 对消费方永远暴露稳定对象：未加载/失败期间 data 也是 available:false 兜底（非 undefined），
  // 故各组件无需到处判空；函数返回类型已显式收窄为 data 必有值的形状。
  return { ...q, data: q.data ?? LICENSE_DISABLED_STATUS };
}

/** 成功（单据变化）后让状态面板与席位立即重算；失败/拒绝不动缓存。 */
function useEntitlementMutation<TData, TVars>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation<TData, unknown, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LICENSE_QK.status });
    },
  });
}

/**
 * 免输入「立即同步」。与 activate/refresh 不同：接收链拒绝是 resolve(out.ok=false)，
 * 只有真把单据同步下来（out.ok=true）才刷新 /status；HTTP/网络错走 reject（调用方 toast）。
 */
export function useSync() {
  const qc = useQueryClient();
  return useMutation<LicenseSyncResultDTO, unknown, void>({
    mutationFn: () => LicenseApi.sync(),
    onSuccess: (out) => {
      if (out.ok) {
        void qc.invalidateQueries({ queryKey: LICENSE_QK.status });
      }
    },
  });
}

export function useImportOffline() {
  return useEntitlementMutation<LicenseOutcomeDTO, { code: string }>(({ code }) =>
    LicenseApi.importOffline({ code }),
  );
}

export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, unknown, LicenseContactInput>({
    mutationFn: (input) => LicenseApi.updateContact(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LICENSE_QK.status });
    },
  });
}

// ============ 反馈中心 ============

export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: LicenseApi.submitFeedback,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LICENSE_QK.status });
      void qc.invalidateQueries({ queryKey: LICENSE_QK.feedback });
    },
  });
}

export function useReplyFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ticketId: string; content: string; files?: File[] }) =>
      LicenseApi.replyFeedback(vars.ticketId, vars.content, vars.files ?? []),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LICENSE_QK.feedback });
    },
  });
}

/**
 * 工单轮询（/feedback/poll，60s）。
 * @param enabled 授权可用（available=true）才轮询；off 时不发请求。
 * @param sinceMs 增量游标（null/undefined = 首次全量）。
 */
export function usePollFeedback(enabled: boolean, sinceMs: number | null) {
  return useQuery<FeedbackPollView>({
    queryKey: [...LICENSE_QK.feedback, sinceMs ?? 0],
    queryFn: () => LicenseApi.pollFeedback(sinceMs ?? undefined),
    enabled,
    retry: false,
    refetchInterval: enabled ? FEEDBACK_POLL_MS : false,
    staleTime: 30_000,
  });
}
