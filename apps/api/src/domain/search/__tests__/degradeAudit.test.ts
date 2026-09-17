// M5/S12 降级跳变采样状态机纯单测（无 IO、无查询词/字段值进入签名或事件 detail）。

import { describe, expect, it, beforeEach } from "vitest";
import {
  observeDegrade,
  degradeSignature,
  resetDegradeAuditState,
} from "../degradeAudit.js";

beforeEach(() => resetDegradeAuditState());

describe("degradeSignature 技术态签名", () => {
  it("mode|recovering|排序去重 reasons；健康态 reasons 为空", () => {
    expect(degradeSignature({ mode: "hybrid", recovering: false, reasons: [] })).toBe("hybrid|0|");
    expect(degradeSignature({ mode: "like", recovering: true, reasons: ["search_store_recovering"] }))
      .toBe("like|1|search_store_recovering");
    expect(degradeSignature({ mode: "hybrid", recovering: false, reasons: ["embedding_unhealthy", "vec_unavailable"] }))
      .toBe("hybrid|0|embedding_unhealthy,vec_unavailable");
  });
  it("reasons 乱序/重复不影响签名", () => {
    const a = degradeSignature({ mode: "hybrid", recovering: false, reasons: ["a", "b", "a"] });
    const b = degradeSignature({ mode: "hybrid", recovering: false, reasons: ["b", "a"] });
    expect(a).toBe(b);
  });
});

describe("observeDegrade 跳变采样", () => {
  it("首次健康不打点；健康->降级打一条，detail 只有技术态三键", () => {
    expect(observeDegrade({ mode: "fts", recovering: false, reasons: [] })).toBeNull();
    const hit = observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] });
    expect(hit).not.toBeNull();
    expect(hit!.event).toBe("search_degraded");
    expect(Object.keys(hit!.detail).sort()).toEqual(["mode", "reasons", "recovering"]);
    expect(hit!.detail).toEqual({ mode: "fts", reasons: ["embedding_unhealthy"], recovering: false });
  });

  it("同态连续搜索不打第二条", () => {
    observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] });
    expect(observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] })).toBeNull();
    // reason 集合相同、mode 变化也算新态（实际执行路变化）。
    expect(observeDegrade({ mode: "hybrid", recovering: false, reasons: ["embedding_unhealthy"] })).not.toBeNull();
  });

  it("reason 集合变化（unhealthy -> dim_mismatch）打一条新事件", () => {
    observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] });
    const hit = observeDegrade({ mode: "fts", recovering: false, reasons: ["dim_mismatch"] });
    expect(hit).not.toBeNull();
    expect(hit!.detail.reasons).toEqual(["dim_mismatch"]);
  });

  it("恢复健康不打点但更新记忆；之后再次降级可再打一条", () => {
    observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] });
    expect(observeDegrade({ mode: "fts", recovering: false, reasons: [] })).toBeNull();
    const hit = observeDegrade({ mode: "fts", recovering: false, reasons: ["embedding_unhealthy"] });
    expect(hit).not.toBeNull();
    expect(hit!.detail.reasons).toEqual(["embedding_unhealthy"]);
  });

  it("recovering 自身即降级：无 reason 但 recovering=true 打点；recovering=false 后同 mode 不再打", () => {
    const hit = observeDegrade({ mode: "like", recovering: true, reasons: ["search_store_recovering"] });
    expect(hit).not.toBeNull();
    expect(hit!.detail.recovering).toBe(true);
    expect(observeDegrade({ mode: "like", recovering: true, reasons: ["search_store_recovering"] })).toBeNull();
    expect(observeDegrade({ mode: "like", recovering: false, reasons: [] })).toBeNull();
  });
});
