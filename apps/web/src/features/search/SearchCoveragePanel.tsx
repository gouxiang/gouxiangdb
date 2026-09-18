// M5 检索覆盖度面板（V5 最小集，role_owner）：展示索引积压、覆盖度 A-F、字段索引截断、
// 重建进行中与语义服务健康。30s 节流轮询且仅页面可见时轮询（useSearchStatus 已处理），
// index===null（尚未建库）显示"尚未建立索引"空态而非全 0。术语全部中性化，不暴露表名/SQL。
import { Button, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import { isSearchNotEnabled, useSearchStatus } from "./search-admin-hooks";
import { BACKLOG_LABELS, COVERAGE_LABELS, SEARCH_NOT_ENABLED } from "./search-admin-copy";
import { SearchEnableGuide } from "./SearchEnableGuide";

export function SearchCoveragePanel({ onReindex }: { onReindex?: () => void }) {
  const statusQ = useSearchStatus(true);
  // 子面未启用（admin 端点 404 NOT_FOUND）≠ 故障：给"未启用"空态，不显示"稍后重试"。
  const notEnabled = isSearchNotEnabled(statusQ.error);

  if (statusQ.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (notEnabled) {
    return (
      <section className="flex flex-col items-center gap-2 rounded-gx-lg border border-dashed border-gx-border-strong p-8 text-center">
        <Icon name="search" size={22} className="text-gx-text-hint" />
        <div className="text-gx-13 font-medium text-gx-text-secondary">{SEARCH_NOT_ENABLED.title}</div>
        <p className="max-w-sm text-gx-12 text-gx-text-hint">{SEARCH_NOT_ENABLED.body}</p>
        {onReindex && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-1"
            disabled
            title={SEARCH_NOT_ENABLED.reindexHint}
          >
            重建索引
          </Button>
        )}
        <div className="text-gx-11 text-gx-text-hint">{SEARCH_NOT_ENABLED.reindexHint}</div>
        <div className="mt-3 w-full text-left">
          <SearchEnableGuide compact />
        </div>
      </section>
    );
  }
  if (statusQ.isError) {
    // 403/404 已在 hook retry 层静默；此处给中性空态，不刷技术错误。
    return (
      <div className="rounded-gx-lg border border-gx-separator p-4 text-gx-12 text-gx-text-hint">
        暂不可用，请稍后刷新重试。
      </div>
    );
  }

  const status = statusQ.data;
  const index = status?.index ?? null;
  const embedding = status?.embedding;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      {/* 语义服务健康 */}
      <section className="flex items-center justify-between rounded-gx-lg border border-gx-separator p-4">
        <div className="flex items-center gap-2.5">
          <HealthDot ok={embedding?.healthy ?? false} />
          <div>
            <div className="text-gx-13 font-medium text-gx-text-primary">语义检索服务</div>
            <div className="mt-0.5 text-gx-12 text-gx-text-tertiary">
              {embedding?.mode === "cloud" ? `云端模式 · ${embedding.model || "未指定模型"}` : "当前为仅关键词模式"}
              {embedding?.reindexRequired ? " · 配置已变更，建议重建索引" : ""}
            </div>
          </div>
        </div>
        {onReindex && (
          <Button variant="secondary" size="sm" onClick={onReindex}>
            重建索引
          </Button>
        )}
      </section>

      {/* 尚未建库空态 */}
      {index === null ? (
        <section className="flex flex-col items-center gap-2 rounded-gx-lg border border-dashed border-gx-border-strong p-8 text-center">
          <Icon name="search" size={22} className="text-gx-text-hint" />
          <div className="text-gx-13 font-medium text-gx-text-secondary">尚未建立检索索引</div>
          <p className="max-w-sm text-gx-12 text-gx-text-hint">
            启用云端语义检索并触发一次重建后，这里会显示索引覆盖与健康情况。关键词检索无需建库即可使用。
          </p>
          {onReindex && (
            <Button variant="primary" size="sm" className="mt-1" onClick={onReindex}>
              立即重建
            </Button>
          )}
        </section>
      ) : (
        <>
          {index.rebuilding && (
            <div className="flex items-center gap-2 rounded-gx-lg border border-gx-separator bg-gx-accent-bg px-4 py-2.5 text-gx-12 text-gx-text-secondary">
              <Spinner size={13} />
              索引正在后台重建，完成后数字会自动更新。
            </div>
          )}

          {/* 积压 */}
          <section className="rounded-gx-lg border border-gx-separator p-4">
            <h3 className="text-gx-14 font-semibold text-gx-text-primary">重建队列</h3>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Stat label={BACKLOG_LABELS.pending} value={index.backlog.pending} />
              <Stat label={BACKLOG_LABELS.failed} value={index.backlog.failed} warn={index.backlog.failed > 0} />
              <Stat label={BACKLOG_LABELS.dead} value={index.backlog.dead} warn={index.backlog.dead > 0} />
            </div>
          </section>

          {/* 覆盖度 A-F */}
          <section className="rounded-gx-lg border border-gx-separator p-4">
            <h3 className="text-gx-14 font-semibold text-gx-text-primary">索引覆盖度</h3>
            <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">理想状态下各项均为 0；非 0 项给出原因，重建后通常会清零。</p>
            <div className="mt-3 flex flex-col gap-2">
              {COVERAGE_LABELS.map((c) => {
                const value = index.coverage[c.key];
                const bad = value > 0;
                return (
                  <div key={c.key} className="flex items-center justify-between rounded-gx-lg bg-gx-bg px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={["h-2 w-2 rounded-full", bad ? (c.blocking ? "bg-gx-danger" : "bg-gx-warning") : "bg-gx-success"].join(" ")} />
                      <span className="text-gx-13 text-gx-text-primary">{c.label}</span>
                      <span className="text-gx-11 text-gx-text-hint">{c.hint}</span>
                    </div>
                    <span className={["font-mono text-gx-13 tabular-nums", bad ? "font-semibold text-gx-text-primary" : "text-gx-text-hint"].join(" ")}>
                      {value}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 块统计 + 字段截断 */}
          <section className="rounded-gx-lg border border-gx-separator p-4">
            <h3 className="text-gx-14 font-semibold text-gx-text-primary">索引规模</h3>
            <div className="mt-3 grid grid-cols-4 gap-3">
              <Stat label="记录" value={index.chunks.records} />
              <Stat label="文档" value={index.chunks.docs} />
              <Stat label="画布" value={index.chunks.canvas} />
              <Stat label="总计" value={index.chunks.total} />
            </div>
            <div className="mt-3 flex items-center justify-between rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12">
              <span className="text-gx-text-tertiary">
                字段索引分段上限 {index.chunks.fieldChunkCap}
              </span>
              <span className={index.chunks.fieldChunksCapped > 0 ? "font-semibold text-gx-warning" : "text-gx-text-hint"}>
                {index.chunks.fieldChunksCapped > 0
                  ? `${index.chunks.fieldChunksCapped} 条记录的字段内容超出上限已截断`
                  : "无记录被截断"}
              </span>
            </div>
            {index.indexedAt && (
              <div className="mt-2 text-gx-11 text-gx-text-hint">上次完成：{formatTime(index.indexedAt)}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-gx-lg bg-gx-bg px-3 py-2.5">
      <div className={["font-mono text-gx-18 tabular-nums", warn ? "font-semibold text-gx-warning" : "text-gx-text-primary"].join(" ")}>
        {value}
      </div>
      <div className="mt-0.5 text-gx-11 text-gx-text-hint">{label}</div>
    </div>
  );
}

function HealthDot({ ok }: { ok: boolean }) {
  return <span className={["h-2.5 w-2.5 rounded-full", ok ? "bg-gx-success" : "bg-gx-text-hint"].join(" ")} />;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
