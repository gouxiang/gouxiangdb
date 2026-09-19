// M5 语义检索设置面板（role_owner 可见，工作区设置 → 语义检索）：
//   - off（默认，仅本机关键词检索，零外网）/ 云端 单选；无本地模型选项
//   - off->cloud 先弹数据出域二次确认，PATCH 带 confirmCloud:true；409 NEED_CLOUD_CONFIRM 接住
//   - cloud 表单 baseURL/model/batchSize/timeoutMs/并发/重试；dim 仅自建与兼容档可手填
//   - apiKey 密码框只写：GET 只回 configured/source/maskedLast4，轮换/清除两按钮，绝不显示明文
//   - 重建索引二次确认 + 范围选择；409 REINDEX_IN_PROGRESS 中性提示
//   - 检索总门 db 覆盖（search.enabled）：检索接口即时生效，索引 worker 需重启（界面如实标注）
// 非 owner 由父级不挂载本面板；403 在各 hook 静默（不刷错误）。
import { useEffect, useRef, useState } from "react";
import { Button, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  errorCode,
  isForbidden,
  isSearchNotEnabled,
  useClearApiKey,
  useEmbeddingConfig,
  usePatchEmbeddingConfig,
  useRotateApiKey,
  useTestConnection,
} from "./search-admin-hooks";
import { adminErrorMessage, SEARCH_NOT_ENABLED } from "./search-admin-copy";
import { SearchEnableGuide } from "./SearchEnableGuide";
import { buildConfigPatch, validateConfigForm, type ConfigForm } from "./search-config";
import type { EmbeddingMode, EmbeddingProviderKind, SearchEnabledOverride } from "@gx/shared-types";
import { RemoteServiceSection, type RemoteFormValues } from "./EmbeddingRemoteSection";
import {
  ApiKeySection,
  ClearKeyModal,
  CloudConsentModal,
  ReindexSection,
  SearchGateSection,
  SearchModeSection,
} from "./EmbeddingAdminSections";

/** 远端表单初值（配置到达前先渲染空表单，随后由 effect 整体回灌）。 */
const EMPTY_REMOTE_FORM: RemoteFormValues = {
  provider: "cloud",
  baseURL: "",
  model: "",
  batchSize: "",
  timeoutMs: "",
  fieldChunkCap: "",
  dim: "",
  concurrency: "",
  retryMaxAttempts: "",
  retryBaseMs: "",
};

export function EmbeddingSearchPanel({ onReindex }: { onReindex?: () => void }) {
  const configQ = useEmbeddingConfig(true);
  const patch = usePatchEmbeddingConfig();
  const rotate = useRotateApiKey();
  const clearKey = useClearApiKey();
  const testConn = useTestConnection();

  const [mode, setMode] = useState<EmbeddingMode>("off");
  // 远端服务配置表单收敛成一个对象：单一 setForm 入口，避免十一个散装 state 各自同步、
  // 也让"有未保存编辑"只需在一处打标记。
  const [form, setForm] = useState<RemoteFormValues>(EMPTY_REMOTE_FORM);
  const [searchEnabled, setSearchEnabled] = useState<SearchEnabledOverride>("inherit");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  // 用户有未保存编辑时，服务端数据的任何一次重取（保存成功后的失效重取、后台轮询、
  // 改总门触发的重取）都【不许】覆盖表单——否则刚填的并发/维度会被静默打回原值，
  // 表现为"改了没生效"。保存成功后才清标记，让表单与服务端真值重新对齐。
  const dirtyRef = useRef(false);
  /** 任何一次手改都要打标记：从此刻起，服务端数据只能在我主动保存后覆盖我。 */
  function markDirty(): void {
    dirtyRef.current = true;
  }
  /** 保存成功后清标记：允许下一次服务端数据回灌，把归一化后的真值显示出来。 */
  function markSynced(): void {
    dirtyRef.current = false;
  }

  // 配置加载后同步本地表单（apiKey 不回填，只写）
  useEffect(() => {
    const c = configQ.data;
    if (!c || dirtyRef.current) return;
    setMode(c.mode);
    setForm({
      provider: c.provider,
      baseURL: c.baseURL,
      model: c.model,
      batchSize: String(c.batchSize),
      timeoutMs: String(c.timeoutMs),
      fieldChunkCap: String(c.fieldChunkCap),
      dim: c.dimOverride > 0 ? String(c.dimOverride) : "",
      concurrency: String(c.concurrency),
      retryMaxAttempts: String(c.retryMaxAttempts),
      retryBaseMs: String(c.retryBaseMs),
    });
    setSearchEnabled(c.searchGate.override);
  }, [configQ.data]);

  if (configQ.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  const cfg = configQ.data;
  // 子面未启用（配置端点 404 NOT_FOUND）：禁用写操作入口，避免点了没反应。
  const notEnabled = isSearchNotEnabled(configQ.error);

  // 未启用时不渲染整套配置表单——那只会让人点了报"未启用"。直接给可自助执行的开启指引。
  if (notEnabled) {
    return (
      <div className="flex max-w-2xl flex-col gap-5">
        <div className="flex flex-col items-center gap-2 rounded-gx-lg border border-dashed border-gx-border-strong p-6 text-center">
          <Icon name="search" size={22} className="text-gx-text-hint" />
          <div className="text-gx-13 font-medium text-gx-text-secondary">{SEARCH_NOT_ENABLED.title}</div>
          <p className="max-w-sm text-gx-12 text-gx-text-hint">{SEARCH_NOT_ENABLED.body}</p>
        </div>
        <SearchEnableGuide />
      </div>
    );
  }

  /** 收集表单为 patch（apiKey 仅在填了新值时随请求发送，缺省=保持）。 */
  function currentForm(): ConfigForm {
    return { mode, ...form, searchEnabled, apiKey: apiKeyInput };
  }

  /** 提交前显式校验：非法值直接拦下并说清哪一项错，绝不静默丢字段让人以为改了没生效。 */
  function guard(): boolean {
    const err = validateConfigForm(currentForm());
    if (err) {
      toast(err, "error");
      return false;
    }
    return true;
  }

  function buildPatch(nextMode: EmbeddingMode, confirmCloud: boolean) {
    // 必须显式带上目标 mode：本地 state 此刻还是旧值（成功回调里才翻转）。
    return buildConfigPatch({ ...currentForm(), mode: nextMode }, confirmCloud);
  }

  function onError(e: unknown) {
    // 越权静默降级（面板本应 owner 才见），其余给中性可读文案，不暴露实现。
    if (isForbidden(e)) return;
    // 子面未启用：明说"没启用"，不用"稍后重试"误导。
    toast(isSearchNotEnabled(e) ? SEARCH_NOT_ENABLED.toast : adminErrorMessage(errorCode(e)), "error");
  }

  // 切到 cloud：先弹出域确认；切到 off 直接保存（cloud->off 不需确认）。
  function chooseMode(next: EmbeddingMode) {
    if (next === mode) return;
    if (next === "cloud") {
      setConsentOpen(true);
      return;
    }
    setMode("off");
    patch.mutate(buildPatch("off", false), {
      onSuccess: (r) => {
        markSynced();
        toast(r.reindexRequired ? "已关闭，旧索引将在下次重建后更新" : "已保存", "success");
      },
      onError,
    });
  }

  // 出域确认后才真正以 confirmCloud:true 提交；若后端仍回 409（极端竞态）提示先确认。
  function confirmCloudPatch() {
    setConsentOpen(false);
    patch.mutate(buildPatch("cloud", true), {
      onSuccess: (r) => {
        markSynced();
        setApiKeyInput("");
        setMode("cloud");
        toast(
          r.reindexRequired ? "已启用云端语义检索，建议随后重建索引" : "已保存",
          "success",
        );
      },
      onError: (e) => {
        // NEED_CLOUD_CONFIRM：重新打开确认，不报错刷屏
        if (errorCode(e) === "NEED_CLOUD_CONFIRM") {
              setConsentOpen(true);
          return;
        }
        onError(e);
      },
    });
  }

  function saveCloudForm() {
    if (!guard()) return;
    patch.mutate(buildPatch("cloud", true), {
      onSuccess: (r) => {
        markSynced();
        setApiKeyInput("");
        toast(r.reindexRequired ? "已保存，建议随后重建索引" : "已保存", "success");
      },
      onError,
    });
  }

  /** 只提交总门覆盖，避免误带上未确认的云配置。 */
  function saveGate(next: SearchEnabledOverride) {
    const prev = searchEnabled;
    setSearchEnabled(next);
    patch.mutate({ searchEnabled: next }, {
      onSuccess: () => {
        toast(
          next === "inherit"
            ? "已恢复跟随环境变量（索引 worker 需重启生效）"
            : "已保存：检索接口即时生效，索引 worker 需重启 API 服务后生效",
          "success",
        );
      },
      onError: (e) => {
        setSearchEnabled(prev);
        onError(e);
      },
    });
  }

  function submitRotate() {
    const key = apiKeyInput.trim();
    if (!key) {
      toast("请先在下方输入新的密钥", "info");
      return;
    }
    rotate.mutate(key, {
      onSuccess: () => {
        setApiKeyInput("");
        toast("密钥已更新", "success");
      },
      onError,
    });
  }

  function submitClear() {
    clearKey.mutate(undefined, {
      onSuccess: () => {
        setClearConfirm(false);
        toast("已清除保存的密钥", "success");
      },
      onError,
    });
  }

  const busy = patch.isPending || rotate.isPending || clearKey.isPending;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <SearchModeSection mode={mode} onChoose={chooseMode} />

      {mode === "cloud" && cfg && (
        <RemoteServiceSection
          values={form}
          onPatch={(p) => {
            // 任一字段变动都算"有未保存编辑"：从此刻起后台重取不许覆盖表单。
            setForm((f) => ({ ...f, ...p }));
            markDirty();
          }}
          liveDim={cfg.dim}
          probe={{
            result: testConn.data,
            pending: testConn.isPending,
            failed: testConn.isError,
            run: () =>
              testConn.mutate(undefined, {
                onSuccess: (r) =>
                  toast(r.ok ? `连接正常${r.dim ? `，维度 ${r.dim}` : ""}` : r.detail, r.ok ? "success" : "error"),
                onError,
              }),
          }}
          busy={busy}
          saving={patch.isPending}
          onSave={saveCloudForm}
        />
      )}

      {cfg && (
        <SearchGateSection gate={cfg.searchGate} value={searchEnabled} onChange={saveGate} />
      )}

      <ApiKeySection
        status={cfg?.apiKey}
        input={apiKeyInput}
        onInput={setApiKeyInput}
        onRotate={submitRotate}
        onClear={() => setClearConfirm(true)}
        busy={busy}
        rotating={rotate.isPending}
      />

      <ReindexSection
        disabled={notEnabled}
        hint={notEnabled ? SEARCH_NOT_ENABLED.reindexHint : undefined}
        onReindex={() => onReindex?.()}
      />

      {/* off->cloud 数据出域二次确认 */}
      <CloudConsentModal
        open={consentOpen}
        busy={patch.isPending}
        onClose={() => setConsentOpen(false)}
        onConfirm={confirmCloudPatch}
      />

      {/* 清除密钥确认 */}
      <ClearKeyModal
        open={clearConfirm}
        busy={clearKey.isPending}
        onClose={() => setClearConfirm(false)}
        onConfirm={submitClear}
      />
    </div>
  );
}


