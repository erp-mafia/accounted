/**
 * The liquidity forecast's vocabulary (accounted#136): one flow per krona
 * that is expected to move through the company's bank accounts, tagged with
 * where it comes from and how sure it is, and the projection the flows add
 * up to.
 *
 * Every amount is SEK, positive, rounded with roundOre; the direction says
 * which way it moves. Nothing here writes: a forecast never touches the books.
 */

/** How the forecast knows a flow. */
export type CashFlowKind =
  /** A document or register says the money moves: an open invoice, a payment order, an approved salary run, a filed declaration, Skatteverket's own debit. */
  | 'known'
  /** Computed by rule from the books: VAT so far in an unfiled period, salary for a month without a run, a recurring invoice not yet created. */
  | 'derived'
  /** A forecast row someone wrote (a person, the API, an MCP client, a property management system). */
  | 'forecast'

/** The register a flow is read from. */
export type CashFlowSource =
  | 'customer_invoice'
  | 'supplier_invoice'
  | 'payment_order'
  | 'salary_run'
  | 'salary_estimate'
  | 'skattekonto'
  | 'vat'
  | 'agi'
  | 'f_skatt'
  | 'recurring_invoice'
  | 'forecast_row'

export type CashFlowDirection = 'in' | 'out'

export type ForecastConfidence = 'firm' | 'likely' | 'possible'

/** What a flow points at, so a reader can open it. */
export interface CashFlowRef {
  type:
    | 'invoice'
    | 'supplier_invoice'
    | 'payment_order'
    | 'salary_run'
    | 'recurring_invoice_schedule'
    | 'cash_forecast_row'
    | 'skattekonto'
    | 'vat_period'
    | 'agi_period'
  /** The row id, or the period label (YYYY-MM, YYYY-QN) for a tax period. */
  id: string
}

export interface CashFlow {
  /** YYYY-MM-DD the money is expected to move. */
  date: string
  direction: CashFlowDirection
  /** SEK, > 0. */
  amount: number
  kind: CashFlowKind
  source: CashFlowSource
  /** True for a figure the engine estimated rather than read (an unfiled period's VAT so far, a salary month without a run). */
  estimate: boolean
  /** Customer, supplier or payee name, when there is one. */
  counterparty: string | null
  /** Invoice number, tax period, salary period or the row's note. */
  reference: string | null
  ref: CashFlowRef | null
  /** Forecast rows only. */
  confidence: ForecastConfidence | null
}

/** A non-blocking note about what the forecast could not see or had to assume, in both languages. */
export interface ForecastCaveat {
  code: string
  message_sv: string
  message_en: string
}

export interface ForecastOpeningAccount {
  cash_account_id: string | null
  ledger_account: string
  name: string | null
  balance: number
  /** When the bank reported it; null for a booked balance. */
  balance_updated_at: string | null
}

/**
 * The balance the projection starts from. `bank`: what the banks reported
 * last (cash_accounts.balance), with its age. `booked`: the booked balance of
 * the bank accounts (the bank_balance measure), used only when no bank
 * account has a reported balance; bank rows without a verifikat are not in it.
 */
export interface ForecastOpening {
  amount: number
  source: 'bank' | 'booked' | 'unknown'
  /** The oldest moment a summed bank balance is from (ISO timestamp), or the booked balance's date. */
  as_of: string | null
  /** Whole days between as_of and today; null when unknown. */
  age_days: number | null
  accounts: ForecastOpeningAccount[]
}

export interface ForecastDay {
  date: string
  opening: number
  inflow: number
  outflow: number
  closing: number
  /** The day the projection reaches its lowest closing balance. */
  lowest: boolean
}

export interface ForecastWeek {
  /** ISO 8601 week, e.g. 2026-W44. */
  iso_week: string
  /** Monday. */
  start: string
  /** Sunday. */
  end: string
  opening: number
  inflow: number
  outflow: number
  closing: number
  /** The lowest closing balance of a day in the week (from today on). */
  min_closing: number
  /** The week holds the projection's lowest point. */
  lowest: boolean
}

export interface OverdueReceivable {
  invoice_id: string
  invoice_number: string
  customer_name: string
  due_date: string
  days_overdue: number
  amount: number
}

export interface OverduePayable {
  supplier_invoice_id: string
  supplier_invoice_number: string | null
  supplier_name: string
  due_date: string
  days_overdue: number
  amount: number
}

export interface CashForecast {
  currency: 'SEK'
  /** Today in Stockholm: the first day of the projection. */
  today: string
  horizon: { start: string; end: string; weeks: number }
  opening: ForecastOpening
  /** The first 30 days, one row each (fewer when the horizon is shorter). */
  days: ForecastDay[]
  /** One row per ISO week, the current week first. */
  weeks: ForecastWeek[]
  /** The lowest closing balance over the horizon, the earliest day on a tie. */
  lowest: { date: string; closing: number; iso_week: string }
  /** Closing balance on the last day of the horizon. */
  closing: number
  /** Every flow inside the horizon, by date. */
  flows: CashFlow[]
  /** Past their due date and not paid: listed apart, not in the projection, since nothing says when they move. */
  overdue: {
    receivables: { total: number; invoices: OverdueReceivable[] }
    payables: { total: number; invoices: OverduePayable[] }
  }
  /** False when a source could not be read; its caveat says which. */
  complete: boolean
  caveats: ForecastCaveat[]
}

/** The window every adapter reads: today through the last day of the last week. */
export interface ForecastWindow {
  today: string
  end: string
}
