/**
 * The unexplained queue's contract (see ./registry.ts for the checks).
 *
 * A check is a difference that should be zero (or a list that should be
 * empty) defined once: a stable id, a definition in words and the rule it
 * rests on, the two figures it compares and the report each is read from, a
 * tolerance, and an explanation that names the items behind the difference
 * with typed handles. Every check answers one result per subject (the
 * company, one bank account, one momsperiod):
 *
 *   ok           the figures agree within the tolerance;
 *   unexplained  they do not, and the difference is in the queue;
 *   cannot_check the check could not be run, with a typed reason. A check
 *                that cannot run never answers ok.
 *
 * Read-only: nothing here writes. The operation registry
 * (lib/operations/unexplained.ts) serves it over v1 REST and MCP from one
 * definition, and the agent briefing carries a compact count.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Stable check ids. Neutral English snake_case, public: agents and
 * integrations store them, so an id is never renamed, reused or given
 * another meaning. Add a check with a new id.
 */
export const CHECK_IDS = [
  'receivables_vs_ledger',
  'payables_vs_ledger',
  'bank_balance_vs_bank',
  'skattekonto_vs_skatteverket',
  'vat_declared_not_settled',
  'unbooked_bank_lines_overdue',
] as const

export type CheckId = (typeof CHECK_IDS)[number]

export function isCheckId(value: unknown): value is CheckId {
  return typeof value === 'string' && (CHECK_IDS as readonly string[]).includes(value)
}

export type CheckStatus = 'ok' | 'unexplained' | 'cannot_check'

/** What a result is about. */
export type CheckSubject =
  | { kind: 'company' }
  | {
      kind: 'bank_account'
      cash_account_id: string
      /** Typed handle (cash_...). */
      handle: string | null
      account_number: string
      name: string
    }
  | {
      kind: 'vat_period'
      period_type: 'monthly' | 'quarterly' | 'yearly'
      year: number
      period: number
      start: string
      end: string
      label: string
    }

/** Why a check could not run. Not an error: an answer, listed beside the queue. */
export type CheckRefusalCode =
  /** Kontantmetoden: open invoices are not on the receivables or payables account until the bokslut. */
  | 'CASH_METHOD'
  /** No fiscal period in the books covers the date the check is read at. */
  | 'NO_FISCAL_PERIOD'
  /** The company's jurisdiction pack has no account for a role the check needs. */
  | 'ACCOUNT_ROLE_UNAVAILABLE'
  /** Foreign-currency invoices without an exchange rate: the register total is incomplete. */
  | 'FX_RATE_MISSING'
  /** The bank has reported no balance for the account (manual or file-fed account, or never synced). */
  | 'NO_BANK_BALANCE'
  /** The account is kept in another currency than the ledger: the two balances are not comparable. */
  | 'FOREIGN_CURRENCY_ACCOUNT'
  /** Several bank accounts book on one ledger account: no single balance to compare with. */
  | 'SHARED_LEDGER_ACCOUNT'
  /** No Skatteverket connection and no skattekonto rows. */
  | 'SKATTEKONTO_NOT_CONNECTED'
  /** Skattekonto rows exist but Skatteverket's saldo has never been fetched. */
  | 'NO_SKATTEVERKET_BALANCE'
  /** The company is not registered for VAT. */
  | 'NOT_VAT_REGISTERED'
  /** No momsperiod is recorded as declared, so there is nothing known to be settled. */
  | 'NO_DECLARED_PERIODS'
  /** A source could not be read. `retryable` says whether trying again may help. */
  | 'SOURCE_FAILED'

export interface CheckRefusal {
  code: CheckRefusalCode
  message_sv: string
  message_en: string
  /** SOURCE_FAILED only: a transient failure (timeout, dropped connection) worth one retry. */
  retryable?: boolean
  details?: Record<string, unknown>
}

/** Where a compared figure is read, so a person can see the same number. */
export interface CheckSource {
  /** The report or register, as the product names it. */
  report: string
  /** The v1 endpoint, relative to /api/v1/companies/{companyId}; null when there is none. */
  v1_path: string | null
  /** The MCP tool that answers the same figure. */
  mcp_tool: string
  /** The screen in the app. */
  screen: string | null
}

/** One of the two figures a check compares. */
export interface CheckSide {
  key: string
  label_sv: string
  label_en: string
  /** In the check's unit; null when it could not be read. */
  amount: number | null
  source: CheckSource
}

/** What fixes it: the tool or screen that resolves this kind of difference. */
export interface CheckNextAction {
  message_sv: string
  tool: string
  /** Arguments for `tool` when they follow from the subject. */
  arguments?: Record<string, unknown>
  screen: string
}

/**
 * One run of a check over one subject. `source` is what the run read (the
 * report object, the reconciliation status), which the explanation reuses
 * so it describes the very difference that was answered.
 */
export interface CheckRun<S = unknown> {
  subject: CheckSubject
  status: CheckStatus
  /** Signed, in the check's unit (the definition says which side is subtracted); null when not computed. */
  difference: number | null
  /** The date the comparison holds at. */
  as_of: string
  /** One Swedish sentence for the queue. */
  summary_sv: string
  sides: CheckSide[]
  refusal: CheckRefusal | null
  /** Extra facts worth one glance (cutoff dates, counts); small. */
  facts?: Record<string, unknown>
  source: S | null
}

/** One line of the bridge from the difference to its parts. */
export interface CheckPart {
  key: string
  label_sv: string
  label_en: string
  /** Signed contribution to the difference. */
  amount: number
  count: number
}

/** One item behind a part, with the typed handle of its record. */
export interface CheckItem {
  part: string
  item_type: 'invoice' | 'supplier_invoice' | 'journal_line' | 'transaction' | 'skattekonto_transaction' | 'vat_account'
  invoice_id?: string
  supplier_invoice_id?: string
  journal_entry_id?: string
  transaction_id?: string
  skattekonto_transaction_id?: string
  account_number?: string
  /** Typed handle (inv_, sinv_, je_, txn_), accepted wherever the id is; null for records without one. */
  handle: string | null
  date: string | null
  /** Invoice number, voucher number or text: what a person recognises. */
  label: string
  /** Signed contribution to the difference, in the check's unit. */
  amount: number
  currency?: string
  /** Count checks: the record's own amount, in `currency` (a bank transaction's amount, positive = in). */
  record_amount?: number
  /** unbooked_bank_lines_overdue: days since the last day the row could have been booked. */
  days_past_deadline?: number
}

/** What an explanation answers before paging. */
export interface CheckBreakdown {
  parts: CheckPart[]
  items: CheckItem[]
  /** Difference minus the parts: what the items do not name. Null when there is no difference to explain. */
  residual: number | null
  /** True when the parts account for the difference within the tolerance. */
  reconciles: boolean
  /** Why not, or what else bears on it, in English, for the agent. */
  note?: string
  /**
   * The fix when the parts show the check's own next_action does not apply
   * (it names the usual cause). Taken as is, arguments complete for its tool.
   */
  next_action?: CheckNextAction
}

/** Who asks, for which company, and on which day. Every door builds one. */
export interface CheckContext {
  supabase: SupabaseClient
  companyId: string
  /** The Stockholm calendar date the queue is read on. */
  today: string
}

/** The subject parameters an explanation takes for a check with several subjects. */
export interface CheckSubjectParams {
  cash_account_id?: string
  period_type?: 'monthly' | 'quarterly' | 'yearly'
  year?: number
  period?: number
}

export const SUBJECT_PARAM_KEYS = ['cash_account_id', 'period_type', 'year', 'period'] as const satisfies ReadonlyArray<
  keyof CheckSubjectParams
>

/**
 * One check. `S` is the source object its run read, handed to explain() so
 * an explanation describes the difference that was answered.
 */
export interface CheckDefinition<S = unknown> {
  id: CheckId
  name_sv: string
  name_en: string
  /** Precise definition in English: which figure minus which, read how, and what zero means. */
  definition: string
  /** The same in Swedish, for a person. */
  definition_sv: string
  /** Why it should be zero: the rule it rests on (law, BFNAR, the closing routine). */
  basis: string
  unit: 'SEK' | 'count'
  /** The largest difference that is still ok, in the unit. */
  tolerance: number
  subject_kind: CheckSubject['kind']
  /** The figures compared, in the order of the subtraction. */
  compares: CheckSource[]
  next_action: CheckNextAction
  run: (ctx: CheckContext) => Promise<Array<CheckRun<S>>>
  explain: (ctx: CheckContext, run: CheckRun<S>) => Promise<CheckBreakdown>
}

/** A check with its source type erased, for the registry that holds them all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCheckDefinition = CheckDefinition<any>

export type UnexplainedErrorCode =
  | 'UNEXPLAINED_CHECK_NOT_FOUND'
  | 'UNEXPLAINED_PARAMETER_NOT_ACCEPTED'
  | 'UNEXPLAINED_SUBJECT_REQUIRED'
  | 'UNEXPLAINED_SUBJECT_NOT_FOUND'
