// M5 语义检索设置面板（role_owner 可见，工作区设置 → 语义检索）：
//   - off（默认，仅本机关键词检索，零外网）/ 云端 单选；无本地模型选项
//   - off->cloud 先弹数据出域二次确认，PATCH 带 confirmCloud:true；409 NEED_CLOUD_CONFIRM 接住
//   - cloud 表单 baseURL/model/batchSize/timeoutMs；dim 只读（无 dim 输入项）
//   - apiKey 密码框只写：GET 只回 configured/source/maskedLast4，轮换/清除两按钮，绝不显示明文
//   - 重建索引二次确认 + 范围选择；409 REINDEX_IN_PROGRESS 中性提示
// 非 owner 由父级不挂载本面板；403 在各 hook 静默（不刷错误）。
import { useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  errorCode,
  isForbidden,
  isSearchNotEnabled,
  useClearApiKey,
  useEmbeddingConfig,
  usePatchEmbeddingConfig,
  useRotateApiKey,
} from "./search-admin-hooks";
import { adminErrorMessage, CLOUD_CONSENT_TEXT, SEARCH_NOT_ENABLED } from "./search-admin-copy";
import { SearchEnableGuide } from "./SearchEnableGuide";
import { buildConfigPatch } from "./search-config";
import type { EmbeddingMode } from "@gx/shared-types";

export function EmbeddingSearchPanel({ onReindex }: { onReindex?: () => void }) {
  const configQ = useEmbeddingConfig(true);
  const patch = usePatchEmbeddingConfig();
  const rotate = useRotateApiKey();
  const clearKey = useClearApiKey();

  const [mode, setMode] = useState<EmbeddingMode>("off");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [batchSize, setBatchSize] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [fieldChunkCap, setFieldChunkCap] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  // 配置加载后同步本地表单（apiKey 不回填，只写）
  useEffect(() => {
    const c = configQ.data;
    if (!c) return;
    setMode(c.mode);
    setBaseURL(c.baseURL);
    setModel(c.model);
    setBatchSize(String(c.batchSize));
    setTimeoutMs(String(c.timeoutMs));
    setFieldChunkCap(String(c.fieldChunkCap));
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
  function buildPatch(nextMode: EmbeddingMode, confirmCloud: boolean) {
    return buildConfigPatch(
      { mode: nextMode, baseURL, model, batchSize, timeoutMs, fieldChunkCap, apiKey: apiKeyInput },
      confirmCloud,
    );
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
      onSuccess: (r) => toast(r.reindexRequired ? "已关闭，旧索引将在下次重建后更新" : "已保存", "success"),
      onError,
    });
  }

  // 出域确认后才真正以 confirmCloud:true 提交；若后端仍回 409（极端竞态）提示先确认。
  function confirmCloudPatch() {
    setConsentOpen(false);
    patch.mutate(buildPatch("cloud", true), {
      onSuccess: (r) => {
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
    patch.mutate(buildPatch("cloud", true), {
      onSuccess: (r) => {
        setApiKeyInput("");
        toast(r.reindexRequired ? "已保存，建议随后重建索引" : "已保存", "success");
      },
      onError,
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
      <section className="rounded-gx-lg border border-gx-separator p-4">
        <h3 className="text-gx-14 font-semibold text-gx-text-primary">检索方式</h3>
        <p className="mt-1 text-gx-12 text-gx-text-tertiary">选择关键词检索或云端语义检索。</p>
        <div className="mt-3 flex flex-col gap-2">
          <ModeOption
            active={mode === "off"}
            title="仅本机关键词检索"
            subtitle="只在本工作区数据库内匹配关键词，不向外部发送任何内容（默认）"
            onClick={() => chooseMode("off")}
          />
          <ModeOption
            active={mode === "cloud"}
            title="云端语义检索"
            subtitle="在关键词之外，按语义理解匹配内容；需要配置外部服务，检索文本会发送到该服务"
            onClick={() => chooseMode("cloud")}
          />
        </div>
      </section>

      {mode === "cloud" && cfg && (
        <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator p-4">
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">云端服务配置</h3>
          <Field label="服务地址">
            <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="模型名称">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如文本向量模型名" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="批量大小">
              <Input type="number" min={1} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
            </Field>
            <Field label="超时（毫秒）">
              <Input type="number" min={1} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
            </Field>
          </div>
          <Field label="单条记录字段索引上限">
            <Input type="number" min={1} max={1000} value={fieldChunkCap} onChange={(e) => setFieldChunkCap(e.target.value)} />
          </Field>
          {/* dim 只读：维度由所选模型决定，不提供编辑入口 */}
          <div className="flex items-center gap-2 text-gx-12 text-gx-text-hint">
            <Icon name="alertCircle" size={13} />
            当前向量维度 {cfg.dim}（由模型决定，重建后生效）
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" loading={patch.isPending} disabled={busy} onClick={saveCloudForm}>
              保存配置
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator p-4">
        <h3 className="text-gx-14 font-semibold text-gx-text-primary">服务密钥</h3>
        {cfg && (
          <div className="flex items-center gap-2 text-gx-12 text-gx-text-secondary">
            <KeyStatusDot configured={cfg.apiKey.configured} source={cfg.apiKey.source} />
            {cfg.apiKey.configured
              ? <>已配置{cfg.apiKey.maskedLast4 ? <>（末 4 位：<span className="font-mono">{cfg.apiKey.maskedLast4}</span>）</> : null}，来源：{sourceLabel(cfg.apiKey.source)}</>
              : "尚未配置密钥（当前来源：无）"}
          </div>
        )}
        <Field label="设置 / 轮换密钥（仅写入，不会回显已有内容）">
          <Input
            type="password"
            value={apiKeyInput}
            autoComplete="new-password"
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="粘贴新密钥后点轮换保存"
          />
        </Field>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" loading={rotate.isPending} disabled={busy} onClick={submitRotate}>
            轮换为新密钥
          </Button>
          <Button variant="ghost" size="sm" className="text-gx-danger" disabled={busy} onClick={() => setClearConfirm(true)}>
            清除已保存的密钥
          </Button>
        </div>
      </section>

      <section className="flex items-center justify-between rounded-gx-lg border border-gx-separator p-4">
        <div>
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">检索索引</h3>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">修改配置或大量变更内容后，可手动重建索引。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {notEnabled && <span className="text-gx-11 text-gx-text-hint">{SEARCH_NOT_ENABLED.reindexHint}</span>}
          <Button
            variant="secondary"
            size="sm"
            disabled={notEnabled}
            title={notEnabled ? SEARCH_NOT_ENABLED.reindexHint : undefined}
            onClick={() => onReindex?.()}
          >
            重建索引
          </Button>
        </div>
      </section>

      {/* off->cloud 数据出域二次确认 */}
      <Modal
        open={consentOpen}
        title="启用云端语义检索"
        onClose={() => {
          setConsentOpen(false);
         
        }}
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConsentOpen(false); }} disabled={patch.isPending}>
              取消
            </Button>
            <Button variant="primary" loading={patch.isPending} onClick={confirmCloudPatch}>
              我已了解，启用
            </Button>
          </>
        }
      >
        <p className="text-gx-13 text-gx-text-secondary">{CLOUD_CONSENT_TEXT}</p>
      </Modal>

      {/* 清除密钥确认 */}
      <Modal
        open={clearConfirm}
        title="清除已保存的密钥"
        onClose={() => setClearConfirm(false)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearConfirm(false)} disabled={clearKey.isPending}>
              取消
            </Button>
            <Button variant="danger" loading={clearKey.isPending} onClick={submitClear}>
              清除
            </Button>
          </>
        }
      >
        <p className="text-gx-13 text-gx-text-secondary">
          清除后将不再使用已保存的云端密钥；若环境变量中提供了密钥会回落到它，否则云端语义检索暂不可用。
        </p>
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-gx-12 text-gx-text-tertiary">{label}</span>
      {children}
    </label>
  );
}

function ModeOption({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-start gap-2.5 rounded-gx-md border p-3 text-left",
        active ? "border-gx-accent bg-gx-accent-bg" : "border-gx-separator hover:bg-gx-bg",
      ].join(" ")}
    >
      <span className={["mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", active ? "border-gx-accent" : "border-gx-border-strong"].join(" ")}>
        {active && <span className="h-2 w-2 rounded-full bg-gx-accent" />}
      </span>
      <span>
        <span className="block text-gx-13 font-medium text-gx-text-primary">{title}</span>
        <span className="mt-0.5 block text-gx-12 text-gx-text-tertiary">{subtitle}</span>
      </span>
    </button>
  );
}

function KeyStatusDot({ configured, source }: { configured: boolean; source: string }) {
  void source;
  return <span className={["h-2 w-2 rounded-full", configured ? "bg-gx-success" : "bg-gx-text-hint"].join(" ")} />;
}

function sourceLabel(source: string): string {
  if (source === "db") return "本工作区保存";
  if (source === "env") return "环境变量";
  return "无";
}
