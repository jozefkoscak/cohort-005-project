import { getDiscountForCountry } from "~/lib/ppp";

/**
 * Returns the amount, in cents, a Refund gives back for a purchase. A purchase
 * made at a purchasing-power price is given back at that price, any other at
 * the list price of the course.
 */
export function getRefundableAmount(
  purchase: { amountPaid: number; country: string | null },
  coursePrice: number
): number {
  const pppDiscount = getDiscountForCountry(purchase.country);
  return pppDiscount > 0 ? purchase.amountPaid : coursePrice;
}
