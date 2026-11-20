/**
 * The ISO 20022 pain.001 value rules both payment files write, the salary
 * file (lib/salary/payment/pain001-generator.ts) and the supplier file
 * (lib/payments/pain001-supplier.ts), which each kept their own copy.
 *
 * Amounts are rendered to öre with roundOre, and a control sum adds the
 * amounts AS RENDERED: CtrlSum must equal the sum of the InstdAmt values or
 * the bank refuses the file, so summing the raw values and rounding once can
 * differ by an öre.
 */
import { roundOre } from '@/lib/money'

/** An amount as pain.001 writes it: two decimals, dot separator. */
export function formatPainAmount(amount: number): string {
  return roundOre(amount).toFixed(2)
}

/** The control sum of the amounts as rendered (each rounded to öre first). */
export function painControlSum(amounts: Iterable<number>): number {
  let sum = 0
  for (const amount of amounts) sum = roundOre(sum + roundOre(amount))
  return sum
}

/** Truncate to Max35Text. */
export function max35(value: string): string {
  return value.slice(0, 35)
}

/**
 * Append a suffix to a base id, truncating the BASE so the result stays
 * Max35Text: the suffix carries the uniqueness (a per-transaction counter)
 * and must survive intact.
 */
export function suffixId(base: string, suffix: string): string {
  return base.slice(0, Math.max(1, 35 - suffix.length)) + suffix
}
