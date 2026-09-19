// 语义检索配置页 · 远端服务配置分区（从 EmbeddingSearchPanel 按子功能拆出，保单文件 ≤300 行门禁）。
//
// 只做渲染与转发：所有状态都在父面板，本文件不持有业务、不发请求。
// 维度输入框是否可编辑由【当前服务形态】决定（cloud 档维度归 model 元数据，手填会写坏索引），
// 单一真源是 shared-types 的 providerAllowsManualDim，前后端共用同一个判定。

import { Button, Input, Select } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  EMBEDDING_PROVIDER_PRESETS,
  providerAllowsManualDim,
  type EmbeddingConnectionTestResult,
  type EmbeddingProviderKind,
} from "@gx/shared-types";

/** 远端服务配置表单值（全部按字符串持有，与后端整数区间校验前的表单态一致）。 */
export interface RemoteFormValues {
  provider: EmbeddingProviderKind;
  baseURL: string;
  model: string;
  batchSize: string;
  timeoutMs: string;
  fieldChunkCap: string;
  dim: string;
  concurrency: string;
  retryMaxAttempts: string;
  retryBaseMs: string;
}

export interface ProbeState {
  result: EmbeddingConnectionTestResult | undefined;
  pending: boolean;
  failed: boolean;
  run: () => void;
}

/** 通用字段行（label + 控件 + 可选说明）。 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-gx-12 text-gx-text-tertiary">{label}</span>
      {children}
      {hint ? <span className="text-gx-11 text-gx-text-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * 远端服务配置分区：服务形态 / 地址 / 模型 / 批量 / 超时 / 并发 / 重试 / 退避 / 字段上限 / 维度 /
 * 测试连接 / 保存。任何一次输入都经 onPatch 回传父面板（父面板据此标记"有未保存编辑"）。
 */
export function RemoteServiceSection({
  values,
  onPatch,
  liveDim,
  probe,
  busy,
  saving,
  onSave,
}: {
  values: RemoteFormValues;
  onPatch: (patch: Partial<RemoteFormValues>) => void;
  /** 现役索引维度（只读展示；cloud 档用）。 */
  liveDim: number;
  /** 连通性自检状态（探活在父面板发起，本分区只渲染结论）。 */
  probe: ProbeState;
  busy: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const dimEditable = providerAllowsManualDim(values.provider);
  const activePreset = EMBEDDING_PROVIDER_PRESETS.find((p) => p.id === values.provider);

  return (
    <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator p-4">
      <h3 className="text-gx-14 font-semibold text-gx-text-primary">远端服务配置</h3>

      <Field label="服务形态" hint={activePreset?.hint}>
        <Select
          value={values.provider}
          options={EMBEDDING_PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(e) => onPatch({ provider: e.target.value as EmbeddingProviderKind })}
        />
      </Field>

      <Field label="服务地址">
        <Input
          value={values.baseURL}
          onChange={(e) => onPatch({ baseURL: e.target.value })}
          placeholder={activePreset?.defaultBaseURL ?? "https://…"}
        />
      </Field>
      <Field label="模型名称">
        <Input
          value={values.model}
          onChange={(e) => onPatch({ model: e.target.value })}
          placeholder="例如文本向量模型名"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="批量大小">
          <Input type="number" min={1} value={values.batchSize} onChange={(e) => onPatch({ batchSize: e.target.value })} />
        </Field>
        <Field label="超时（毫秒）">
          <Input type="number" min={1} value={values.timeoutMs} onChange={(e) => onPatch({ timeoutMs: e.target.value })} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="并发数">
          <Input
            type="number"
            min={1}
            max={64}
            value={values.concurrency}
            onChange={(e) => onPatch({ concurrency: e.target.value })}
          />
        </Field>
        <Field label="重试次数">
          <Input
            type="number"
            min={1}
            max={10}
            value={values.retryMaxAttempts}
            onChange={(e) => onPatch({ retryMaxAttempts: e.target.value })}
          />
        </Field>
        <Field label="退避基数（毫秒）">
          <Input
            type="number"
            min={1}
            value={values.retryBaseMs}
            onChange={(e) => onPatch({ retryBaseMs: e.target.value })}
          />
        </Field>
      </div>
      <Field label="单条记录字段索引上限">
        <Input
          type="number"
          min={1}
          max={1000}
          value={values.fieldChunkCap}
          onChange={(e) => onPatch({ fieldChunkCap: e.target.value })}
        />
      </Field>
      {dimEditable ? (
        <Field label="向量维度" hint="须与服务端实际输出一致，填错会写坏索引">
          <Input type="number" min={1} max={4096} value={values.dim} onChange={(e) => onPatch({ dim: e.target.value })} />
        </Field>
      ) : (
        // cloud 档：维度由所选模型决定，不提供编辑入口
        <div className="flex items-center gap-2 text-gx-12 text-gx-text-hint">
          <Icon name="alertCircle" size={13} />
          当前向量维度 {liveDim}（由模型决定；如需手动指定，请把服务形态切到自建或 OpenAI 兼容）
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="min-h-[18px] text-gx-12">
          {probe.result && (
            <span
              className={[
                "flex items-center gap-1.5",
                probe.result.ok ? "text-gx-success" : "text-gx-danger",
              ].join(" ")}
            >
              <Icon name={probe.result.ok ? "check" : "alertCircle"} size={13} />
              {probe.result.detail}
              {probe.result.ok ? `（耗时 ${probe.result.latencyMs}ms）` : ""}
            </span>
          )}
          {probe.failed && (
            <span className="flex items-center gap-1.5 text-gx-danger">
              <Icon name="alertCircle" size={13} />
              自检未完成，请稍后再试
            </span>
          )}
        </div>
        <Button variant="secondary" size="sm" loading={probe.pending} disabled={busy} onClick={probe.run}>
          测试连接
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" loading={saving} disabled={busy} onClick={onSave}>
          保存配置
        </Button>
      </div>
    </section>
  );
}
