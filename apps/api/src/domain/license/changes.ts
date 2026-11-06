/**
 * 授权单据变更信号（进程内极轻量发布/订阅，无任何 IO 与跨层依赖）。
 *
 * 背景：续费恢复 / 吊销 / 换绑等单据变更有两条到达路径——
 *   1) 前台动作（activate/refresh/import）：BFF 路由里直接双清席位缓存 + 闸门缓存；
 *   2) 后台常驻心跳：授权中心主动下发的新信封（如续费后下一跳、吊销收敛）只经
 *      LicenseRuntime.tick 成功路径，原先只清了席位缓存，漏清闸门②缓存，导致续费恢复 /
 *      吊销在最坏 GATE_TTL_MS(10s) 内仍按旧 verdict 放行或挂起（吊销方向是 fail-open 尾巴）。
 *
 * 为不让 domain 层（runtime）反向 import middleware（licenseSeatGate，后者已依赖 runtime，
 * 会成环），由 domain 发信号、middleware 订阅清缓存，依赖方向保持 middleware -> domain。
 *
 * 语义：信号仅表示"可能有新单据落库，相关派生缓存请作废"，不携带载荷；订阅方自行决定失效范围。
 * off 模式 runtime 不启动、永不发信号，零行为变化。
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let seq = 0;

/** 发布一次"授权单据可能已变更"信号。同步、不抛（监听者异常被隔离，互不影响）。 */
export function emitLicenseChanged(): void {
  seq += 1;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // 单个监听者出错不影响其余监听者与发信号主路径（心跳不能因缓存失效而失败）。
    }
  }
}

/** 订阅变更信号；返回退订函数。重复订阅同一函数会被 Set 去重。 */
export function onLicenseChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅供测试：复位订阅与计数。 */
export function __resetLicenseChangeSignal(): void {
  listeners.clear();
  seq = 0;
}

/** 仅供测试：累计发信号次数。 */
export function __licenseChangeSeq(): number {
  return seq;
}
