// 满员拦截对话框（闸门① LICENSE_SEAT_LIMIT）：新增账号被后端 403 拦截时，apiFetch 旁路
// 把后端中文文案写入 licenseGate store.seatLimit，本组件监听后弹一次。
// 文案完全以后端 error 为准（免费 5 人/祖父团队/商业席位满三种口径后端已区分）；
// 关闭即 clear，不阻塞页面其余操作（用户可能是在邀请流程中被拦，需要回去改操作）。
import { useNavigate } from "react-router-dom";
import { Button, Modal } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useLicenseGateStore } from "../../store/licenseGate";
import { useLicenseStatus } from "./license-hooks";

export function SeatLimitDialog() {
  const message = useLicenseGateStore((s) => s.seatLimit);
  const clearSeatLimit = useLicenseGateStore((s) => s.clearSeatLimit);
  const { data: status } = useLicenseStatus();
  const navigate = useNavigate();
  const open = message !== null;

  // 管理员可被引导去设置页激活/续费；普通成员只给「知道了」。
  const goSettings = () => {
    clearSeatLimit();
    navigate("/workspace/settings/license");
  };

  return (
    <Modal
      open={open}
      onClose={clearSeatLimit}
      width={440}
      ariaLabel="席位已满"
      footer={
        <>
          <Button variant="secondary" onClick={clearSeatLimit}>
            知道了
          </Button>
          {status.available && status.isAdmin && (
            <Button variant="primary" icon="keyRound" onClick={goSettings}>
              管理授权
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col items-start gap-3 py-1">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gx-warning-bg text-gx-warning">
          <Icon name="users" size={20} />
        </span>
        <div>
          <h2 className="text-gx-15 font-semibold text-gx-text-primary">席位已满</h2>
          <p className="mt-1.5 text-gx-13 leading-6 text-gx-text-secondary">{message}</p>
          {status.available && (
            <p className="mt-2 text-gx-12 text-gx-text-tertiary">
              当前 {status.verdictLabel}
              {status.seats !== null && status.usedSeats !== null
                ? ` · 已用 ${status.usedSeats}/${status.seats} 席`
                : ""}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
