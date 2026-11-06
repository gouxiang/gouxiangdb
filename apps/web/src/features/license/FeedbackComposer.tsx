// 官方反馈提交表单：content 必填 + category 选择 + 联系邮箱/电话选填 + 多附件。
// 附件前端先按 feedback-policy 校验（5 个/单 8MB/合计 20MB/扩展名白名单），超限 toast 不发请求。
import { useRef, useState } from "react";
import { Button, FieldRow, Input, Select, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useSubmitFeedback } from "./license-hooks";
import {
  FEEDBACK_CATEGORIES,
  formatBytes,
  validateFeedbackFiles,
} from "./feedback-policy";

export function FeedbackComposer() {
  const mutation = useSubmitFeedback();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState(FEEDBACK_CATEGORIES[0]!.value);
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const err = validateFeedbackFiles(files, incoming);
    if (err) {
      toast(err.message, "error");
      return;
    }
    setFiles((prev) => [...prev, ...incoming]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = () => {
    if (!content.trim()) {
      toast("请先填写问题描述", "info");
      return;
    }
    mutation.mutate(
      {
        content: content.trim(),
        category,
        contactEmail: contactEmail.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        files,
      },
      {
        onSuccess: (res) => {
          if (res.ok) {
            toast("反馈已提交，可在下方工单列表查看回复", "success");
            setContent("");
            setFiles([]);
          } else {
            toast(res.error ?? "提交失败，请稍后重试", "error");
          }
        },
        onError: () => toast("提交失败，请检查网络后重试", "error"),
      },
    );
  };

  return (
    <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3.5">
      <h3 className="text-gx-14 font-semibold text-gx-text-primary">提交反馈</h3>
      <Textarea
        rows={4}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="描述你遇到的问题或建议（必填）"
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FieldRow label="问题分类">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FieldRow>
        <div className="hidden sm:block" />
        <FieldRow label="联系邮箱（选填）">
          <Input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="方便官方回复时联系你"
          />
        </FieldRow>
        <FieldRow label="联系电话（选填）">
          <Input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="选填"
          />
        </FieldRow>
      </div>

      <div className="flex flex-col gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".png,.jpg,.jpeg,.gif,.webp,.zip,.log,.txt,.pdf,.mp4,.mov"
          onChange={(e) => pickFiles(e.target.files)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon="paperclip"
            onClick={() => fileInputRef.current?.click()}
          >
            添加附件
          </Button>
          <span className="text-gx-11 text-gx-text-hint">
            最多 5 个，单个 ≤ 8MB，合计 ≤ 20MB（图片/日志/压缩包/视频）
          </span>
        </div>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded-gx-lg bg-gx-control px-2.5 py-1.5 text-gx-12"
              >
                <Icon name="file" size={13} className="shrink-0 text-gx-text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-gx-text-secondary">{f.name}</span>
                <span className="shrink-0 tabular-nums text-gx-text-hint">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  aria-label={`移除附件 ${f.name}`}
                  onClick={() => removeFile(i)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-gx-sm text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
            <li className="text-gx-11 text-gx-text-hint">合计 {formatBytes(totalBytes)} / 20.0 MB</li>
          </ul>
        )}
      </div>

      <div>
        <Button variant="primary" size="sm" icon="comment" loading={mutation.isPending} onClick={submit}>
          提交反馈
        </Button>
      </div>
    </section>
  );
}
