import { describe, it, expect } from "vitest";
import { getRefundableAmount } from "./refunds";

describe("getRefundableAmount", () => {
  it("gives back the list price for a full-price purchase", () => {
    expect(getRefundableAmount({ amountPaid: 5000, country: "US" }, 7900)).toBe(
      7900
    );
  });

  it("gives back the list price when the purchase has no country", () => {
    expect(getRefundableAmount({ amountPaid: 5000, country: null }, 7900)).toBe(
      7900
    );
  });

  it("gives back what was paid for a purchasing-power purchase", () => {
    expect(getRefundableAmount({ amountPaid: 3950, country: "IN" }, 7900)).toBe(
      3950
    );
  });
});
