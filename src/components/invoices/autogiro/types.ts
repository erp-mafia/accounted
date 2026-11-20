/**
 * What the Autogiro session routes (app/api/invoices/autogiro/**) answer, as
 * the page and the customer card read it. Type-only imports: the service
 * modules use node:crypto and must not reach the browser bundle.
 */
import type {
  AutogiroDebitRow,
  AutogiroFileRow,
  AutogiroMandateRow,
  AutogiroOverview,
  AutogiroSettings,
  DebitBlocker,
  DebitStatus,
  DueAutogiroInvoice,
  MandateStatus,
} from '@/lib/invoices/autogiro/service'
import type { AutogiroReportOutcome, ReportDebitLine, ReportMandateLine } from '@/lib/invoices/autogiro/import-report'

export type {
  AutogiroDebitRow,
  AutogiroFileRow,
  AutogiroMandateRow,
  AutogiroOverview,
  AutogiroSettings,
  DebitBlocker,
  DebitStatus,
  DueAutogiroInvoice,
  MandateStatus,
  ReportDebitLine,
  ReportMandateLine,
}

export type OverviewMandate = AutogiroOverview['mandates'][number]

/** GET /api/invoices/autogiro */
export interface AutogiroOverviewResponse {
  enabled: boolean
  overview: AutogiroOverview
}

/** GET /api/invoices/autogiro/mandates?customer_id= */
export interface CustomerMandatesResponse {
  enabled: boolean
  settings_ready: boolean
  mandates: AutogiroMandateRow[]
}

/** A file written for the bank, downloaded through GET /api/invoices/autogiro/files/:id. */
export interface WrittenFileRef {
  id: string
  filename: string
}

/** POST /api/invoices/autogiro/debit-files */
export interface DebitFileResponse {
  file: WrittenFileRef
  debits: number
  total: number
  skipped: DueAutogiroInvoice[]
}

/** POST /api/invoices/autogiro/mandates/:id/cancel */
export interface CancelMandateResponse {
  mandate: AutogiroMandateRow
  file: WrittenFileRef
}

/** The deposits of a payment specification attached to the bank rows (after apply). */
export interface ReportSettlementSummary {
  deposits: number
  matched_deposits: number
  matched_payments: number
  no_row: number
  ambiguous: number
  ready_rows: number
}

/** The answer to internet-bank mandates: never stored, downloaded at once. */
export interface AnswerFile {
  filename: string
  /** Base64 of the ISO 8859-1 bytes. */
  content_base64: string
}

/** POST /api/invoices/autogiro/reports */
export type ReportResponse = Omit<AutogiroReportOutcome, 'settlement' | 'answer_file' | 'repeat'> & {
  /** The same file was read before (a payment specification only re-attaches its deposits). */
  repeat?: boolean
  filename: string
  settlement: ReportSettlementSummary | null
  answer_file: AnswerFile | null
}

/** POST /api/invoices/autogiro/settle */
export interface SettleResponse {
  days: number
  matched_days: number
  debited: number
  ready_rows: number
  no_row: number
  ambiguous: number
}
