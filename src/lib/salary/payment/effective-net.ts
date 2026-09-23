/**
 * The net amount actually paid out to an employee's bank account for a salary
 * run, honoring any manual tax-withheld override. This is exactly the figure
 * written into the pain.001 / Bankgirot LB payment files.
 *
 * Bank details (clearing + account number) are only required when this is > 0:
 * a zero payout: e.g. a nollkörning, or an employee whose net is fully
 * consumed by a nettolöneavdrag: produces no payment-file line, so there is
 * no destination account to fill in. Gating the bank-details requirement on
 * this keeps the approve guard and the payment-file generators in agreement.
 */
export interface EffectiveNetInput {
  net_salary: number
  tax_withheld: number
  tax_withheld_override?: number | null
}

export function effectiveNetPayout(sre: EffectiveNetInput): number {
  // net_salary was computed with the calculated tax; if the user overrode the
  // tax, the payout shifts by the difference (lower tax → higher payout).
  return sre.net_salary + (sre.tax_withheld - (sre.tax_withheld_override ?? sre.tax_withheld))
}
