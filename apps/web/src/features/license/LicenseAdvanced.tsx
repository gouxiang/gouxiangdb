// 授权管理高级操作区（仅 isAdmin 渲染；off/available=false 整块不渲染）。
//
// 零输入立场（beta.2 起）：不再有 licenseKey/配对码手输入口——
//   ① 在线：续费/扩容/后台直绑由授权中心经心跳自动下发，管理员只需点「立即同步」立即对齐，
//      无需填写任何密钥；未开通时把完整设备指纹复制给官方，后台凭指纹直绑后再同步即可生效。
//   ② 离线：折叠两步——先纯前端生成「申请码」交官方，再把官方回签的「应答码」粘回导入。
//   ③ 联系信息（adminEmail/orgName → POST /contact，心跳分级与挂起页联系用）。
//
// 关键：sync/import 的「接收链拒绝」是 HTTP 200 + ok:false + rejected 码，resolve 而非 reject；
// 这里按 rejected 码给中文提示，未知码原样展示 code，不猜后端语义。
import { useEffect, useState, type ReactNode } from "react";
import { Button, FieldRow, Input, Textarea, toast } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { buildOfflineRequestCode, licenseErrorCode } from "../../api/license";
import { copyText, COPY_FAIL_HINT_TEXT } from "../../lib/clipboard";
import { useImportOffline, useLicenseStatus, useSaveContact, useSync } from "./license-hooks";

function Card({ icon, title, desc, children }: { icon: IconName; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3.5">
      <div className="flex items-start gap-2">
        <Icon name={icon} size={15} className="mt-0.5 shrink-0 text-gx-text-tertiary" />
        <div>
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">{title}</h3>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** 接收链 rejected 码 → 中文提示；未知码不猜，原样带出 code 便于管理员反馈。 */
export function rejectedMessage(code: string | null): string {
  switch (code) {
    case "REVOKED":
      return "授权已被停用，请联系官方或购买新许可";
    case "FINGERPRINT_MISMATCH":
      return "本机与绑定信息不一致，如已换机请联系管理员换绑";
    case "BAD_SIGNATURE":
    case "KID_MISMATCH":
      return "授权凭据校验未通过，请核对密钥或应答码后重试";
    case "VERSION_ROLLBACK":
      return "单据版本低于当前生效版本，已拒绝回滚";
    case "OFFLINE_CODE_EXPIRED":
      return "离线应答码已过期，请重新生成申请码并获取新应答码";
    case "BAD_RESPONSE_CODE":
      return "应答码无法识别，请确认完整复制后重试";
    case "PAIR_CODE_EXPIRED":
      return "配对码已过期，请向官方索取新码";
    case "ALREADY_BOUND":
      return "该授权已绑定另一台设备，如需更换请联系管理员换绑";
    case "NOT_BOUND":
      return "该授权尚未绑定实例，请先完成激活";
    case null:
      return "授权校验未通过";
    default:
      return `授权校验未通过（${code}）`;
  }
}

/** mutation 异常（HTTP/网络层）→ 中文提示。 */
function errorMessage(e: unknown): string {
  const code = licenseErrorCode(e);
  if (code === "LICENSE_ADMIN_ONLY") return "仅管理员可管理授权";
  if (code === "LICENSE_DISABLED") return "授权服务未启用";
  if (code === "BAD_REQUEST") return "提交内容不完整，请检查后重试";
  if (code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") return "操作过于频繁，请稍后再试";
  return "操作失败，请稍后重试";
}

/** 在线免输入「立即同步」+ 未开通复制指纹引导。 */
function SyncCard() {
  const { data: status } = useLicenseStatus();
  const mutation = useSync();
  const [copying, setCopying] = useState(false);
  // 未持有商业单据（免费/失效等）：给「复制完整指纹联系官方开通」引导而非密钥框。
  const unlicensed = status.verdict !== "licensed" && status.verdict !== "grace";

  const runSync = () => {
    mutation.mutate(undefined, {
      onSuccess: (out) => {
        if (out.ok) toast(`授权状态已是最新（${out.verdictLabel}）`, "success");
        else toast(rejectedMessage(out.rejected), "error");
      },
      onError: (e) => toast(errorMessage(e), "error"),
    });
  };

  const copyFingerprint = async () => {
    if (!status.fingerprint || copying) return;
    setCopying(true);
    try {
      const ok = await copyText(status.fingerprint);
      toast(ok ? "完整设备指纹已复制，可发给官方开通" : COPY_FAIL_HINT_TEXT, ok ? "success" : "error");
    } finally {
      setCopying(false);
    }
  };

  return (
    <Card
      icon="sync"
      title="授权同步"
      desc="续费、扩容或官方为设备开通后，点此立即与授权中心对齐，无需输入任何密钥；日常也会自动同步。"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" icon="sync" loading={mutation.isPending || status.syncing} onClick={runSync}>
          立即同步
        </Button>
        <span
          className={`inline-flex items-center gap-1 text-gx-12 ${status.online ? "text-gx-success" : "text-gx-warning"}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.online ? "bg-gx-success" : "bg-gx-warning"}`} />
          {status.online ? "在线" : "离网，将自动重试"}
        </span>
      </div>
      {unlicensed && (
        <div className="rounded-gx-lg border border-gx-border bg-gx-control px-3 py-2.5">
          <p className="text-gx-12 text-gx-text-secondary">
            当前为免费档。开通商业授权无需在本机填写密钥：把下面的完整设备指纹发给官方，开通后点「立即同步」即自动生效。
          </p>
          {status.fingerprint && (
            <button
              type="button"
              onClick={() => void copyFingerprint()}
              className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2 text-gx-12 text-gx-text-secondary transition-colors hover:text-gx-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
            >
              <Icon name="copy" size={13} />
              复制完整设备指纹
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/** 离线激活（内网/离网）：折叠两步——申请码（纯前端生成）→ 应答码导入。 */
function OfflineCard() {
  const { data: status } = useLicenseStatus();
  const importMut = useImportOffline();
  const [open, setOpen] = useState(false);
  const [requestCode, setRequestCode] = useState("");
  const [responseCode, setResponseCode] = useState("");

  const generate = () => {
    setRequestCode(
      buildOfflineRequestCode({
        fingerprint: status.fingerprint ?? status.fingerprintShort,
        deploymentId: status.deploymentId,
        platform: status.platform,
      }),
    );
  };

  const copyRequest = async () => {
    if (!requestCode) return;
    const ok = await copyText(requestCode);
    toast(ok ? "申请码已复制" : COPY_FAIL_HINT_TEXT, ok ? "success" : "error");
  };

  const submitResponse = () => {
    const code = responseCode.trim();
    if (!code) {
      toast("请粘贴官方应答码", "info");
      return;
    }
    importMut.mutate(
      { code },
      {
        onSuccess: (out) => {
          if (out.ok) {
            toast("离线授权导入成功", "success");
            setResponseCode("");
            setRequestCode("");
          } else {
            toast(rejectedMessage(out.rejected), "error");
          }
        },
        onError: (e) => toast(errorMessage(e), "error"),
      },
    );
  };

  return (
    <Card icon="upload" title="离线激活" desc="设备长期处于内网、无法连接授权中心时使用；可联网时直接用上方「立即同步」即可。">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 w-full items-center justify-between rounded-gx-lg border border-gx-border bg-gx-control px-3 text-gx-13 text-gx-text-secondary transition-colors hover:text-gx-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
      >
        {open ? "收起离线激活步骤" : "无法连接授权中心？用申请码 / 应答码激活"}
        <Icon name="chevronDown" size={14} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>
      {open && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-gx-12 font-medium text-gx-text-secondary">第 1 步：生成申请码并发给官方</p>
            {requestCode ? (
              <>
                <Textarea rows={3} readOnly value={requestCode} className="font-mono text-gx-12" />
                <div>
                  <Button variant="secondary" size="sm" icon="copy" onClick={() => void copyRequest()}>
                    复制申请码
                  </Button>
                </div>
              </>
            ) : (
              <div>
                <Button variant="secondary" size="sm" icon="keyRound" onClick={generate}>
                  生成申请码
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-gx-12 font-medium text-gx-text-secondary">第 2 步：粘贴官方回签的应答码</p>
            <Textarea
              rows={4}
              value={responseCode}
              onChange={(e) => setResponseCode(e.target.value)}
              placeholder="粘贴官方应答码（base64url，一整段）"
              spellCheck={false}
              className="font-mono text-gx-12"
            />
            <div>
              <Button variant="secondary" size="sm" icon="upload" loading={importMut.isPending} onClick={submitResponse}>
                导入应答码
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function ContactCard() {
  const { data: status } = useLicenseStatus();
  const mutation = useSaveContact();
  const [adminEmail, setAdminEmail] = useState("");
  const [orgName, setOrgName] = useState("");

  // status 从 off 兜底切换为真实数据后回填一次表单（只在用户尚未输入时，避免覆盖正在编辑的值）。
  useEffect(() => {
    setAdminEmail((cur) => (cur === "" ? status.adminEmail ?? "" : cur));
    setOrgName((cur) => (cur === "" ? status.orgName ?? "" : cur));
  }, [status.adminEmail, status.orgName]);

  const submit = () => {
    const email = adminEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast("邮箱格式不正确", "error");
      return;
    }
    mutation.mutate(
      { adminEmail: email, orgName: orgName.trim() },
      {
        onSuccess: () => toast("联系信息已保存", "success"),
        onError: (e) => toast(errorMessage(e), "error"),
      },
    );
  };

  return (
    <Card icon="building" title="管理员联系信息" desc="随心跳上报给授权中心；成员账号被挂起时据此展示联系方式">
      <FieldRow label="管理员邮箱">
        <Input
          type="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder="admin@example.com"
        />
      </FieldRow>
      <FieldRow label="团队 / 公司名称">
        <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="选填" maxLength={120} />
      </FieldRow>
      <div>
        <Button variant="secondary" size="sm" icon="save" loading={mutation.isPending} onClick={submit}>
          保存联系信息
        </Button>
      </div>
    </Card>
  );
}

export function LicenseAdvanced() {
  const { data: status } = useLicenseStatus();
  // 非管理员或授权未启用：不渲染任何管理操作（后端每端点仍独立 403 鉴权，这只是 UI 显隐）。
  if (!status.available || !status.isAdmin) return null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-gx-14 font-semibold text-gx-text-primary">管理员操作</h3>
      <SyncCard />
      <OfflineCard />
      <ContactCard />
    </div>
  );
}
