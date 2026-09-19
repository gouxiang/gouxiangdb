// 语义检索配置页 · 检索总门 / 服务密钥 / 两个确认弹窗（从 EmbeddingSearchPanel 拆出，保单文件门禁）。
//
// 只做渲染与转发：状态与请求全在父面板。
// 检索总门刻意【不假装热切换】——检索接口请求期读覆盖值即时生效，索引 worker 在启动期决定是否运行，
// 覆盖值对它必须重启 API 服务；env=off 时路由根本没挂载，覆盖键此刻救不回来。三态如实写在分区里。

import { Button, Input, Modal, Select } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { EmbeddingApiKeyStatus, SearchEnabledOverride, SearchGateDTO } from "@gx/shared-types";
import { CLOUD_CONSENT_TEXT } from "./search-admin-copy";
import { Field } from "./EmbeddingRemoteSection";

/**
 * 检索总门分区：db 覆盖键 search.enabled（on/off/inherit）+ 各生效面的如实标注。
 * env 为 off 时额外给出"必须先改 GX_M5_SEARCH 并重启"的红色提示，避免做了个点了没反应的开关。
 */
export function SearchGateSection({
  gate,
  value,
  onChange,
}: {
  gate: SearchGateDTO;
  value: SearchEnabledOverride;
  onChange: (next: SearchEnabledOverride) => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator p-4">
      <div className="flex items-start gap-1.5">
        <Icon name="toggleLeft" size={15} className="mt-0.5 text-gx-text-hint" />
        <div>
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">检索总门</h3>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
            环境变量 GX_M5_SEARCH 当前为 <span className="font-mono">{gate.envValue}</span>；
            此处覆盖值写入工作区设置（无需改环境变量）。
          </p>
        </div>
      </div>
      <Field label="覆盖值">
        <Select
          value={value}
          options={[
            { value: "inherit", label: "跟随环境变量" },
            { value: "on", label: "启用" },
            { value: "off", label: "停用" },
          ]}
          onChange={(e) => onChange(e.target.value as SearchEnabledOverride)}
        />
      </Field>
      <div className="flex flex-col gap-1 text-gx-11 text-gx-text-hint">
        {gate.envGateOff && (
          <span className="flex items-center gap-1.5 text-gx-danger">
            <Icon name="alertCircle" size={12} />
            环境变量为 off 时检索路由未挂载：需先改 GX_M5_SEARCH 并重启 API 服务，覆盖值才可能生效。
          </span>
        )}
        <span>· 检索接口：覆盖值即时生效。</span>
        <span>· 索引 worker：启动期决定是否运行，改此值需重启 API 服务后生效。</span>
      </div>
    </section>
  );
}

/** 服务密钥分区：只写不回显（GET 只有 configured/source/maskedLast4，绝不明文回传）。 */
export function ApiKeySection({
  status,
  input,
  onInput,
  onRotate,
  onClear,
  busy,
  rotating,
}: {
  status: EmbeddingApiKeyStatus | undefined;
  input: string;
  onInput: (v: string) => void;
  onRotate: () => void;
  onClear: () => void;
  busy: boolean;
  rotating: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator p-4">
      <h3 className="text-gx-14 font-semibold text-gx-text-primary">服务密钥</h3>
      {status && (
        <div className="flex items-center gap-2 text-gx-12 text-gx-text-secondary">
          <KeyStatusDot configured={status.configured} source={status.source} />
          {status.configured ? (
            <>
              已配置
              {status.maskedLast4 ? (
                <>（末 4 位：<span className="font-mono">{status.maskedLast4}</span>）</>
              ) : null}
              ，来源：{sourceLabel(status.source)}
            </>
          ) : (
            "尚未配置密钥（当前来源：无）"
          )}
        </div>
      )}
      <Field label="设置 / 轮换密钥（仅写入，不会回显已有内容）">
        <Input
          type="password"
          value={input}
          autoComplete="new-password"
          onChange={(e) => onInput(e.target.value)}
          placeholder="粘贴新密钥后点轮换保存"
        />
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" loading={rotating} disabled={busy} onClick={onRotate}>
          轮换为新密钥
        </Button>
        <Button variant="ghost" size="sm" className="text-gx-danger" disabled={busy} onClick={onClear}>
          清除已保存的密钥
        </Button>
      </div>
    </section>
  );
}

/** off->cloud 数据出域二次确认（后端 409 NEED_CLOUD_CONFIRM 会重新弹回这一个）。 */
export function CloudConsentModal({
  open,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="启用云端语义检索"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            我已了解，启用
          </Button>
        </>
      }
    >
      <p className="text-gx-13 text-gx-text-secondary">{CLOUD_CONSENT_TEXT}</p>
    </Modal>
  );
}

/** 清除已保存密钥的二次确认。 */
export function ClearKeyModal({
  open,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="清除已保存的密钥"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            清除
          </Button>
        </>
      }
    >
      <p className="text-gx-13 text-gx-text-secondary">
        清除后将不再使用已保存的云端密钥；若环境变量中提供了密钥会回落到它，否则云端语义检索暂不可用。
      </p>
    </Modal>
  );
}

/** 检索方式单选（off 默认零外网 / cloud 走外部服务）。切到 cloud 由父面板先弹出域确认。 */
export function SearchModeSection({
  mode,
  onChoose,
}: {
  mode: "off" | "cloud";
  onChoose: (next: "off" | "cloud") => void;
}) {
  return (
    <section className="rounded-gx-lg border border-gx-separator p-4">
      <h3 className="text-gx-14 font-semibold text-gx-text-primary">检索方式</h3>
      <p className="mt-1 text-gx-12 text-gx-text-tertiary">选择关键词检索或云端语义检索。</p>
      <div className="mt-3 flex flex-col gap-2">
        <ModeOption
          active={mode === "off"}
          title="仅本机关键词检索"
          subtitle="只在本工作区数据库内匹配关键词，不向外部发送任何内容（默认）"
          onClick={() => onChoose("off")}
        />
        <ModeOption
          active={mode === "cloud"}
          title="云端语义检索"
          subtitle="在关键词之外，按语义理解匹配内容；需要配置外部服务，检索文本会发送到该服务"
          onClick={() => onChoose("cloud")}
        />
      </div>
    </section>
  );
}

/** 检索索引分区：手动重建入口（子面未启用时禁用并给出原因）。 */
export function ReindexSection({
  disabled,
  hint,
  onReindex,
}: {
  disabled: boolean;
  hint: string | undefined;
  onReindex: () => void;
}) {
  return (
    <section className="flex items-center justify-between rounded-gx-lg border border-gx-separator p-4">
      <div>
        <h3 className="text-gx-14 font-semibold text-gx-text-primary">检索索引</h3>
        <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">修改配置或大量变更内容后，可手动重建索引。</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {disabled && <span className="text-gx-11 text-gx-text-hint">{hint}</span>}
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          title={disabled ? hint : undefined}
          onClick={onReindex}
        >
          重建索引
        </Button>
      </div>
    </section>
  );
}

function ModeOption({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-start gap-2.5 rounded-gx-lg border p-3 text-left",
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
