// 系统更新主面板（DESIGN §6.3 五态状态机 + §7.2 信息布局）。
//
// 挂载不发请求（useUpdateStatus enabled:false）；点「检查更新」才请求。
// 五态：idle / checking / latest / available（内部按 eligible 分下载或联系支持）/ error。
// 分区显隐由 WorkspaceSettingsPage 的 ownerOnly + updateEnabled 探针控制，本组件假定可见即可用。
import { useEffect, useState } from "react";
import type { CurrentIdentityDTO, UpdateInfoDTO, UpdateStatusDTO } from "@gx/shared-types";
import { Button, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { MdContent } from "../../components/MdContent";
import { copyText } from "../../lib/clipboard";
import {
  UPDATE_COPY,
  archLabel,
  channelLabel,
  formatDateTime,
  formatSize,
} from "./update-copy";
import { describeUpdateError, isUpdateNotEnabled, useUpdateDownload, useUpdateStatus } from "./update-hooks";
import { UpdateInstallGuide } from "./UpdateInstallGuide";

type UiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest"; current: CurrentIdentityDTO; checkedAt: string }
  | { phase: "available"; current: CurrentIdentityDTO; info: UpdateInfoDTO; checkedAt: string }
  | { phase: "error"; message: string };

function deriveState(q: ReturnType<typeof useUpdateStatus>): UiState {
  if (q.isFetching) return { phase: "checking" };
  if (q.data) {
    const data: UpdateStatusDTO = q.data;
    if (data.update) {
      return { phase: "available", current: data.current, info: data.update, checkedAt: data.checkedAt };
    }
    return { phase: "latest", current: data.current, checkedAt: data.checkedAt };
  }
  if (q.isError) return { phase: "error", message: describeUpdateError(q.error) };
  return { phase: "idle" };
}

function EnvRow({ label, value, abnormal }: { label: string; value: string; abnormal?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-20 shrink-0 text-gx-12 text-gx-text-tertiary">{label}</span>
      <span className="min-w-0 flex-1 break-all text-gx-13 text-gx-text-primary">{value}</span>
      {abnormal && (
        <span className="flex shrink-0 items-center gap-1 text-gx-12 text-gx-warning">
          <Icon name="alertCircle" size={12} />
          {UPDATE_COPY.versionAbnormal}
        </span>
      )}
    </div>
  );
}

function CurrentEnv({ state }: { state: UiState }) {
  const current =
    state.phase === "latest" || state.phase === "available" ? state.current : null;
  const checkedAt = state.phase === "latest" || state.phase === "available" ? state.checkedAt : null;
  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-control px-3 py-2">
      <p className="mb-1 text-gx-12 font-medium text-gx-text-secondary">{UPDATE_COPY.envTitle}</p>
      {current ? (
        <div>
          <EnvRow label={UPDATE_COPY.envVersion} value={current.version} abnormal={current.versionUnparseable} />
          <EnvRow label={UPDATE_COPY.envChannel} value={channelLabel(current.channel)} />
          <EnvRow label={UPDATE_COPY.envArch} value={archLabel(current.platform, current.arch)} />
          <EnvRow label={UPDATE_COPY.lastChecked} value={checkedAt ? formatDateTime(checkedAt) : UPDATE_COPY.notChecked} />
        </div>
      ) : (
        <EnvRow label={UPDATE_COPY.lastChecked} value={UPDATE_COPY.notChecked} />
      )}
    </div>
  );
}

async function copySha(sha: string) {
  if (await copyText(sha)) {
    toast(UPDATE_COPY.shaCopied, "success");
  } else {
    toast(UPDATE_COPY.copyFailed, "error");
  }
}

function AvailableBody({ info }: { info: UpdateInfoDTO }) {
  const download = useUpdateDownload();
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!download.isError) return;
    const msg = describeUpdateError(download.error);
    setFailed(msg);
    toast(msg, "error");
  }, [download.isError, download.error]);

  useEffect(() => {
    if (download.isSuccess) setFailed(null);
  }, [download.isSuccess]);

  const artifact = info.artifact;
  return (
    <div className="flex flex-col gap-3 rounded-gx-lg border border-gx-border bg-gx-control px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gx-15 font-semibold text-gx-text-primary">
          {UPDATE_COPY.availableTitle} {info.version}
        </span>
        <span className="text-gx-12 text-gx-text-hint">{formatDateTime(info.publishedAt)} 发布</span>
      </div>

      {info.eligible && artifact ? (
        <>
          <div>
            <p className="text-gx-12 font-medium text-gx-text-secondary">{UPDATE_COPY.notesTitle}</p>
            {info.releaseNotes.format === "markdown" ? (
              <MdContent md={info.releaseNotes.zh} variant="block" className="mt-1 text-gx-13 leading-6 text-gx-text-secondary" />
            ) : (
              <p className="mt-1 whitespace-pre-line text-gx-13 leading-6 text-gx-text-secondary">
                {info.releaseNotes.zh}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1 text-gx-12 text-gx-text-tertiary">
            <span>
              {UPDATE_COPY.packageSize}：{formatSize(artifact.sizeBytes)}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {UPDATE_COPY.sha256}：
              <code className="min-w-0 flex-1 break-all rounded-gx-sm bg-gx-row-hover px-1.5 py-0.5 font-mono text-gx-11 text-gx-text-secondary">
                {artifact.sha256}
              </code>
              <Button variant="ghost" size="sm" icon="copy" onClick={() => void copySha(artifact.sha256)}>
                {UPDATE_COPY.copySha}
              </Button>
            </span>
          </div>
          <div>
            <Button
              variant="primary"
              icon="download"
              loading={download.isPending}
              disabledReason={UPDATE_COPY.downloadPrepare}
              onClick={() => {
                setFailed(null);
                download.mutate();
              }}
            >
              {download.isPending ? UPDATE_COPY.downloadPrepare : `${UPDATE_COPY.downloadPrefix} ${artifact.filename}`}
            </Button>
            {failed && <p className="mt-2 text-gx-12 text-gx-danger">{failed}</p>}
          </div>
          <UpdateInstallGuide guide={info.manualInstallGuide} />
        </>
      ) : (
        <p className="flex items-start gap-2 text-gx-13 text-gx-text-secondary">
          <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0 text-gx-warning" />
          {UPDATE_COPY.contactSupport}
        </p>
      )}
    </div>
  );
}

export function UpdatePanel({ onUnregistered }: { onUnregistered?: () => void } = {}) {
  const q = useUpdateStatus();
  const state = deriveState(q);

  // GX_UPDATE_ENABLED=off（或企业面未挂载）时 status 404：按「未注册功能」处理，
  // 通知设置页隐藏分区（右内容自动回落「通用」），不作为错误展示。挂载本身不发请求，
  // 故只有 owner 点过检查且确得 404 后才会隐藏。
  const unregistered = q.isError && isUpdateNotEnabled(q.error);
  useEffect(() => {
    if (unregistered) onUnregistered?.();
  }, [unregistered, onUnregistered]);

  if (unregistered) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-gx-18 font-semibold text-gx-text-primary">{UPDATE_COPY.title}</h2>
        <Button
          variant={state.phase === "available" ? "secondary" : "primary"}
          size="sm"
          icon="refresh"
          loading={state.phase === "checking"}
          onClick={() => void q.check()}
        >
          {state.phase === "checking"
            ? UPDATE_COPY.checking
            : state.phase === "latest" || state.phase === "available"
              ? UPDATE_COPY.recheck
              : UPDATE_COPY.check}
        </Button>
      </div>

      {q.data?.newerSchema && (
        <p className="flex items-start gap-2 rounded-gx-lg bg-gx-warning-bg px-3 py-2 text-gx-12 text-gx-warning">
          <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
          {UPDATE_COPY.newerSchema}
        </p>
      )}

      <CurrentEnv state={state} />

      {state.phase === "idle" && (
        <p className="text-gx-13 text-gx-text-tertiary">{UPDATE_COPY.idleHint}</p>
      )}

      {state.phase === "latest" && (
        <p className="flex items-center gap-2 text-gx-13 text-gx-text-secondary">
          <Icon name="check" size={15} className="shrink-0 text-gx-success" />
          {UPDATE_COPY.latestHint}（{state.current.version}）
        </p>
      )}

      {state.phase === "available" && <AvailableBody info={state.info} />}

      {state.phase === "error" && (
        <div className="flex flex-wrap items-center gap-3 rounded-gx-lg border border-gx-border bg-gx-control px-4 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-gx-13 text-gx-danger">
            <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0" />
            {state.message}
          </p>
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => void q.check()}>
            {UPDATE_COPY.retry}
          </Button>
        </div>
      )}
    </div>
  );
}

// 供设置页门控使用：off 态 404 = 未注册功能。
export { isUpdateNotEnabled };
