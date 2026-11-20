/**
 * The measure registry's contract (see ./registry.ts for the measures).
 *
 * A measure is one figure an agent is asked about ("hur mycket moms ska jag
 * betala?", "vad har jag i kundfordringar?") defined once: a stable id, a
 * definition in words, the dimensions it accepts, the report it must equal,
 * a computation that delegates to that report, and an explanation that lists
 * what the figure adds, down to the journal lines or documents. A measure
 * that cannot be computed refuses with a typed code and a Swedish sentence
 * (MeasureRefusal); it never answers a zero it did not compute.
 *
 * Read-only and free of server-only imports beyond the report generators:
 * the operation registry (lib/operations/measures.ts) serves it over v1 REST
 * and MCP from one definition.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReportDataStatusResult } from '@/lib/reports/data-status'

/**
 * Stable measure ids. Neutral English snake_case, public: agents and
 * integrations store them, so an id is never renamed, reused or given
 * another meaning. Add a measure with a new id.
 */
export const MEASURE_IDS = [
  'vat_payable',
  'accounts_receivable',
  'accounts_payable',
  'bank_balance',
  'liquid_funds',
  'result_to_date',
  'net_revenue',
  'operating_expenses',
  'unpaid_customer_invoices',
  'unpaid_supplier_invoices',
] as const

export type MeasureId = (typeof MEASURE_IDS)[number]

export function isMeasureId(value: unknown): value is MeasureId {
  return typeof value === 'string' && (MEASURE_IDS as readonly string[]).includes(value)
}

/**
 * What a measure is measured over:
 *   - period:     a date range inside one fiscal period (period_id, from_date,
 *                 to_date); default the fiscal period that contains today;
 *   - as_of:      a balance date (as_of_date); default today;
 *   - vat_period: a momsperiod (period_type, year, period; period_id for a
 *                 helårsmoms on a broken fiscal year). Required: there is no
 *                 safe default for which declaration is meant.
 */
export type MeasureDimension = 'period' | 'as_of' | 'vat_period'

/** Every parameter a door accepts. A measure takes the ones its dimension names. */
export interface MeasureParams {
  period_id?: string
  from_date?: string
  to_date?: string
  as_of_date?: string
  period_type?: 'monthly' | 'quarterly' | 'yearly'
  year?: number
  period?: number
}

export const MEASURE_PARAM_KEYS = [
  'period_id',
  'from_date',
  'to_date',
  'as_of_date',
  'period_type',
  'year',
  'period',
] as const satisfies ReadonlyArray<keyof MeasureParams>

/** The parameters each dimension accepts. Any other is refused, never ignored. */
export const DIMENSION_PARAMS: Readonly<Record<MeasureDimension, ReadonlyArray<keyof MeasureParams>>> = {
  period: ['period_id', 'from_date', 'to_date'],
  as_of: ['as_of_date'],
  vat_period: ['period_type', 'year', 'period', 'period_id'],
}

/** The fiscal period row the measures read. */
export interface MeasureFiscalPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
}

/** A dimension resolved against the company's books: what the figure covers. */
export type ResolvedScope =
  | {
      kind: 'period'
      fiscalPeriod: MeasureFiscalPeriod
      /** As the caller sent them (the report takes the same); undefined = the period's own bound. */
      fromDate?: string
      toDate?: string
      start: string
      end: string
    }
  | {
      kind: 'as_of'
      asOf: string
      /** True for today: the live state, what the screens show without a date. */
      live: boolean
    }
  | {
      kind: 'vat_period'
      periodType: 'monthly' | 'quarterly' | 'yearly'
      year: number
      period: number
      fiscalPeriodId?: string
    }

/** Which existing report the measure must equal, and where a person or agent reads it. */
export interface MeasureEquals {
  /** The report's name as the product shows it. */
  report: string
  /** The figure in that report's answer the measure equals. */
  figure: string
  /** The v1 report endpoint, relative to /api/v1/companies/{companyId}. */
  v1_path: string
  /** The MCP tool that answers the same report. */
  mcp_tool: string
}

/** A note on a figure that is computed but may not be the whole truth. */
export interface MeasureCaveat {
  code: string
  message_sv: string
  message_en: string
}

/** What a measure's computation answers. */
export interface MeasureComputation {
  value: number
  /** Number of documents behind the value, for the invoice measures; null otherwise. */
  count: number | null
  /** The date the value holds at: the balance date or the range end. */
  as_of: string
  /** The range the value covers. */
  period: { start: string; end: string; fiscal_period_id: string | null }
  caveats: MeasureCaveat[]
  /** The report's own trust signals over the same range; null where none applies. */
  data_status: ReportDataStatusResult | null
}

/** One item the figure adds: an account, a customer or a supplier. */
export interface MeasureContributor {
  kind: 'account' | 'customer' | 'supplier'
  account_number?: string
  customer_id?: string
  supplier_id?: string
  /** Typed handle of the customer or supplier (lib/handles). */
  handle?: string
  name: string
  /** Signed contribution to the value, in the value's unit. */
  amount: number
  /** VAT: the ruta the account lands in. */
  ruta?: string
  /** The account role the account answers for the company's jurisdiction (lib/bookkeeping/account-roles). */
  role?: string
  /** bank_balance: the cash account register row, when the account has one. */
  cash_account_id?: string
  /** Balance measures: the part of `amount` carried in at the fiscal year's start (ingående balans). */
  opening_balance?: number
}

/** One journal line behind a ledger figure. */
export interface MeasureJournalLine {
  journal_entry_id: string
  /** Typed handle (je_...): accepted wherever the journal entry id is. */
  handle: string | null
  voucher_series: string
  voucher_number: number
  date: string
  account_number: string
  description: string
  debit: number
  credit: number
}

/** One open invoice behind an invoice measure. */
export interface MeasureDocument {
  invoice_id?: string
  supplier_invoice_id?: string
  /** Typed handle (inv_... or sinv_...). */
  handle: string | null
  number: string | null
  customer_id?: string
  supplier_id?: string
  counterparty_name: string
  invoice_date: string
  due_date: string
  days_overdue: number
  currency: string
  outstanding: number
  /** Null when a foreign-currency invoice has no rate: not in the value. */
  outstanding_sek: number | null
}

export type MeasureDrilldown =
  | { kind: 'journal_lines'; items: MeasureJournalLine[] }
  | { kind: 'invoices' | 'supplier_invoices'; items: MeasureDocument[] }

/** What a measure's explanation answers before paging. */
export interface MeasureBreakdown {
  contributors: MeasureContributor[]
  drilldown: MeasureDrilldown
  /**
   * True when the contributors add up to the value and every contributor's
   * drill-down adds up to it. False is an answer in itself: the figure stands
   * (it is the report's), the breakdown names what it could not tie out.
   */
  reconciles: boolean
  /** Why reconciles is false, in English, for the agent. */
  reconciliation_note?: string
}

/** Paging of the drill-down list. */
export interface MeasurePage {
  limit: number
  offset: number
}

/** Who asks, for which company. Every door builds one. */
export interface MeasureContext {
  supabase: SupabaseClient
  companyId: string
}

/** A computation with the report it read, which the explanation reuses instead of reading it again. */
export interface MeasureComputed<S> {
  result: MeasureComputation
  source: S
}

/**
 * One measure. `S` is the report object the computation read (the trial
 * balance rows, the momsdeklaration, the reskontra): explain() takes it so
 * an explanation describes the very figure that was answered.
 */
export interface MeasureDefinition<S = unknown> {
  id: MeasureId
  name_sv: string
  name_en: string
  /** Precise definition in English: what is summed, over which accounts or documents, on what basis. */
  definition: string
  /** The same in Swedish, for a person. */
  definition_sv: string
  unit: 'SEK'
  dimension: MeasureDimension
  equals: MeasureEquals
  compute: (ctx: MeasureContext, scope: ResolvedScope) => Promise<MeasureComputed<S>>
  explain: (ctx: MeasureContext, scope: ResolvedScope, computed: MeasureComputed<S>) => Promise<MeasureBreakdown>
}

/** A measure with its source type erased, for the registry that holds them all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMeasureDefinition = MeasureDefinition<any>

export type MeasureRefusalCode =
  | 'MEASURE_NOT_FOUND'
  | 'MEASURE_PARAMETER_NOT_ACCEPTED'
  | 'MEASURE_PERIOD_REQUIRED'
  | 'MEASURE_PERIOD_NOT_FOUND'
  | 'MEASURE_RANGE_INVALID'
  | 'MEASURE_ACCOUNT_ROLE_UNAVAILABLE'
  | 'MEASURE_SOURCE_FAILED'

/**
 * A measure that cannot be computed. Thrown inside the registry and turned
 * into a typed operation failure at its edge (./compute.ts): the code is in
 * lib/errors/structured-errors.ts, the Swedish sentence names what is missing.
 */
export class MeasureRefusal extends Error {
  readonly code: MeasureRefusalCode
  readonly messageSv: string
  readonly details: Record<string, unknown>

  constructor(code: MeasureRefusalCode, messageSv: string, details: Record<string, unknown> = {}) {
    super(messageSv)
    this.name = 'MeasureRefusal'
    this.code = code
    this.messageSv = messageSv
    this.details = details
  }
}
