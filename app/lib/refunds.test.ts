import { describe, expect, it } from "vitest";
import { RefundStatus } from "~/db/schema";
import {
  earningsStatusOf,
  lastDayOfRefundWindow,
  refundFeeCents,
  refundWindowClosesOn,
} from "./refunds";

const purchasedAt = new Date(2026, 9, 1, 23, 0).toISOString();

describe("refund window", () => {
  it("lasts fourteen whole calendar days after the purchase", () => {
    expect(lastDayOfRefundWindow(purchasedAt)).toBe("2026-10-15");
    expect(refundWindowClosesOn(purchasedAt)).toBe("2026-10-16");
  });
});

describe("refundFeeCents", () => {
  it("is two percent of what the learner paid", () => {
    expect(refundFeeCents(7900)).toBe(158);
    expect(refundFeeCents(3900)).toBe(78);
  });
});

describe("earningsStatusOf", () => {
  it("holds earnings while the refund window is open", () => {
    expect(earningsStatusOf(purchasedAt, [], "2026-10-15")).toEqual({
      status: "held",
    });
  });

  it("earns on the first day after the window closes", () => {
    expect(earningsStatusOf(purchasedAt, [], "2026-10-16")).toEqual({
      status: "earned",
      earnedOn: "2026-10-16",
    });
  });

  it("holds earnings while a refund request is open, even after the window", () => {
    expect(
      earningsStatusOf(
        purchasedAt,
        [{ status: RefundStatus.Open, resolvedAt: null }],
        "2026-11-30"
      )
    ).toEqual({ status: "held" });
  });

  it("earns on the day a late refund request is declined", () => {
    const declinedAt = new Date(2026, 9, 20, 10, 0).toISOString();

    expect(
      earningsStatusOf(
        purchasedAt,
        [{ status: RefundStatus.Declined, resolvedAt: declinedAt }],
        "2026-11-30"
      )
    ).toEqual({ status: "earned", earnedOn: "2026-10-20" });
  });

  it("never earns a refunded purchase", () => {
    const approvedAt = new Date(2026, 9, 5, 10, 0).toISOString();

    expect(
      earningsStatusOf(
        purchasedAt,
        [{ status: RefundStatus.Approved, resolvedAt: approvedAt }],
        "2026-11-30"
      )
    ).toEqual({ status: "refunded", refundedOn: "2026-10-05" });
  });
});
