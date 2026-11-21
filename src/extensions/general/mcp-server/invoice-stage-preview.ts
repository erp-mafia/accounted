/**
 * What the customer-invoice staging tools show before approval.
 *
 * The approval card and the agent read only the staged title and preview, so
 * both must describe what the commit executor will actually do, worked out
 * from the same inputs it uses (lib/pending-operations/commit.ts):
 *
 *   - mark paid: kontantmetoden books an invoice that has no verifikat yet as
 *     one cash entry; every other case clears the receivable, after the sale
 *     of a deferring company's unbooked invoice is booked first by the Bokför
 *     step (lib/invoices/sale-first.ts, planned by the tool). The lines come
 *     from the builders the executor books with (buildInvoiceCashLines,
 *     buildInvoicePaymentLines), and the description is read off those lines,
 *     so it cannot claim an account the entry does not touch.
 *   - mark sent / send: a draft has no number until approval
 *     (ensureInvoiceNumber), and it is booked at issue only under
 *     faktureringsmetoden without deferred booking (booksInvoicesOnIssue).
 *     The number it will most likely get is peeked, never reserved.
 *   - mark sent, paid at issue (crm#1281, the kontantfaktura): refused by the
 *     rule issueAndBookInvoice applies (paidAtIssueBlockReason), else one cash
 *     verifikat on the invoice date, the buildInvoiceCashLines lines the
 *     payment at issue books, in either accounting method.
 *   - mark sent / send, the parties (crm#2080): a missing seller or buyer
 *     name or address is refused by the verdict issuable gives the approval
 *     (invoicePartiesVerdict); a förenklad faktura without the buyer's
 *     address is staged with a note.
 */
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import type { SupabaseClient } from '@supabase/supabase-js'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { buildInvoiceCashLines, buildInvoicePaymentLines } from '@/lib/bookkeeping/invoice-entries'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { dbError } from '@/lib/errors/db-error'
import { resolveInvoiceSettlementAccount } from '@/lib/invoices/invoice-payee'
import {
  BUYER_ADDRESS_MISSING_WARNING,
  invoicePartiesVerdict,
  type InvoicePartiesCustomer,
  type InvoicePartiesSeller,
  type InvoicePartiesVerdict,
} from '@/lib/invoices/invoice-parties'
import { paidAtIssueBlockReason, type PaidAtIssueBlockReason } from '@/lib/invoices/paid-at-issue'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { formatAmount } from '@/lib/utils'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem, VatTreatment } from '@/types'

const log = createLogger('mcp-invoice-stage-preview')

/** The invoice row as fetchInvoiceWithCustomer returns it (`*, customer`). */
export interface StagedInvoiceRow {
  id: string
  invoice_number: string | null
  invoice_date?: string | null
  status?: string | null
  document_type?: string | null
  credited_invoice_id?: string | null
  is_self_billed?: boolean | null
  external_invoice_number?: string | null
  journal_entry_id?: string | null
  payment_cash_account_id?: string | null
  total: number
  total_sek?: number | null
  subtotal: number
  subtotal_sek?: number | null
  vat_amount: number
  vat_amount_sek?: number | null
  currency: string | null
  exchange_rate?: number | null
  vat_treatment: VatTreatment
  delivery_country?: string | null
  default_dimensions?: Record<string, string> | null
  deduction_total?: number | null
  deduction_reclaimed_total?: number | null
  paid_amount?: number | null
  remaining_amount?: number | null
  customer?: { name?: string | null } | null
}

export interface PaymentPreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string
}

export interface MarkPaidPreview {
  /** The method this payment books under: 'cash' only for a never-booked invoice. */
  accounting_method: 'cash' | 'accrual'
  source_type: 'invoice_cash_payment' | 'invoice_paid'
  /** null when the lines could not be built (the commit then refuses on its own terms). */
  journal_entry_preview: {
    lines: PaymentPreviewLine[]
    total_debit: number
    total_credit: number
  } | null
  /** The 19xx account the payment books on; null when it could not be resolved for the preview. */
  payment_account: string | null
  /** The next.description for the staged operation. */
  next_description: string
}

/** The lines a staged payment shows, rounded to öre, with their sums. */
function entryPreviewOf(lines: CreateJournalEntryLineInput[]): NonNullable<MarkPaidPreview['journal_entry_preview']> {
  const previewLines = lines.map((line) => ({
    account_number: line.account_number,
    debit_amount: roundOre(Number(line.debit_amount) || 0),
    credit_amount: roundOre(Number(line.credit_amount) || 0),
    line_description: line.line_description ?? '',
  }))
  return {
    lines: previewLines,
    total_debit: roundOre(previewLines.reduce((sum, l) => sum + l.debit_amount, 0)),
    total_credit: roundOre(previewLines.reduce((sum, l) => sum + l.credit_amount, 0)),
  }
}

/** "debit 1930 / credit 3001, 2611": the accounts an entry touches, read off its lines. */
function describeAccounts(lines: PaymentPreviewLine[]): string {
  const side = (pick: (l: PaymentPreviewLine) => number) =>
    [...new Set(lines.filter((l) => pick(l) > 0).map((l) => l.account_number))].join(', ')
  return `debit ${side((l) => l.debit_amount)} / credit ${side((l) => l.credit_amount)}`
}

/**
 * The journal entry gnubok_mark_invoice_as_paid will post, and the sentence
 * that describes it. Route rule identical to commitMarkInvoicePaid: a
 * kontantmetod company books the cash entry only for an invoice with no
 * verifikat of its own; one booked at issue (also under a since-changed
 * method) clears 1510. The lines come from the executor's own builders,
 * called as it calls them (no bank row, the invoice's settlement account).
 */
export async function buildMarkPaidPreview(
  supabase: SupabaseClient,
  companyId: string,
  invoice: StagedInvoiceRow,
  /**
   * Set when the approval books the invoice's sale first (defer_invoice_booking):
   * the 1510 that sale leaves, off its dry run. No voucher holds it yet.
   */
  options: {
    saleFirstReceivableSek?: number
    /** The account the caller named and the tool validated (payment_account); else resolved here. */
    settlementAccount?: string
  } = {},
): Promise<MarkPaidPreview> {
  // Same read and defaults as loadBookingContext in the commit executor.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const companyMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method
  const sourceType = resolveInvoicePaymentSourceType({
    invoiceAlreadyBooked: !!invoice.journal_entry_id,
    accountingMethod: companyMethod === 'cash' ? 'cash' : 'accrual',
  })
  const useCash = sourceType === 'invoice_cash_payment'
  const accountingMethod: 'cash' | 'accrual' = useCash ? 'cash' : 'accrual'

  let journalEntryPreview: MarkPaidPreview['journal_entry_preview'] = null
  let paymentAccount: string | null = options.settlementAccount ?? null
  try {
    const settlementAccount = options.settlementAccount ?? (await resolveInvoiceSettlementAccount(supabase, companyId, invoice))
    paymentAccount = settlementAccount
    const customerName = invoice.customer?.name ?? undefined
    let lines: CreateJournalEntryLineInput[]
    if (useCash) {
      const entityType = await resolveCompanyEntityType(
        supabase,
        companyId,
        (settings as { entity_type?: unknown } | null)?.entity_type,
      )
      // The cash entry books revenue per item (rate, account override, tag),
      // so it needs the rows the executor reads.
      const { data: rows, error } = await supabase
        .from('invoice_items')
        .select('*')
        .eq('invoice_id', invoice.id)
        .order('sort_order', { ascending: true })
      if (error) throw new Error(error.message)
      const withItems = { ...invoice, items: (rows ?? []) as InvoiceItem[] } as unknown as Invoice
      lines = buildInvoiceCashLines(
        withItems, entityType, customerName, settlementAccount, undefined, undefined,
        { deferDeductionShare: companyMethod === 'cash' },
      ).lines
    } else {
      const carried_sek = options.saleFirstReceivableSek ?? (await carriedSekOf(supabase, companyId, 'customer', invoice))
      lines = buildInvoicePaymentLines({ ...(invoice as unknown as Invoice), carried_sek }, customerName, settlementAccount).lines
    }
    journalEntryPreview = entryPreviewOf(lines)
  } catch (err) {
    // A preview is advisory: the executor builds the same entry and refuses
    // with its own error (a foreign invoice without a rate, say).
    log.warn('mark-paid journal entry preview unavailable', {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const how = useCash
    ? 'under kontantmetoden: the invoice has no verifikat of its own, so revenue is recognised at payment'
    : options.saleFirstReceivableSek !== undefined
      ? 'against the receivable its sale verifikat books first (preview.sale_entry: the Bokför step, dated on the invoice date)'
      : 'against the receivable booked when the invoice was issued'
  const next_description = journalEntryPreview
    ? `Once approved, the payment is booked ${how}: ${describeAccounts(journalEntryPreview.lines)}. ` +
      'preview.journal_entry_preview lists the amounts. Use gnubok_get_ar_ledger to confirm the invoice is settled.'
    : `Once approved, the payment is booked ${how}. The lines could not be previewed; the approval builds and ` +
      'checks them. Use gnubok_get_ar_ledger to confirm the invoice is settled.'

  return {
    accounting_method: accountingMethod,
    source_type: sourceType,
    journal_entry_preview: journalEntryPreview,
    payment_account: paymentAccount,
    next_description,
  }
}

export interface PaidAtIssuePreview {
  /** Why the draft cannot be issued paid (paidAtIssueBlockReason), null when it can. */
  block_reason: PaidAtIssueBlockReason | null
  /** null when refused, or when the lines could not be built (the approval then refuses on its own terms). */
  journal_entry_preview: MarkPaidPreview['journal_entry_preview']
  /** The next.description for the staged operation. */
  next_description: string
}

/**
 * What gnubok_mark_invoice_as_sent with paid_at_issue_account (crm#1281, the
 * kontantfaktura) will do on approval. The refusal is paidAtIssueBlockReason
 * over the draft's items, the rule issueAndBookInvoice applies at commit; the
 * lines are buildInvoiceCashLines to the chosen account, what the payment at
 * issue books (settleInvoicePayment with recognizeSaleAtPayment), whatever
 * the company's accounting method.
 */
export async function buildPaidAtIssuePreview(
  supabase: SupabaseClient,
  companyId: string,
  invoice: StagedInvoiceRow,
  accountNumber: string,
): Promise<PaidAtIssuePreview> {
  const { data: rows, error } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', invoice.id)
    .order('sort_order', { ascending: true })
  if (error) throw dbError(error)
  const items = (rows ?? []) as InvoiceItem[]

  const blockReason = paidAtIssueBlockReason({ ...invoice, items })
  if (blockReason) return { block_reason: blockReason, journal_entry_preview: null, next_description: '' }

  let journalEntryPreview: PaidAtIssuePreview['journal_entry_preview'] = null
  try {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('entity_type, accounting_method')
      .eq('company_id', companyId)
      .maybeSingle()
    const entityType = await resolveCompanyEntityType(
      supabase,
      companyId,
      (settings as { entity_type?: unknown } | null)?.entity_type,
    )
    const withItems = { ...invoice, items } as unknown as Invoice
    // Kontantmetoden books a ROT/RUT invoice in two steps (settleInvoicePayment
    // passes the same flag); faktureringsmetoden reports the whole moms now.
    const cashMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method === 'cash'
    journalEntryPreview = entryPreviewOf(
      buildInvoiceCashLines(
        withItems, entityType, invoice.customer?.name ?? undefined, accountNumber, undefined, undefined,
        { deferDeductionShare: cashMethod },
      ).lines,
    )
  } catch (err) {
    // Advisory, as for mark paid: the approval builds the same entry and
    // refuses with its own error (a foreign invoice without a rate, say).
    log.warn('paid-at-issue journal entry preview unavailable', {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const accounts = journalEntryPreview ? `: ${describeAccounts(journalEntryPreview.lines)}` : ''
  return {
    block_reason: null,
    journal_entry_preview: journalEntryPreview,
    next_description:
      `Once approved, the invoice is numbered and issued already paid: one verifikat on the invoice date${accounts}, ` +
      'no receivable on 1510, and its status is paid. Use gnubok_get_ar_ledger to confirm nothing is left open.',
  }
}

/** "Kund AB, 4 321,50 SEK": the draft as the user recognises it before it has a number. */
export function describeUnnumberedInvoice(invoice: StagedInvoiceRow, customerName: string): string {
  const amount = `${formatAmount(Number(invoice.total) || 0)} ${invoice.currency ?? 'SEK'}`
  return customerName ? `${customerName}, ${amount}` : amount
}

export interface IssuePreview {
  /** Whether approving posts the invoice's own verifikat now (faktureringsmetoden, not deferred). */
  will_post_journal_entry: boolean
  /** The number the draft will most likely get. Peeked, not reserved; null when unknown. */
  expected_invoice_number: string | null
  expected_invoice_number_note?: string
}

/**
 * What issuing a draft will do: post a verifikat or not (the same predicate
 * markInvoiceSentAndBook applies), and the number ensureInvoiceNumber will
 * most likely assign. Never throws: a failed read leaves the field unknown.
 */
export async function buildIssuePreview(
  supabase: SupabaseClient,
  companyId: string,
  invoice: StagedInvoiceRow,
): Promise<IssuePreview> {
  const isDraft = (invoice.status ?? 'draft') === 'draft'
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'

  let willPost = false
  if (isDraft && isRealInvoice && !isCreditNoteDocument(invoice) && !invoice.journal_entry_id) {
    const { data: settings, error } = await supabase
      .from('company_settings')
      .select('accounting_method, defer_invoice_booking')
      .eq('company_id', companyId)
      .maybeSingle()
    // No settings row books at issue (the historical default); a failed read
    // claims nothing it cannot back.
    willPost = error ? false : booksInvoicesOnIssue(settings as Parameters<typeof booksInvoicesOnIssue>[0])
  }

  if (invoice.invoice_number) {
    return { will_post_journal_entry: willPost, expected_invoice_number: invoice.invoice_number }
  }
  // Self-billing invoices keep the counterparty's number and never take one
  // from our series (ensureInvoiceNumber).
  if (invoice.is_self_billed) {
    return { will_post_journal_entry: willPost, expected_invoice_number: invoice.external_invoice_number ?? null }
  }
  // Delivery notes have their own sequence, which the peek does not cover.
  if (invoice.document_type === 'delivery_note' || !isDraft) {
    return { will_post_journal_entry: willPost, expected_invoice_number: null }
  }

  const { data: peeked, error: peekError } = await supabase.rpc('peek_next_invoice_number', {
    p_company_id: companyId,
    p_document_type: invoice.document_type ?? 'invoice',
  })
  if (peekError || typeof peeked !== 'string' || !peeked) {
    if (peekError) log.warn('peek_next_invoice_number failed', { error: peekError.message })
    return { will_post_journal_entry: willPost, expected_invoice_number: null }
  }
  return {
    will_post_journal_entry: willPost,
    expected_invoice_number: peeked,
    expected_invoice_number_note:
      'Expected, not reserved: the number is assigned at approval and moves on if another invoice is issued first.',
  }
}

/**
 * The seller's and the buyer's name and address as the approval's issuable
 * will read them (crm#2080). A failed read of the settings claims nothing:
 * the approval decides.
 */
export async function stagedInvoiceParties(
  supabase: SupabaseClient,
  companyId: string,
  invoice: StagedInvoiceRow,
): Promise<InvoicePartiesVerdict> {
  if ((invoice.status ?? 'draft') !== 'draft') return 'ok'
  const { data: seller, error } = await supabase
    .from('company_settings')
    .select('company_name, address_line1, address_line2, postal_code, city, country, vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !seller) return 'ok'
  return invoicePartiesVerdict(
    {
      credited_invoice_id: invoice.credited_invoice_id ?? null,
      document_type: (invoice.document_type ?? 'invoice') as Invoice['document_type'],
      total: invoice.total,
      total_sek: invoice.total_sek ?? null,
      currency: (invoice.currency ?? 'SEK') as Invoice['currency'],
      exchange_rate: invoice.exchange_rate ?? null,
      vat_treatment: invoice.vat_treatment,
    },
    invoice.customer as InvoicePartiesCustomer | null | undefined,
    seller as InvoicePartiesSeller,
  )
}

/** The staged note for a förenklad faktura without the buyer's address, in the agent's language. */
export const BUYER_ADDRESS_SIMPLIFIED_NOTE =
  `${BUYER_ADDRESS_MISSING_WARNING.code}: ${BUYER_ADDRESS_MISSING_WARNING.message_en} Before approval, gnubok_update_customer adds it.`

/** " (förväntat nr F-103)" for a title, or "" when the number is unknown or already set. */
export function expectedNumberSuffix(invoice: StagedInvoiceRow, issue: IssuePreview): string {
  if (invoice.invoice_number || !issue.expected_invoice_number) return ''
  return ` (förväntat nr ${issue.expected_invoice_number})`
}

/** The lines a staged kreditfaktura refund shows (lib/invoices/refund-credit-note.ts), with their sums. */
export function refundEntryPreview(lines: CreateJournalEntryLineInput[]): NonNullable<MarkPaidPreview['journal_entry_preview']> {
  return entryPreviewOf(lines)
}
