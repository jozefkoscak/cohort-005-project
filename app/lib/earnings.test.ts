import { describe, it, expect } from "vitest";
import { RefundStatus } from "~/db/schema";
import { formatMoney } from "./analytics";
import {
  earningsByBucket,
  summarizeEarnings,
  type PurchaseWithRefundRequests,
} from "./earnings";

const TODAY = "2026-06-30";

function purchase(
  createdAt: string,
  amountPaid: number,
  refundRequests: PurchaseWithRefundRequests["refundRequests"] = []
): PurchaseWithRefundRequests {
  return { createdAt, amountPaid, refundRequests };
}

describe("summarizeEarnings", () => {
  it("counts a purchase as earned on the day its refund window closes", () => {
    const summary = summarizeEarnings(
      [purchase("2026-06-01T10:00:00", 10_000)],
      "2026-06-16",
      TODAY
    );

    expect(summary).toMatchObject({
      earnedGrossCents: 10_000,
      feeCents: 2_000,
      refundFeesCents: 0,
      netCents: 8_000,
      earnedCount: 1,
      heldGrossCents: 0,
    });
  });

  it("leaves earnings that landed before the range out of the range", () => {
    const summary = summarizeEarnings(
      [purchase("2026-06-01T10:00:00", 10_000)],
      "2026-06-17",
      TODAY
    );

    expect(summary.earnedGrossCents).toBe(0);
    expect(summary.earnedCount).toBe(0);
  });

  it("holds a purchase still inside its refund window, whatever the range", () => {
    const summary = summarizeEarnings(
      [purchase("2026-06-25T10:00:00", 4_999)],
      "2026-06-29",
      TODAY
    );

    expect(summary).toMatchObject({
      earnedGrossCents: 0,
      heldGrossCents: 4_999,
      heldCount: 1,
    });
  });

  it("holds a purchase with an open refund request after its window closed", () => {
    const summary = summarizeEarnings(
      [
        purchase("2026-05-01T10:00:00", 4_999, [
          { status: RefundStatus.Open, resolvedAt: null },
        ]),
      ],
      null,
      TODAY
    );

    expect(summary.heldGrossCents).toBe(4_999);
    expect(summary.earnedGrossCents).toBe(0);
  });

  it("charges a refund fee and no platform fee on a refunded purchase", () => {
    const summary = summarizeEarnings(
      [
        purchase("2026-06-20T10:00:00", 10_000, [
          {
            status: RefundStatus.Approved,
            resolvedAt: "2026-06-22T09:00:00",
          },
        ]),
      ],
      "2026-06-01",
      TODAY
    );

    expect(summary).toMatchObject({
      earnedGrossCents: 0,
      feeCents: 0,
      refundFeesCents: 200,
      netCents: -200,
      refundCount: 1,
      heldGrossCents: 0,
    });
  });

  it("subtracts refund fees from what was earned, so the figures add up", () => {
    const summary = summarizeEarnings(
      [
        purchase("2026-05-01T10:00:00", 10_000),
        purchase("2026-06-20T10:00:00", 7_900, [
          {
            status: RefundStatus.Approved,
            resolvedAt: "2026-06-22T09:00:00",
          },
        ]),
      ],
      null,
      TODAY
    );

    expect(summary.netCents).toBe(
      summary.earnedGrossCents - summary.feeCents - summary.refundFeesCents
    );
    expect(summary.netCents).toBe(10_000 - 2_000 - 158);
  });
});

describe("earningsByBucket", () => {
  it("groups earned gross by earned day and refund fees by refund day", () => {
    const buckets = earningsByBucket(
      [
        purchase("2026-05-01T10:00:00", 10_000),
        purchase("2026-05-20T10:00:00", 5_000),
        purchase("2026-06-20T10:00:00", 7_900, [
          {
            status: RefundStatus.Approved,
            resolvedAt: "2026-06-22T09:00:00",
          },
        ]),
        purchase("2026-06-25T10:00:00", 3_000),
      ],
      TODAY,
      (day) => day.slice(0, 7)
    );

    expect(Object.fromEntries(buckets)).toEqual({
      "2026-05": { earnedGrossCents: 10_000, refundFeesCents: 0 },
      "2026-06": { earnedGrossCents: 5_000, refundFeesCents: 158 },
    });
  });
});

describe("formatMoney with a negative net", () => {
  it("puts the minus sign before the currency symbol", () => {
    expect(formatMoney(-1_234)).toBe("-$12.34");
  });
});
