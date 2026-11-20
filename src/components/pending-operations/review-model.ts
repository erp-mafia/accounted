/**
 * The review of ONE proposal (Rutin, Att göra V8) as data: the fixed
 * template's parts read off a staged operation. Head (the headline amount),
 * underlag (the file, the bank row, or the plain "saknas" state), the typed
 * fields of the proposal, the one reason line, what is missing, the history,
 * and the order the proposals are walked in.
 *
 * Pure: nothing here renders, fetches or decides what an approval does. Every
 * value comes from fields the staged operation already carries; a part the
 * operation has no data for is null or empty, never invented.
 */

import type { PendingOperation } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isUuid } from '@/lib/invariants/uuid'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { isHandledElsewhere } from '@/lib/pending-operations/handled-elsewhere'
import { closedByRefusalReason } from '@/lib/pending-operations/approval-refusal'
import { currencyForField } from './preview-facts'
import { bankRowDocumentRef, proposalDocumentRef, type DocumentFileRef, type ProposalDocumentRef } from './proposal-document'
import { complianceWarningOf, type ComplianceWarning } from './vocabulary'

type Data = Record<string, unknown>

function record(value: unknown): Data {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ------------------------------------------------------------ typed fields */

/**
 * A field's label: a fixed Swedish word the previews have always used
 * ("Datum"), or a key in the "pending" message namespace.
 */
export type FactLabel = string | { key: string }

export type FactValue =
  /** `valueKey`: a "pending" message key that says the code in words, used when it exists. */
  | { kind: 'text'; text: string; valueKey?: string }
  /** An identifier or a date as staged: monospace figures. */
  | { kind: 'code'; text: string }
  /** '-' when the preview carries no number, never "NaN kr". */
  | { kind: 'money'; amount: number | null; currency: string }
  /** A sentence of the "pending" namespace with values. */
  | { kind: 'message'; key: string; values: Record<string, string | number> }

export interface FactRow {
  id: string
  label: FactLabel
  value: FactValue
  /** The row the others add up to (Totalt). */
  strong?: boolean
}

const row = (id: string, label: FactLabel, value: FactValue, strong?: boolean): FactRow =>
  strong ? { id, label, value, strong } : { id, label, value }

const str = (value: unknown): string => String(value ?? '')

/** The momsdeklaration impact a staged create_voucher carries (crm#1447); null when there is nothing to say. */
export function vatDeclarationSummary(value: unknown): string | null {
  const v = record(value)
  const { summary, status, counted, rutor_change: change } = v
  if (typeof summary !== 'string' || summary === '' || status === 'not_vat_registered') return null
  const moves = Object.keys(record(change)).length > 0
  if (status === 'ok' && counted === true && !moves) return null
  return summary
}

function customerFacts(data: Data): FactRow[][] {
  const rows = [
    row('name', 'Namn', { kind: 'text', text: str(data.name) }),
    row('customer_type', 'Typ', {
      kind: 'text',
      text: str(data.customer_type),
      valueKey: `preview_value.customer_type.${str(data.customer_type)}`,
    }),
  ]
  if (data.customer_number) rows.push(row('customer_number', 'Kundnr', { kind: 'code', text: str(data.customer_number) }))
  if (data.email) rows.push(row('email', 'E-post', { kind: 'text', text: str(data.email) }))
  if (data.org_number) rows.push(row('org_number', 'Org.nr', { kind: 'code', text: str(data.org_number) }))
  if (data.personal_number_masked) {
    rows.push(row('personal_number_masked', 'Personnr', { kind: 'code', text: str(data.personal_number_masked) }))
  }
  return [rows]
}

function transactionFacts(data: Data): FactRow[][] {
  const currency = text(data.currency) ?? 'SEK'
  const rows = [
    row('date', 'Datum', { kind: 'code', text: str(data.date) }),
    row('description', 'Beskrivning', { kind: 'text', text: str(data.description) }),
    row('amount', 'Belopp', { kind: 'money', amount: finite(data.amount), currency }),
  ]
  if (data.external_id) rows.push(row('external_id', 'Extern referens', { kind: 'code', text: str(data.external_id) }))
  return [rows]
}

/**
 * The head of a verifikat preview. `showSeries` is false for a
 * toEntryPreview payload, which carries no series: the engine picks it per
 * source type at commit, so stating "A" would name a series it may not get.
 */
export function voucherFacts(data: Data, showSeries = true): FactRow[] {
  const rows: FactRow[] = []
  if (data.entry_date) rows.push(row('entry_date', 'Datum', { kind: 'code', text: str(data.entry_date) }))
  if (data.description) rows.push(row('description', 'Beskrivning', { kind: 'text', text: str(data.description) }))
  if (showSeries) rows.push(row('voucher_series', 'Serie', { kind: 'code', text: str(data.voucher_series ?? 'A') }))
  const vat = vatDeclarationSummary(data.vat_declaration)
  if (vat) rows.push(row('vat_declaration', { key: 'preview_vat_declaration' }, { kind: 'text', text: vat }))
  return rows
}

function categorizeFacts(data: Data): FactRow[][] {
  const rows: FactRow[] = []
  // Entry date first: with two open fiscal years the approver could not tell
  // which year a categorization belonged to.
  if (text(data.date)) rows.push(row('date', 'Datum', { kind: 'code', text: str(data.date) }))
  // Journal lines are always SEK (BFL 5 kap 2 §): a bank row in another
  // currency is stated beside them, in its own.
  const currency = text(data.currency) ?? 'SEK'
  const amount = finite(data.amount)
  if (!isLedgerCurrency(currency) && amount !== null) {
    rows.push(row('amount', 'Banktransaktion', { kind: 'money', amount, currency }))
  }
  return [rows]
}

function bulkBookFacts(data: Data): FactRow[][] {
  const currency = text(data.currency) ?? 'SEK'
  const txCount = finite(data.tx_count)
  const txSum = finite(data.tx_sum)
  const from = str(data.tx_date)
  const rows = [
    row(
      'tx_date',
      'Datum',
      // A link may carry rows of several dates: earliest and latest.
      data.tx_date_to
        ? { kind: 'message', key: 'preview_field.date_range', values: { from, to: str(data.tx_date_to) } }
        : { kind: 'code', text: from },
    ),
    row('tx_count', 'Transaktioner', {
      kind: 'code',
      text: `${txCount ?? '-'}${txSum !== null ? ` · ${formatCurrency(txSum, currency)}` : ''}`,
    }),
    row(
      'mode',
      { key: 'preview_bulk_action' },
      { kind: 'message', key: data.mode === 'link_existing' ? 'preview_bulk_link_existing' : 'preview_bulk_new_voucher', values: {} },
    ),
  ]
  if (data.entry_description) {
    rows.push(row('entry_description', 'Beskrivning', { kind: 'text', text: str(data.entry_description) }))
  }
  return [rows]
}

function invoiceFacts(data: Data): FactRow[][] {
  const currency = text(data.currency) ?? 'SEK'
  return [
    [
      row('customer_name', 'Kund', { kind: 'text', text: str(data.customer_name) }),
      row('invoice_date', 'Datum', { kind: 'text', text: str(data.invoice_date) }),
      row('due_date', { key: 'preview_field.due_date' }, { kind: 'text', text: str(data.due_date) }),
    ],
    [
      row('subtotal', 'Netto', { kind: 'money', amount: finite(data.subtotal), currency }),
      row('vat_amount', 'Moms', { kind: 'money', amount: finite(data.vat_amount), currency }),
      row('total', 'Totalt', { kind: 'money', amount: finite(data.total), currency }, true),
    ],
  ]
}

/**
 * A supplier invoice read from the inbox, in the order a person checks it
 * against the file: who, which invoice, when, how it is paid, then the sums.
 */
function supplierInvoiceFacts(data: Data): FactRow[][] {
  const currency = text(data.currency) ?? 'SEK'
  const field = (key: string) => ({ key: `preview_field.${key}` })
  const head: FactRow[] = []
  const supplier = text(data.supplier_name) ?? text(data.extracted_supplier_name)
  if (supplier) head.push(row('supplier_name', field('supplier_name'), { kind: 'text', text: supplier }))
  if (text(data.supplier_invoice_number)) {
    head.push(row('supplier_invoice_number', field('invoice_number'), { kind: 'code', text: str(data.supplier_invoice_number) }))
  }
  if (text(data.invoice_date)) head.push(row('invoice_date', field('invoice_date'), { kind: 'code', text: str(data.invoice_date) }))
  if (text(data.due_date)) head.push(row('due_date', field('due_date'), { kind: 'code', text: str(data.due_date) }))
  if (text(data.payment_reference)) {
    head.push(row('payment_reference', field('payment_reference'), { kind: 'code', text: str(data.payment_reference) }))
  }
  if (text(data.invoice_account)) head.push(row('invoice_account', field('invoice_account'), { kind: 'code', text: str(data.invoice_account) }))
  return [
    head,
    [
      row('subtotal', field('subtotal'), { kind: 'money', amount: finite(data.subtotal), currency }),
      row('vat_amount', field('vat_amount'), { kind: 'money', amount: finite(data.vat_amount), currency }),
      row('total', field('total'), { kind: 'money', amount: finite(data.total), currency }, true),
    ],
  ]
}

/** The invoice a bank row is matched to; the bank row itself is the proposal's underlag. */
function matchInvoiceFacts(data: Data): FactRow[][] {
  const field = (key: string) => ({ key: `preview_field.${key}` })
  const rows: FactRow[] = [row('invoice_number', field('invoice_number'), { kind: 'code', text: text(data.invoice_number) ?? '-' })]
  if (text(data.customer_name)) rows.push(row('customer_name', field('customer_name'), { kind: 'text', text: str(data.customer_name) }))
  if (text(data.invoice_date)) rows.push(row('invoice_date', field('invoice_date'), { kind: 'code', text: str(data.invoice_date) }))
  rows.push(
    row(
      'invoice_total',
      field('total'),
      { kind: 'money', amount: finite(data.invoice_total), currency: text(data.invoice_currency) ?? text(data.transaction_currency) ?? 'SEK' },
      true,
    ),
  )
  return [rows]
}

/**
 * The typed fields of the operation types whose preview is fields only (and,
 * for the ones that book, a verifikat under them): one group per block of the
 * preview. Null for a type that has no such mapping; its preview states its
 * fields itself (the labelled facts of the generic preview, an update's
 * before and after, a match's two sides).
 */
export function proposalFacts(operationType: string, previewData: unknown): FactRow[][] | null {
  const data = record(previewData)
  switch (operationType) {
    case 'create_customer':
      return customerFacts(data)
    case 'create_transaction':
      return transactionFacts(data)
    case 'create_voucher':
      return [voucherFacts(data)]
    case 'categorize_transaction':
      return categorizeFacts(data)
    case 'bulk_book_transactions':
      return bulkBookFacts(data)
    case 'create_invoice':
      return isRegisterBookedInvoiceParams(data) ? null : invoiceFacts(data)
    case 'create_supplier_invoice_from_inbox':
      return isRegisterBookedInvoiceParams(data) ? null : supplierInvoiceFacts(data)
    case 'match_transaction_invoice':
      return matchInvoiceFacts(data)
    default:
      return null
  }
}

/* ------------------------------------------------------------------- head */

/** A kontering row as the staged previews write one. */
function isPostingLine(value: unknown): boolean {
  const line = record(value)
  return (
    ('account' in line || 'account_number' in line) &&
    ('debit' in line || 'credit' in line || 'debit_amount' in line || 'credit_amount' in line)
  )
}

function isPostingLines(value: unknown): value is Data[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPostingLine)
}

/** The staged verifikat rows of a proposal that books, wherever its preview keeps them. */
export function stagedPostingLines(previewData: unknown): Data[] {
  const data = record(previewData)
  for (const key of ['lines', 'preview_lines']) {
    if (isPostingLines(data[key])) return data[key]
  }
  for (const value of Object.values(data)) {
    const nested = record(value)
    if (isPostingLines(nested.lines)) return nested.lines
  }
  return []
}

// The preview's own statement of what the proposal is worth, in the order a
// reader means it: the total of a document, the amount of a bank row or a
// payment, the sum of a batch.
const HEADLINE_KEYS = ['total', 'amount', 'transaction_amount', 'payment_amount', 'total_amount', 'tx_sum'] as const

/**
 * The headline number of a proposal: the amount its preview states, else the
 * debit total of the verifikat it posts (always SEK). Null when it names no
 * amount (a new customer). `currency` is null when the preview names some
 * other field's currency only: the figure then shows without a unit.
 */
export function headlineAmount(op: Pick<PendingOperation, 'preview_data'>): { value: number; currency: string | null } | null {
  const data = record(op.preview_data)
  for (const key of HEADLINE_KEYS) {
    const value = finite(data[key])
    if (value !== null) return { value, currency: currencyForField(key, data) }
  }
  const stated = finite(data.total_debit)
  if (stated !== null) return { value: stated, currency: 'SEK' }
  // A rättelse or a storno carries the verifikat it replaces beside the one
  // it posts: the headline is the one it posts.
  const posted = [record(data.correction), record(data.reversal)].find((entry) => isPostingLines(entry.lines))
  const lines = posted ? (posted.lines as Data[]) : stagedPostingLines(data)
  if (lines.length === 0) return null
  const debit = lines.reduce((sum, line) => sum + (Number(line.debit_amount ?? line.debit) || 0), 0)
  return debit > 0 ? { value: roundOre(debit), currency: 'SEK' } : null
}

/* ---------------------------------------------------------------- underlag */

export interface ReviewBankRow {
  date: string | null
  text: string | null
  amount: number | null
  currency: string
}

export interface ReviewUnderlag {
  /** The file the proposal is about, shown as the file. */
  document: ProposalDocumentRef | null
  /** The bank row the proposal acts on, where its preview describes the row. */
  bankRow: ReviewBankRow | null
  /**
   * The bank row the proposal names, when it carries no file of its own: the
   * row's underlag (the receipt pinned or matched to it) is the proposal's,
   * and is read where the review opens. Every type that names one bank row,
   * not a list of types: only a categorisation looked it up, so a payment
   * matched to an invoice never showed the file on its bank row (crm#1977).
   */
  transactionId: string | null
  /**
   * The proposal books the row from the row alone (a categorisation): a row
   * without underlag is then a gap the review states. For the rest the row's
   * file is shown when it has one, and nothing is said when it has none.
   */
  rowUnderlagExpected: boolean
  /**
   * The bank rows the proposal names when it names several (a
   * samlingsverifikat's params.tx_ids), each once, in its own order. Every
   * row's underlag is the proposal's: the slot showed one file, so a batch
   * showed none of its rows' files (crm#1977). Empty for every other
   * proposal.
   */
  rowIds: string[]
  /** The staging tool said the verifikat has no underlag (BFL 5 kap 6 §). */
  missing: boolean
}

/** The previews that draw their document beside what it is linked to; the review moves it to the underlag slot. */
const OWN_DOCUMENT_TYPES = new Set(['attach_document_to_transaction', 'link_document_to_voucher'])

/**
 * Proposals whose preview describes the bank row they act on, and the fields
 * that do. A categorisation is not here: its preview states the amount
 * unsigned and no bank text, so the row is not drawn from it.
 */
const BANK_ROW_FIELDS: Record<string, { date: string; text: string; amount: string; currency: string }> = {
  attach_document_to_transaction: {
    date: 'transaction_date',
    text: 'transaction_description',
    amount: 'transaction_amount',
    currency: 'transaction_currency',
  },
  match_transaction_invoice: {
    date: 'transaction_date',
    text: 'transaction_description',
    amount: 'transaction_amount',
    currency: 'transaction_currency',
  },
}

/** Their transaction_id names a skattekonto row, which is no bank row and has no underlag to read. */
const NOT_A_BANK_ROW = new Set(['book_skattekonto_row'])

/** They book a bank row from the row alone: a row without underlag is a gap the review states. */
const ROW_UNDERLAG_EXPECTED = new Set(['categorize_transaction'])

/** Null when the proposal has no underlag to speak of (a new customer): the section is then left out. */
export function underlagOf(
  op: Pick<PendingOperation, 'operation_type' | 'preview_data' | 'params' | 'status'>,
): ReviewUnderlag | null {
  const data = record(op.preview_data)
  const params = record(op.params)
  let document = proposalDocumentRef(op)
  if (!document && OWN_DOCUMENT_TYPES.has(op.operation_type) && isUuid(params.document_id)) {
    document = {
      kind: 'document',
      documentId: params.document_id,
      fileName: text(data.document_file_name),
      mime: text(data.document_mime_type),
    }
  }
  const fields = BANK_ROW_FIELDS[op.operation_type]
  const bankRow: ReviewBankRow | null =
    fields && (text(data[fields.date]) || finite(data[fields.amount]) !== null)
      ? {
          date: text(data[fields.date]),
          text: text(data[fields.text]),
          amount: finite(data[fields.amount]),
          currency: text(data[fields.currency]) ?? 'SEK',
        }
      : null
  const transactionId =
    !document && !NOT_A_BANK_ROW.has(op.operation_type) && isUuid(params.transaction_id) ? params.transaction_id : null
  const rowUnderlagExpected = transactionId != null && ROW_UNDERLAG_EXPECTED.has(op.operation_type)
  const rowIds = !document && Array.isArray(params.tx_ids) ? [...new Set(params.tx_ids.filter(isUuid))] : []
  const missing = !document && complianceWarningOf(op)?.kind === 'missing_underlag'
  return document || bankRow || missing || transactionId || rowIds.length > 0
    ? { document, bankRow, transactionId, rowUnderlagExpected, rowIds, missing }
    : null
}

/** What the review read for the bank row's own underlag. */
export interface RowUnderlagRead {
  loading: boolean
  failed: boolean
  document: ProposalDocumentRef | null
}

export type UnderlagState =
  | { kind: 'document'; document: ProposalDocumentRef }
  | { kind: 'loading' | 'failed' | 'missing' | 'none' }

/**
 * The one thing the underlag slot shows above the bank row: the file, that it
 * is being read, that it could not be read, that there is none where there
 * should be one, or nothing. The "Underlag" heading heads the three states in
 * the middle and nothing else: the file names itself, and with 'none' the
 * heading used to stand alone over the bank row of a matched payment, as if
 * its underlag had failed to show (crm#1977).
 *
 * A file wins over what the staging tool said when it staged: the row may
 * have got its receipt since.
 *
 * `keepsPlace`: the slot holds its room whatever it shows (the full page). In
 * the drawer a read that may well find nothing, any row but a
 * categorisation's, shows no skeleton: it would open a gap that closes again
 * on most proposals.
 */
export function underlagState(underlag: ReviewUnderlag, row: RowUnderlagRead, keepsPlace: boolean): UnderlagState {
  const document = underlag.document ?? row.document
  if (document) return { kind: 'document', document }
  if (underlag.transactionId != null) {
    if (row.loading) return { kind: underlag.rowUnderlagExpected || keepsPlace ? 'loading' : 'none' }
    if (row.failed) return { kind: 'failed' }
  }
  return { kind: underlag.missing || underlag.rowUnderlagExpected ? 'missing' : 'none' }
}

/* ------------------------------------------ the rows of a samlingsverifikat */

/**
 * The most bank rows of a batch whose underlag the review reads unasked. A
 * row is one request (GET /api/transactions/[id]/underlag, the read the
 * single row uses) and a batch holds up to 200 (BulkBookSchema): the first
 * 25 cover the same-day batches the type is for, and the rest are read when
 * the reviewer asks for them.
 */
export const ROWS_UNDERLAG_UNASKED = 25

/** The rows whose underlag is read: the first ones, or all of them once the reviewer asked for the rest. */
export function rowsToRead(rowIds: readonly string[], all: boolean): string[] {
  return all ? [...rowIds] : rowIds.slice(0, ROWS_UNDERLAG_UNASKED)
}

/** What was read for one bank row of a batch: the row and the file on it, or that it could not be read. */
export type RowUnderlagResult =
  | { failed: false; bankRow: ReviewBankRow | null; document: DocumentFileRef | null }
  | { failed: true }

/**
 * One row's answer from GET /api/transactions/[id]/underlag as the review
 * reads it. An answer that is no answer (an error body, an older shape) is a
 * row that could not be read, never a row without underlag.
 */
export function rowUnderlagResult(answer: unknown): RowUnderlagResult {
  if (answer == null || typeof answer !== 'object' || !('document' in answer)) return { failed: true }
  const stated = record((answer as Data).row)
  const bankRow: ReviewBankRow | null =
    text(stated.date) || text(stated.text) || finite(stated.amount) !== null
      ? { date: text(stated.date), text: text(stated.text), amount: finite(stated.amount), currency: text(stated.currency) ?? 'SEK' }
      : null
  return { failed: false, bankRow, document: bankRowDocumentRef(answer) }
}

/** What the review has read for the rows of a batch so far. */
export interface RowsUnderlagRead {
  /**
   * By bank row. A read lands whole (every row it asked about at once), so
   * the list never grows row by row under the reviewer.
   */
  results: ReadonlyMap<string, RowUnderlagResult>
  /** A read is out. */
  reading: boolean
  /** The reviewer asked for the rows past the first read. */
  askedForRest: boolean
}

export interface RowUnderlagFile {
  transactionId: string
  document: DocumentFileRef
  bankRow: ReviewBankRow | null
}

export type RowsUnderlagState =
  | { kind: 'none' | 'loading' }
  | {
      kind: 'list'
      /** The rows that have a file, in the proposal's order. A row without one is not listed: nothing is missing from it here. */
      files: RowUnderlagFile[]
      /** Rows whose underlag could not be read. */
      failed: number
      /** Rows read, of the rows the proposal names. Fewer while the rows past the first read wait to be asked for. */
      read: number
      total: number
      /** The read the reviewer asked for is out. */
      reading: boolean
    }

/**
 * What the underlag slot shows for a proposal that names several bank rows:
 * the rows that have a file, how many could not be read, and how many are
 * not read yet. Nothing when every row is read and none has a file: a batch
 * is booked from its rows, and a row without underlag is no gap the review
 * states (the same call underlagState makes for a matched payment). Once the
 * reviewer has asked for the rest the list stays, also empty: the section
 * they pressed the button in says that there is none, it does not just go.
 *
 * `keepsPlace` as in underlagState: on the full page the first read shows a
 * skeleton; in the drawer it holds no room, since most batches have no file.
 */
export function rowsUnderlagState(rowIds: readonly string[], read: RowsUnderlagRead, keepsPlace: boolean): RowsUnderlagState {
  const landed = rowIds.filter((id) => read.results.has(id))
  if (landed.length === 0) return { kind: read.reading && keepsPlace ? 'loading' : 'none' }
  const files: RowUnderlagFile[] = []
  let failed = 0
  for (const id of landed) {
    const result = read.results.get(id)
    if (!result) continue
    if (result.failed) failed += 1
    else if (result.document) files.push({ transactionId: id, document: result.document, bankRow: result.bankRow })
  }
  if (files.length === 0 && failed === 0 && landed.length === rowIds.length && !read.askedForRest) return { kind: 'none' }
  return { kind: 'list', files, failed, read: landed.length, total: rowIds.length, reading: read.reading }
}

/* ------------------------------------------------------------------ reason */

export interface ReviewReason {
  /** The staged warning, as the page's one attention line. The VAT explanation stays beside the invoice lines it is about. */
  attention: Exclude<ComplianceWarning, { kind: 'vat' }> | null
  /** Why the stager proposes it, in its own words: the reason it staged with, else its audit note. */
  reason: string | null
  /** The audit note, when the proposal carries both and they differ. */
  note: string | null
}

export function reviewReason(
  op: Pick<PendingOperation, 'operation_type' | 'preview_data' | 'params' | 'agent_reason'>,
): ReviewReason {
  const warning = complianceWarningOf(op)
  const stated = text(op.agent_reason)
  const note = text(record(op.params).notes)
  return {
    attention: warning && warning.kind !== 'vat' ? warning : null,
    reason: stated ?? note,
    note: stated && note && note !== stated ? note : null,
  }
}

/* ----------------------------------------------------------------- missing */

interface Requirement {
  label: FactLabel
  present: (data: Data) => boolean
}

const hasText = (key: string) => (data: Data) => text(data[key]) !== null
const hasNumber = (key: string) => (data: Data) => finite(data[key]) !== null
const hasKontering = (data: Data) =>
  stagedPostingLines(data).length > 0 || (text(data.debit_account) !== null && text(data.credit_account) !== null)

// What a proposal cannot be read, or approved, without: the fields whose
// absence the previews have always shown as a blank or a '-'. Staging tools
// validate these, so a gap means a proposal staged before a field existed or
// by a tool that skipped it. Types not listed are never held back.
const REQUIRED: Record<string, Requirement[]> = {
  create_customer: [{ label: 'Namn', present: hasText('name') }],
  create_supplier: [{ label: { key: 'preview_field.name' }, present: hasText('name') }],
  create_transaction: [
    { label: 'Datum', present: hasText('date') },
    { label: 'Belopp', present: hasNumber('amount') },
  ],
  create_invoice: [
    { label: 'Kund', present: hasText('customer_name') },
    { label: 'Totalt', present: hasNumber('total') },
  ],
  create_voucher: [{ label: { key: 'preview_account' }, present: hasKontering }],
  categorize_transaction: [{ label: { key: 'preview_account' }, present: hasKontering }],
}

/** The required fields a pending proposal lacks, by label. Empty when nothing is missing or the type has no list. */
export function missingFields(op: Pick<PendingOperation, 'operation_type' | 'preview_data' | 'status'>): FactLabel[] {
  if (op.status !== 'pending') return []
  const data = record(op.preview_data)
  // A registration of an already-booked invoice shares create_invoice's type
  // but states other fields (crm#1094).
  if (isRegisterBookedInvoiceParams(data)) return []
  return (REQUIRED[op.operation_type] ?? []).filter((field) => !field.present(data)).map((field) => field.label)
}

/* ----------------------------------------------------------------- history */

/** Rows the expiry cron auto-rejected: strict on reason === 'expired', so a commit-time auto-reject never reads as expired. */
export function isAutoExpired(op: Pick<PendingOperation, 'status' | 'result_data'>): boolean {
  const rd = op.result_data as { auto_rejected?: boolean; reason?: string } | null
  return op.status === 'rejected' && rd?.auto_rejected === true && rd?.reason === 'expired'
}

export type HistoryEvent =
  | { kind: 'staged'; at: string }
  | { kind: 'instructions'; slugs: string[] }
  | { kind: 'approved'; at: string | null }
  | { kind: 'rejected'; at: string | null; category: PendingOperation['rejection_category']; reason: string | null }
  | { kind: 'expired'; at: string | null }
  | { kind: 'handled_elsewhere'; at: string | null }
  | { kind: 'closed_by_refusal'; at: string | null; reason: string }
  | { kind: 'failed_partial'; at: string | null }
  | { kind: 'unknown'; at: string | null }

/**
 * Who did what to a proposal, oldest first, from what the row stores: when it
 * was staged, the instructions the agent retrieved, and how it was resolved.
 * A pending operation cannot be edited, so there are no edits to list.
 */
export function reviewHistory(
  op: Pick<
    PendingOperation,
    'status' | 'created_at' | 'resolved_at' | 'agent_metadata' | 'rejection_category' | 'rejection_reason' | 'result_data'
  >,
): HistoryEvent[] {
  const events: HistoryEvent[] = [{ kind: 'staged', at: op.created_at }]
  const slugs = op.agent_metadata?.skills_loaded ?? []
  if (slugs.length > 0) events.push({ kind: 'instructions', slugs })
  const at = op.resolved_at
  const refusal = closedByRefusalReason(op)
  if (op.status === 'committed') events.push({ kind: 'approved', at })
  else if (op.status === 'failed_partial') events.push({ kind: 'failed_partial', at })
  else if (op.status === 'unknown') events.push({ kind: 'unknown', at })
  else if (op.status === 'rejected') {
    if (isAutoExpired(op)) events.push({ kind: 'expired', at })
    else if (isHandledElsewhere(op)) events.push({ kind: 'handled_elsewhere', at })
    else if (refusal) events.push({ kind: 'closed_by_refusal', at, reason: refusal })
    else events.push({ kind: 'rejected', at, category: op.rejection_category, reason: text(op.rejection_reason) })
  }
  return events
}

/* ------------------------------------------------------------------- queue */

export interface StepPosition {
  /** Zero-based; -1 when the id is not in the queue. */
  index: number
  count: number
  previous: string | null
  next: string | null
}

/** Where a proposal stands in the walk: its place, and its neighbours in the list's own order. */
export function stepPosition(ids: readonly string[], id: string | null): StepPosition {
  const index = id == null ? -1 : ids.indexOf(id)
  return {
    index,
    count: ids.length,
    previous: index > 0 ? ids[index - 1] : null,
    next: index === -1 ? null : (ids[index + 1] ?? null),
  }
}

/**
 * Where the walk goes when the proposal on screen has left the queue
 * (approved, rejected, handled elsewhere): the first proposal that came after
 * it and is still waiting. Null when none did: the walk is through, whatever
 * was skipped on the way stays in Rutin.
 */
export function stepAfterLeaving(previousOrder: readonly string[], leftId: string, waiting: ReadonlySet<string>): string | null {
  const at = previousOrder.indexOf(leftId)
  if (at === -1) return null
  for (let i = at + 1; i < previousOrder.length; i++) {
    if (waiting.has(previousOrder[i])) return previousOrder[i]
  }
  return null
}
