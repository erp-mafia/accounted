/**
 * The account role vocabulary: what a posting or a report means by an
 * account, independent of any country's chart.
 *
 * A call site asks for a role ("the receivables account") instead of
 * spelling a chart number, and the company's jurisdiction pack answers with
 * its account (lib/bookkeeping/account-roles/index.ts). Sweden is pack one,
 * with the BAS defaults in ./se-bas.ts; another country supplies its own
 * accounts for the same roles.
 *
 * Ids are neutral English snake_case and stable: a role may be added, never
 * renamed or given another meaning, because packs, tests and (later) the
 * posting port and its booking proposals key on them. A role belongs here
 * only when a call site needs it; per-rate VAT roles name the rate, so a pack
 * supplies the rates its country has and leaves the others out.
 */
export const ACCOUNT_ROLES = [
  /** The bank account a payment settles on when nothing names a specific one. */
  'bank',
  /** Trade receivables from customers: the customer ledger's control account. */
  'accounts_receivable',
  /** Trade payables to suppliers: the supplier ledger's control account. */
  'accounts_payable',
  /** Output VAT on domestic sales at 25 %. */
  'output_vat_25',
  /** Output VAT on domestic sales at 12 %. */
  'output_vat_12',
  /** Output VAT on domestic sales at 6 %. */
  'output_vat_6',
  /** Deductible input VAT charged by suppliers. */
  'input_vat',
  /** The clearing account a VAT period's net is moved to; credit is VAT to pay. */
  'vat_settlement',
  /** Net VAT the tax authority owes the company back (a refund period). */
  'vat_receivable',
  /** Rounding differences: minor-unit and whole-unit rounding on payments and filings. */
  'rounding',
] as const

export type AccountRole = (typeof ACCOUNT_ROLES)[number]

/** One pack's answer per role. A role the pack has no account for is absent. */
export type AccountRoleAccounts = Readonly<Partial<Record<AccountRole, string>>>

const ROLE_SET: ReadonlySet<string> = new Set(ACCOUNT_ROLES)

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && ROLE_SET.has(value)
}
