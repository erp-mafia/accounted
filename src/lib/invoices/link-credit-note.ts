/**
 * Link an EXISTING credit note to the EXISTING invoice it credits (crm#1852).
 *
 * A kreditfaktura names the invoice it changes (ML 2023:200 17 kap 22-23 §§).
 * One issued here carries that as credited_invoice_id from the start. One
 * that arrived another way (imported at a system change with the reference
 * only in free text) has no link, so the original stays an open, overdue
 * claim in the kundreskontra although the customer owes nothing on it, and
 * no door could say afterwards which invoice it credits: Kreditera creates a
 * second credit note, and a payment would book money that never came.
 *
 * This writes exactly the kundreskontra side of an ordinary credit and
 * nothing else: the credit note points at its original and rests at 'sent'
 * (where a credit note issued here rests), and the original moves to
 * 'credited' through the same write the issue step uses
 * (markOriginalInvoiceCredited). The two then net in the kundreskontra as any
 * credited pair does (reports/credited-pairs.ts).
 *
 * It never books. So it refuses every pair an ordinary credit would have
 * booked a verifikat for (creditNoteNeedsJournalEntry: faktureringsmetoden
 * always, kontantmetoden once the original was paid or booked), a credit
 * note that carries a verifikat of its own, ROT/RUT documents (part of the
 * claim is Skatteverket's) and an original with a kundförlust decision (its
 * reserve is released by a verifikat). Those need the entries first; they
 * are not invented here.
 *
 * It is the user's statement about two documents, so it also refuses what
 * cannot be one credit of one invoice: another customer, another currency or
 * rate, a credit above the invoice's open amount, a credit note already
 * linked, an original already credited. A credit below the open amount (a
 * partial credit) is refused too: the ordinary credit is always a full one,
 * and 'credited' on an invoice the customer still owes part of would take it
 * out of every payment door.
 *
 * One rule for every door (v1 and the staged MCP tool,
 * lib/operations/invoice-credit-link.ts). A dry run runs every check and
 * stops before the first write.
 */
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { documentCurrency } from '@/lib/bookkeeping/ledger-line-amount'
import { eventBus } from '@/lib/events'
import { markOriginalInvoiceCredited } from '@/lib/invoices/issue-credit-note'
import type { Logger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { CreditNote } from '@/types'

/** Where an unlinked credit note may rest: imported as settled, or issued. */
const LINKABLE_CREDIT_NOTE_STATUSES = new Set(['credited', 'sent'])
/** Statuses that say a payment exists: the booking check names those. */
const PAID_ORIGINAL_STATUSES = new Set(['paid', 'partially_paid'])

type Row = Record<string, unknown>

export type CreditNoteNotLinkableReason = 'not_an_invoice' | 'not_negative' | 'status' | 'refunded'
export type OriginalNotOpenReason = 'same_document' | 'not_an_invoice' | 'is_credit_note' | 'status' | 'has_credit_note'
export type CreditLinkBookingReason =
  | 'accrual_method'
  | 'original_paid_or_booked'
  | 'credit_note_booked'
  | 'rot_rut'
  | 'customer_loss_decision'
export type CreditLinkAmountReason = 'exceeds_open_amount' | 'partial_credit' | 'credit_cap'
export type CreditLinkCurrencyReason = 'currency' | 'exchange_rate'

export interface CreditLinkPair {
  creditNote: Row
  original: Row
  /** The credit note's amount, positive. */
  creditAmount: number
  /** What the original still asked for before the link. */
  openAmount: number
  currency: string
}

export type LinkCreditNoteResult =
  | ({ ok: true; dryRun: boolean } & CreditLinkPair)
  | { ok: false; code: 'INVOICE_NOT_FOUND'; details: { missing: 'credit_note' | 'invoice' } }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE'; details: { reason: CreditNoteNotLinkableReason; status?: string } }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_ALREADY_LINKED'; details: { credited_invoice_id: string; same_invoice: boolean } }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN'; details: { reason: OriginalNotOpenReason; status?: string } }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH' }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH'; details: { reason: CreditLinkCurrencyReason } }
  | { ok: false; code: 'INVOICE_CREDIT_LINK_BOOKING_REQUIRED'; details: { reason: CreditLinkBookingReason } }
  | {
      ok: false
      code: 'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH'
      details: { reason: CreditLinkAmountReason; credit_amount: number; open_amount: number }
    }
  /** One of the two documents changed between the read and the write. */
  | { ok: false; code: 'INVOICE_CREDIT_LINK_RACE' }
  | { ok: false; code: 'DB_ERROR'; cause: { message: string; code?: string } }

const amount = (value: unknown): number => roundOre(Number(value) || 0)
const dbFailure = (error: { message: string; code?: string }): LinkCreditNoteResult => ({
  ok: false,
  code: 'DB_ERROR',
  cause: { message: error.message, code: error.code },
})

export async function linkCreditNoteToInvoice(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  creditNoteId: string
  invoiceId: string
  log: Logger
  /** Run every check and stop before the first write. */
  dryRun?: boolean
}): Promise<LinkCreditNoteResult> {
  const { supabase, companyId, userId, creditNoteId, invoiceId, log, dryRun = false } = params

  const readInvoice = (id: string) =>
    supabase.from('invoices').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const [creditRead, originalRead] = await Promise.all([readInvoice(creditNoteId), readInvoice(invoiceId)])
  if (creditRead.error) return dbFailure(creditRead.error)
  if (originalRead.error) return dbFailure(originalRead.error)
  const creditNote = creditRead.data as Row | null
  const original = originalRead.data as Row | null
  if (!creditNote) return { ok: false, code: 'INVOICE_NOT_FOUND', details: { missing: 'credit_note' } }
  if (!original) return { ok: false, code: 'INVOICE_NOT_FOUND', details: { missing: 'invoice' } }
  if (creditNoteId === invoiceId) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'same_document' } }
  }

  // The credit note: an issued kreditfaktura that credits nothing yet.
  const creditStatus = String(creditNote.status ?? '')
  if ((creditNote.document_type || 'invoice') !== 'invoice') {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE', details: { reason: 'not_an_invoice' } }
  }
  if (creditNote.credited_invoice_id) {
    const linkedTo = String(creditNote.credited_invoice_id)
    return {
      ok: false,
      code: 'INVOICE_CREDIT_LINK_ALREADY_LINKED',
      details: { credited_invoice_id: linkedTo, same_invoice: linkedTo === invoiceId },
    }
  }
  const creditTotal = amount(creditNote.total)
  if (!(creditTotal < 0)) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE', details: { reason: 'not_negative' } }
  }
  if (!LINKABLE_CREDIT_NOTE_STATUSES.has(creditStatus)) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE', details: { reason: 'status', status: creditStatus } }
  }
  if (amount(creditNote.paid_amount) !== 0) {
    // Money already went back to the customer on it: it is not open credit.
    return { ok: false, code: 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE', details: { reason: 'refunded' } }
  }

  // The original: an issued sales invoice, not credited before.
  const originalStatus = String(original.status ?? '')
  if ((original.document_type || 'invoice') !== 'invoice') {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'not_an_invoice' } }
  }
  if (isCreditNoteDocument(original)) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'is_credit_note' } }
  }
  // An issued invoice: still owed (lib/bookkeeping/matchable-statuses.ts) or paid in full.
  if (!isOwedInvoiceStatus(originalStatus) && originalStatus !== 'paid') {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'status', status: originalStatus } }
  }

  if (!creditNote.customer_id || creditNote.customer_id !== original.customer_id) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH' }
  }

  // The same currency, and for a foreign one the same rate: only then do the
  // two net in kronor (credited-pairs.ts sameConversion).
  const currency = documentCurrency(creditNote.currency as string | null)
  if (currency !== documentCurrency(original.currency as string | null)) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH', details: { reason: 'currency' } }
  }
  if (!isKronorCurrency(currency) && (Number(creditNote.exchange_rate) || 0) !== (Number(original.exchange_rate) || 0)) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH', details: { reason: 'exchange_rate' } }
  }

  // Nothing is booked here, so nothing an ordinary credit would have booked.
  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsRead.error) return dbFailure(settingsRead.error)
  const method = checkAccountingMethod(settingsRead)
  const bookingRequired = (reason: CreditLinkBookingReason): LinkCreditNoteResult => ({
    ok: false,
    code: 'INVOICE_CREDIT_LINK_BOOKING_REQUIRED',
    details: { reason },
  })
  // Only kontantmetoden links without a booking. A method that cannot be
  // read is not taken for it: the link is refused as it is under
  // faktureringsmetoden.
  if (!method.ok || method.accountingMethod === 'accrual') return bookingRequired('accrual_method')
  const accountingMethod = method.accountingMethod
  if (
    PAID_ORIGINAL_STATUSES.has(originalStatus) ||
    creditNoteNeedsJournalEntry(accountingMethod, {
      journal_entry_id: (original.journal_entry_id as string | null) ?? null,
      status: originalStatus,
      paid_at: (original.paid_at as string | null) ?? null,
      paid_amount: Number(original.paid_amount) || 0,
    })
  ) {
    return bookingRequired('original_paid_or_booked')
  }
  if (creditNote.journal_entry_id) return bookingRequired('credit_note_booked')
  if (amount(creditNote.deduction_total) !== 0 || amount(original.deduction_total) !== 0) {
    return bookingRequired('rot_rut')
  }
  const { data: decisions, error: decisionsError } = await supabase
    .from('invoice_write_offs')
    .select('id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .limit(1)
  if (decisionsError) return dbFailure(decisionsError)
  if (decisions && decisions.length > 0) return bookingRequired('customer_loss_decision')

  // An original that carries a credit note already has had its balance
  // decided by that one (by the source system for an imported pair): a second
  // link cannot tell what is still open on it.
  const { count: siblingCount, error: siblingsError } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('credited_invoice_id', invoiceId)
    .neq('status', 'cancelled')
  if (siblingsError) return dbFailure(siblingsError)
  // An unknown count is not "none".
  if (siblingCount !== 0) {
    return { ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'has_credit_note' } }
  }

  // Nothing is paid on the original (checked above), so what it asks for is
  // its total: the kundreskontra's own reading (total - paid_amount).
  const creditAmount = roundOre(-creditTotal)
  const openAmount = roundOre(amount(original.total) - amount(original.paid_amount))
  const amountMismatch = (reason: CreditLinkAmountReason): LinkCreditNoteResult => ({
    ok: false,
    code: 'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH',
    details: { reason, credit_amount: creditAmount, open_amount: openAmount },
  })
  if (creditAmount > openAmount + ORE_TOLERANCE) return amountMismatch('exceeds_open_amount')
  if (creditAmount < openAmount - ORE_TOLERANCE) return amountMismatch('partial_credit')

  const pair: CreditLinkPair = { creditNote, original, creditAmount, openAmount, currency }
  if (dryRun) return { ok: true, dryRun: true, ...pair }

  // 1. The credit note points at its original and rests where an issued
  // credit note rests. Compare-and-set on what was read: a second link or a
  // status change in between makes this a 0-row update.
  const { data: linked, error: linkError } = await supabase
    .from('invoices')
    .update({ credited_invoice_id: invoiceId, status: 'sent', updated_at: new Date().toISOString() })
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
    .is('credited_invoice_id', null)
    .eq('status', creditStatus)
    .select('*')
    .maybeSingle()
  if (linkError) {
    // The schema's own verdict on the pair (enforce_credit_note_total_within_original).
    if (linkError.code === '23514') return amountMismatch('credit_cap')
    return dbFailure(linkError)
  }
  if (!linked) return { ok: false, code: 'INVOICE_CREDIT_LINK_RACE' }

  // 2. The original moves to 'credited', by the write the issue step uses.
  const flipped = await markOriginalInvoiceCredited(supabase, companyId, invoiceId)
  if (!flipped.moved) {
    // The original changed since it was read (paid, credited, cancelled).
    // Put the credit note back as it was, so nothing half-linked remains.
    const { data: undone, error: undoError } = await supabase
      .from('invoices')
      .update({ credited_invoice_id: null, status: creditStatus })
      .eq('id', creditNoteId)
      .eq('company_id', companyId)
      .eq('credited_invoice_id', invoiceId)
      .select('id')
    if (undoError || !undone || undone.length === 0) {
      log.error('credit note link could not be undone after the original refused the credit', undoError ?? undefined, {
        creditNoteId,
        invoiceId,
      })
    }
    if (flipped.error) return dbFailure(flipped.error)
    return { ok: false, code: 'INVOICE_CREDIT_LINK_RACE' }
  }

  // The event log's record of who credited the invoice and when, and what
  // the ordinary credit tells its listeners (a payment link on the original
  // is void). The link itself stands whatever a listener does.
  try {
    await eventBus.emit({
      type: 'credit_note.created',
      payload: { creditNote: linked as unknown as CreditNote, companyId, userId },
    })
  } catch (error) {
    log.warn('credit_note.created emit failed after a completed credit note link', error)
  }

  return {
    ok: true,
    dryRun: false,
    creditNote: linked as Row,
    original: { ...original, status: 'credited' },
    creditAmount,
    openAmount,
    currency,
  }
}
