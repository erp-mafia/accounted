/**
 * The accounts a salary run books its own tax and avgifter on, in BAS terms
 * (SE pack territory, see scripts/checks/jurisdiction-welds.mjs): 2710-2739,
 * personalskatt and the lagstadgade sociala avgifter och särskild löneskatt
 * (2730 and its avräkning accounts 2731 and 2732).
 *
 * The salary booking credits personalskatt and the avgifter from the run's own
 * numbers (tax_withheld, the avgifter), the same numbers the AGI declares and
 * the skattekonto draw clears. A payslip or recurring row on one of these
 * accounts books a tax liability the run did not compute and the AGI does not
 * declare, so the books and the filed AGI disagree by construction
 * (lib/salary/line-account-override.ts refuses such a row). Extra withholding
 * the employee asks for is extra skatt on the employee (extra-tax.ts), which
 * lands in tax_withheld.
 *
 * Pure: the line forms use it client-side.
 */
export function isRunComputedTaxAccount(account: string): boolean {
  return /^27[1-3]\d$/.test(account)
}
