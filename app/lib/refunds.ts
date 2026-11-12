import { RefundStatus } from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;

/** The share of what the learner paid that the instructor owes Cadence for every Refund. */
export const REFUND_FEE_RATE = 0.02;

/** A local `YYYY-MM-DD`, so the window is counted in whole calendar days. */
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * The last calendar day a Refund Request can be raised. Counted in whole
 * days, not hours: someone who buys at 23:00 still gets all of their
 * fourteenth day.
 */
export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

/** The first calendar day after the Refund Window has closed. */
export function refundWindowClosesOn(purchasedAtIso: string): string {
  const closed = new Date(purchasedAtIso);
  closed.setDate(closed.getDate() + REFUND_WINDOW_DAYS + 1);
  return calendarDay(closed);
}

/** The Refund Fee, in cents, for a Refund of `amountPaid` cents. */
export function refundFeeCents(amountPaid: number): number {
  return Math.round(amountPaid * REFUND_FEE_RATE);
}

export type EarningsStatus =
  | { status: "held" }
  | { status: "earned"; earnedOn: string }
  | { status: "refunded"; refundedOn: string };

/**
 * Where the instructor's share of one purchase stands on `today`
 * (`YYYY-MM-DD`): still Held Earnings, Earned Revenue since `earnedOn`, or
 * refunded on `refundedOn`. A Refund Request declined after the window has
 * closed releases the share on the day it was declined.
 */
export function earningsStatusOf(
  purchasedAtIso: string,
  refundRequests: { status: RefundStatus; resolvedAt: string | null }[],
  today: string
): EarningsStatus {
  const approved = refundRequests.find(
    (refundRequest) => refundRequest.status === RefundStatus.Approved
  );
  if (approved) {
    return {
      status: "refunded",
      refundedOn: calendarDay(new Date(approved.resolvedAt ?? purchasedAtIso)),
    };
  }

  if (refundRequests.some((r) => r.status === RefundStatus.Open)) {
    return { status: "held" };
  }

  const releaseDays = refundRequests
    .filter((r) => r.status === RefundStatus.Declined && r.resolvedAt)
    .map((r) => calendarDay(new Date(r.resolvedAt ?? purchasedAtIso)));
  const earnedOn = [refundWindowClosesOn(purchasedAtIso), ...releaseDays]
    .sort()
    .at(-1);

  if (!earnedOn || today < earnedOn) return { status: "held" };
  return { status: "earned", earnedOn };
}
