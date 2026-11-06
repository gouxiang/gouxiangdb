/**
 * 闸门①事务断言（seatGate）单测：直接构造授权视图 + 假 tx（COUNT 桩），不连真库。
 * 覆盖：gate=null 零查询放行、各 verdict 满员分流文案、verify 不拦、空位放行。
 * seatAddBlockReason 的纯策略已在 seats.test 锁定，这里聚焦"事务内 COUNT + 抛 HttpError"接线。
 */
import { describe, it, expect, vi } from "vitest";
import { assertSeatAddAllowedTx, LICENSE_SEAT_LIMIT } from "../seatGate.js";
import { LICENSE_COPY } from "../copy.js";
import type { EntitlementView } from "../state.js";
import { HttpError } from "../../../httpError.js";

function fakeTx(countResult: number) {
  const count = vi.fn(async () => countResult);
  return { tx: { user: { count } } as never, count };
}

function view(partial: Partial<EntitlementView>): EntitlementView {
  return { mode: "enforce", verdict: "free", seats: 5, everCommercial: false, ...partial };
}

describe("assertSeatAddAllowedTx 闸门①", () => {
  it("gate=null（off/verify/运行时未启动）：不查 COUNT、直接放行", async () => {
    const { tx, count } = fakeTx(99);
    await expect(assertSeatAddAllowedTx(tx, null)).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("enforce + free + occupied=5：403 LICENSE_SEAT_LIMIT + 免费文案", async () => {
    const { tx } = fakeTx(5);
    await expect(assertSeatAddAllowedTx(tx, view({ verdict: "free", seats: 5 }))).rejects.toMatchObject({
      status: 403,
      code: LICENSE_SEAT_LIMIT,
      message: LICENSE_COPY.seatLimitFree,
    } satisfies Partial<HttpError>);
  });

  it("enforce + grandfathered + occupied=5：祖父文案", async () => {
    const { tx } = fakeTx(5);
    await expect(
      assertSeatAddAllowedTx(tx, view({ verdict: "grandfathered", seats: 5, everCommercial: false })),
    ).rejects.toMatchObject({ status: 403, message: LICENSE_COPY.seatLimitGrandfathered });
  });

  it("enforce + licensed 满员（单据 10 席，occupied=10）：商业席位文案", async () => {
    const { tx } = fakeTx(10);
    await expect(
      assertSeatAddAllowedTx(tx, view({ verdict: "licensed", seats: 10, everCommercial: true })),
    ).rejects.toMatchObject({ status: 403, message: LICENSE_COPY.seatLimitCommercial });
  });

  it("enforce + expired/invalid 回落 5 席，occupied=5：按商业满员文案", async () => {
    for (const verdict of ["expired", "invalid"] as const) {
      const { tx } = fakeTx(5);
      await expect(
        assertSeatAddAllowedTx(tx, view({ verdict, seats: 5, everCommercial: true })),
      ).rejects.toMatchObject({ status: 403, code: LICENSE_SEAT_LIMIT });
    }
  });

  it("verify 档即使满员也不拦（只通电）", async () => {
    const { tx, count } = fakeTx(5);
    await assertSeatAddAllowedTx(tx, view({ mode: "verify", verdict: "free", seats: 5 }));
    // verify 由 seatAddBlockReason 内部先返 null；本断言仍 COUNT（无害），关键是不抛。
    expect(count).toHaveBeenCalled();
  });

  it("enforce + licensed 有空位（occupied=5 < seats=10）：放行", async () => {
    const { tx } = fakeTx(5);
    await expect(
      assertSeatAddAllowedTx(tx, view({ verdict: "licensed", seats: 10, everCommercial: true })),
    ).resolves.toBeUndefined();
  });

  it("enforce + free + occupied=0（空库首 owner）：放行", async () => {
    const { tx } = fakeTx(0);
    await expect(assertSeatAddAllowedTx(tx, view({ verdict: "free", seats: 5 }))).resolves.toBeUndefined();
  });
});
