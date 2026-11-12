import type { RefundStatus } from "~/db/schema";
import { splitRevenue } from "~/lib/analytics";
import { earningsStatusOf, refundFeeCents } from "~/lib/refunds";

export type PurchaseWithRefundRequests = {
  amountPaid: number;
  createdAt: string;
  refundRequests: { status: RefundStatus; resolvedAt: string | null }[];
};

export type EarningsSummary = {
  earnedGrossCents: number;
  feeCents: number;
  refundFeesCents: number;
  netCents: number;
  earnedCount: number;
  refundCount: number;
  heldGrossCents: number;
  heldCount: number;
};

/**
 * The payout figures on `today` (`YYYY-MM-DD`). Earned Revenue counts on its
 * `earnedOn` day and Refund Fees on their `refundedOn` day, both only from
 * `fromDay` on (all time when null). Held is a snapshot of every purchase
 * still held, whatever the range. Net is earned gross minus the platform fee
 * minus Refund Fees, and can be negative.
 */
export function summarizeEarnings(
  purchases: PurchaseWithRefundRequests[],
  fromDay: string | null,
  today: string
): EarningsSummary {
  const inRange = (day: string) => fromDay === null || day >= fromDay;

  let earnedGrossCents = 0;
  let earnedCount = 0;
  let refundFeesCents = 0;
  let refundCount = 0;
  let heldGrossCents = 0;
  let heldCount = 0;

  for (const purchase of purchases) {
    const earnings = earningsStatusOf(
      purchase.createdAt,
      purchase.refundRequests,
      today
    );

    if (earnings.status === "held") {
      heldGrossCents += purchase.amountPaid;
      heldCount += 1;
    } else if (earnings.status === "earned" && inRange(earnings.earnedOn)) {
      earnedGrossCents += purchase.amountPaid;
      earnedCount += 1;
    } else if (
      earnings.status === "refunded" &&
      inRange(earnings.refundedOn)
    ) {
      refundFeesCents += refundFeeCents(purchase.amountPaid);
      refundCount += 1;
    }
  }

  const { feeCents, netCents } = splitRevenue(earnedGrossCents);

  return {
    earnedGrossCents,
    feeCents,
    refundFeesCents,
    netCents: netCents - refundFeesCents,
    earnedCount,
    refundCount,
    heldGrossCents,
    heldCount,
  };
}

export type EarningsBucket = {
  earnedGrossCents: number;
  refundFeesCents: number;
};

/**
 * Earned gross and Refund Fees on `today`, grouped by `bucketOf` the day each
 * landed on (`earnedOn` or `refundedOn`). Held purchases are left out.
 */
export function earningsByBucket(
  purchases: PurchaseWithRefundRequests[],
  today: string,
  bucketOf: (day: string) => string
): Map<string, EarningsBucket> {
  const buckets = new Map<string, EarningsBucket>();

  const bucketFor = (day: string) => {
    const key = bucketOf(day);
    const bucket = buckets.get(key) ?? {
      earnedGrossCents: 0,
      refundFeesCents: 0,
    };
    buckets.set(key, bucket);
    return bucket;
  };

  for (const purchase of purchases) {
    const earnings = earningsStatusOf(
      purchase.createdAt,
      purchase.refundRequests,
      today
    );

    if (earnings.status === "earned") {
      bucketFor(earnings.earnedOn).earnedGrossCents += purchase.amountPaid;
    } else if (earnings.status === "refunded") {
      bucketFor(earnings.refundedOn).refundFeesCents += refundFeeCents(
        purchase.amountPaid
      );
    }
  }

  return buckets;
}
