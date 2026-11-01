/**
 * Credit a registered supplier invoice with a kreditfaktura ("Kreditera").
 *
 * One service behind every door: the dashboard route
 * (POST /api/supplier-invoices/{id}/credit), the v1 route
 * (POST /api/v1/companies/{companyId}/supplier-invoices/{id}/credit) and the
 * MCP executor (gnubok_credit_supplier_invoice). Before issue #2980 each door
 * held its own copy and they had drifted: the MCP copy never cancelled the
 * periodisering schedules or copied the reverse-charge rate and the SLP flag,
 * the dashboard copy dated the credit in UTC and kept a credit note whose
 * verifikat could not be posted, and only v1 checked the period lock first.
 *
 * What a credit does:
 *   - a credit note row mirrors the WHOLE original (a partial credit is not
 *     this operation), rests at 'credited' and carries the supplier's own
 *     credit note number, its date and its document when there is one;
 *   - the reversing verifikat (Dr 2440, Cr cost and 2641) is posted through
 *     the engine on the credit note's date whenever the original reached the
 *     ledger, and the document becomes its underlag (BFL 5 kap 6 §); a
 *     deferring company's original that has no verifikat yet is booked first
 *     by the Bokför step, on its own date (accounted#58); an
 *     original whose rows do not add up to its payable (or that has no rows
 *     at all) is refused instead (SI_CREDIT_ROWS_MISMATCH), on a dry run too
 *     and before an ankomstnummer is drawn or anything is written;
 *   - the original moves to 'credited' with nothing left to pay;
 *   - periodisering schedules on the original stop, and their posted
 *     dissolutions are stornoed (best-effort: a warning, never a failure).
 *
 * The credit note's date: the buyer reduces ingående moms in the period of
 * the kreditfaktura (ML 17 kap 22-23 §, swedish-invoice-compliance), and a
 * verifikation is dated when the affärshändelse happened (BFL 5 kap 7 §), so
 * a credit note that came as a document is booked on its own date. That
 * period must be open: a locked one is refused, never silently re-dated.
 * Without a document the date is today in Stockholm, as before.
 *
 * From the inbox (inbox_item_id): the item's reading gives the date, the
 * number and the document, the credit note must be for the invoice's whole
 * amount in its currency (anything else is refused, never full-credited),
 * and the item is marked converted to the credit note.
 */
import { z } from 'zod'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { CoreEvent } from '@/lib/events/types'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { eventBus } from '@/lib/events'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { supplierInvoiceStornoBusinessEvent } from '@/lib/bookkeeping/supplier-invoice-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { postingPort } from '@/lib/posting/port'
import {
  assertSupplierCreditNoteRowsMatchPayable,
  createSupplierCreditNoteEntry,
  SupplierCreditNoteRowsMismatchError,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { supplierCreditBooksOriginalFirst, supplierCreditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { normalizeVatRateToFraction } from '@/lib/vat/supplier-invoice-line-checks'
import { roundOre } from '@/lib/money'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { isoDateSchema } from '@/lib/invariants/zod'
import {
  SUPPLIER_CREDIT_NOTE_STATUS,
  buildSupplierCreditNoteRow,
  supplierCreditNoteNumber,
} from './credit-note'
import { compareCreditToInvoice, creditAmount, creditNoteFromReading } from './credit-target'
import { findSignedBankPayment, signedBankPaymentDetails } from '@/lib/payments/orders/signed-payment'
import { rejectSupersededInboxConversions } from '@/lib/pending-operations/supersede'
import { linkBasisColumns } from '@/lib/links/stamp'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { bookSupplierInvoice } from './book-service'
import { creditNoteSelfBillingSnapshot, type SelfBillingSnapshot } from './self-billing/snapshot'
import { archiveSelfBillingDocument, SELF_BILL_DOCUMENT_ARCHIVE_FAILED_WARNING } from './self-billing/archive'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The optional request body every door accepts. */
export const CreditSupplierInvoiceInputSchema = z.strictObject({
  credit_date: isoDateSchema
    .optional()
    .describe('The credit note\'s own date (YYYY-MM-DD). Defaults to the inbox item\'s reading, else today.'),
  supplier_credit_note_number: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('The supplier\'s number on the credit note. Defaults to the inbox item\'s reading, else KREDIT-<original number>.'),
  document_id: z
    .string()
    .uuid()
    .optional()
    .describe('The credit note document: attached as underlag to the credit verifikat. Defaults to the inbox item\'s document.'),
  inbox_item_id: z
    .string()
    .uuid()
    .optional()
    .describe('The inbox item holding the supplier\'s credit note: its date, number and document are used, and it is marked handled.'),
})

export type CreditSupplierInvoiceInput = z.infer<typeof CreditSupplierInvoiceInputSchema>

export interface CreditSupplierInvoiceResult {
  credit_note: SupplierInvoice
  original_id: string
  journal_entry_id: string | null
  /** The original's registration verifikat, when this credit booked it first (accounted#58). */
  original_journal_entry_id: string | null
  document_id: string | null
  inbox_item_id: string | null
}

// Everything the credit reads off the original: the amounts it mirrors, the
// booked-ness signals supplierCreditNoteNeedsJournalEntry() needs, and the
// items the reversal is computed from (apply_slp and the periodisering
// fields included, so SLP and 17xx lines reverse where they were booked).
const ORIGINAL_COLUMNS = `
  id, supplier_id, supplier_invoice_number, invoice_date, status,
  currency, exchange_rate,
  subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek,
  vat_treatment, reverse_charge, reverse_charge_kind, remaining_amount,
  registration_journal_entry_id, payment_journal_entry_id, paid_at, paid_amount,
  is_credit_note, credited_invoice_id, arrival_number, default_dimensions,
  is_self_billed, self_billing_agreement_ref, self_billing_snapshot,
  supplier:suppliers(id, name, supplier_type),
  items:supplier_invoice_items(*)
`

type SupplierRef = { id: string; name: string | null; supplier_type: string | null }

type Original = SupplierInvoice & {
  supplier: SupplierRef | SupplierRef[] | null
  items: SupplierInvoiceItem[] | null
}

interface InboxItemRow {
  id: string
  document_id: string | null
  matched_supplier_id: string | null
  extracted_data: Record<string, unknown> | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
}

const pickSupplier = (s: Original['supplier']): SupplierRef | null => (Array.isArray(s) ? (s[0] ?? null) : s)

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/** The refusal of rows that do not add up to the invoice, with both figures. */
function rowsMismatch(err: SupplierCreditNoteRowsMismatchError): Failure {
  return {
    ok: false,
    code: 'SI_CREDIT_ROWS_MISMATCH',
    details: { rows_payable_sek: err.rowsPayableSek, invoice_payable_sek: err.invoicePayableSek },
  }
}

type BookFailure = Extract<OperationOutcome<unknown>, { ok: false }>

/**
 * The credit refusal for an original the Bokför step would not book
 * (accounted#58), as the customer side answers it (originalBookingRefusal,
 * lib/invoices/issue-credit-note.ts): a lock on the original's date gets its
 * own code, every other refusal carries the Bokför step's own code in
 * details.original_booking_code.
 */
function originalBookingRefusal(originalId: string, failure: BookFailure): Failure {
  if (failure.code === 'PERIOD_LOCKED') {
    return {
      ok: false,
      code: 'SI_CREDIT_ORIGINAL_PERIOD_LOCKED',
      details: { original_id: originalId, ...(failure.details ?? {}) },
    }
  }
  const errorCode = (failure.error as { code?: unknown } | null | undefined)?.code
  const code = 'SI_CREDIT_ORIGINAL_BOOK_FAILED'
  return {
    ok: false,
    code,
    details: {
      original_id: originalId,
      original_booking_code: typeof errorCode === 'string' ? errorCode : failure.code,
      ...(failure.details ?? {}),
    },
    // A typed bookkeeping error names the concrete cause (a missing account,
    // an archived dimension); the registered message names the next step.
    ...(failure.error ? { messageSv: `${getErrorEntry(code)?.message_sv ?? code} ${getErrorMessage(failure.error, { context: 'supplier_invoice' })}` } : {}),
  }
}

/**
 * What the original owes in SEK, which its credit note must take off 244x:
 * total_sek, else the total of a SEK invoice, else the total at the
 * invoice's rate. Null when none is known (nothing to compare with).
 */
function originalPayableSek(original: Original): number | null {
  if (typeof original.total_sek === 'number' && Number.isFinite(original.total_sek)) return original.total_sek
  if (typeof original.total !== 'number' || !Number.isFinite(original.total)) return null
  if (original.currency === 'SEK') return original.total
  const rate = original.exchange_rate
  return rate != null && rate > 0 ? roundOre(original.total * rate) : null
}

function creditItemsFor(creditNoteId: string, items: SupplierInvoiceItem[]) {
  return items.map((item) => ({
    supplier_invoice_id: creditNoteId,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    account_number: item.account_number,
    vat_code: item.vat_code,
    vat_rate: normalizeVatRateToFraction(item.vat_rate),
    vat_amount: item.vat_amount,
    // The self-assessed RC rate, so the credit reverses fiktiv moms at the
    // rate the original was booked at.
    reverse_charge_rate: item.reverse_charge_rate ?? null,
    // Display parity: the journal reversal reads the ORIGINAL items, so the
    // 7533/2514 swap and the dimension cells are right either way.
    apply_slp: item.apply_slp ?? false,
    dimensions: item.dimensions ?? {},
  }))
}

/**
 * Undo a credit note row that did not make it. Before a verifikat exists the
 * row is not a bokföringspost and is deleted; after one may have been
 * committed it is kept as 'reversed' so the attempt stays in the trail
 * (BFL 5 kap 5 §).
 */
async function rollbackCreditNote(
  ctx: OperationContext,
  creditNoteId: string,
  reason: string,
  journalEntryPosted: boolean,
): Promise<void> {
  const { supabase, companyId, log } = ctx
  if (!journalEntryPosted) {
    await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', creditNoteId)
    const { error } = await supabase.from('supplier_invoices').delete().eq('id', creditNoteId).eq('company_id', companyId)
    if (error) log.error('credit note hard rollback failed: orphan row', error as unknown as Error, { creditNoteId, reason })
    return
  }
  const { error } = await supabase
    .from('supplier_invoices')
    .update({ status: 'reversed', reversed_at: new Date().toISOString() })
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
  if (error) {
    log.error('credit note soft rollback failed: manual reconciliation required', error as unknown as Error, {
      creditNoteId,
      reason,
    })
  }
}

/**
 * Take back the credit verifikat this credit just posted, on the credit date,
 * when the credit note cannot point at it or a concurrent credit won the
 * race. Through the posting port: while POSTING_EVENTS is on, the storno
 * records ledger.storno of the credit note (system_derived: no one chose it).
 */
async function reverseOwnCreditEntry(
  ctx: OperationContext,
  journalEntryId: string,
  creditDate: string,
  creditNoteId: string,
): Promise<void> {
  const { supabase, companyId, userId } = ctx
  await postingPort.reverseJournalEntry({
    supabase,
    companyId,
    userId,
    entryId: journalEntryId,
    reversalDate: creditDate,
    event: () => supplierInvoiceStornoBusinessEvent(creditNoteId, todayIsoStockholm(), linkBasisColumns('system_derived')),
    role: 'reversal',
  })
}

export async function creditSupplierInvoice(
  ctx: OperationContext,
  supplierInvoiceId: string,
  input: CreditSupplierInvoiceInput = {},
  options: { dryRun?: boolean; emit?: (event: CoreEvent) => Promise<void> } = {},
): Promise<OperationOutcome<CreditSupplierInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx
  const emit = options.emit ?? ((event: CoreEvent) => eventBus.emit(event))

  const { data: row, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select(ORIGINAL_COLUMNS)
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError) return failed(fetchError)
  if (!row) return { ok: false, code: 'SI_NOT_FOUND' }
  const original = row as unknown as Original
  if (original.is_credit_note) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'supplier_invoice_id', message: 'A credit note cannot be credited: undo the credit on the original instead.' },
    }
  }
  if (original.status === 'credited') return { ok: false, code: 'SI_CREDIT_ALREADY_CREDITED' }

  // A signed bank payment still executes: crediting beside it closes an invoice
  // the bank is about to pay. The way out is cancelling that payment first
  // (crm#1243), on a dry run too.
  const signedBankPayment = await findSignedBankPayment(supabase, companyId, supplierInvoiceId)
  if (signedBankPayment) {
    return { ok: false, code: 'SI_BANK_PAYMENT_UNDER_WAY', details: signedBankPaymentDetails(signedBankPayment) }
  }

  const supplier = pickSupplier(original.supplier)
  const originalItems = original.items ?? []

  // A self-billing invoice is credited by our own credit note: its number
  // comes from the same series and Accounted makes the document, so a
  // supplier's number, document or inbox item has no place here (crm#1367).
  let selfBilling: { agreementRef: string; snapshot: SelfBillingSnapshot } | null = null
  if (original.is_self_billed) {
    if (input.supplier_credit_note_number || input.document_id || input.inbox_item_id) {
      return { ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: 'credit_input' } }
    }
    const snapshot = original.supplier_invoice_number
      ? creditNoteSelfBillingSnapshot(original.self_billing_snapshot, {
          number: original.supplier_invoice_number,
          invoice_date: original.invoice_date,
        })
      : null
    if (!snapshot || !original.self_billing_agreement_ref) {
      log.error('credit: the self-billing invoice has no readable snapshot', new Error('self_billing_snapshot'), {
        supplierInvoiceId,
      })
      return { ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'self_billing_snapshot' } }
    }
    selfBilling = { agreementRef: original.self_billing_agreement_ref, snapshot }
  }

  // The credit note in the inbox, when the credit comes from one.
  let item: InboxItemRow | null = null
  if (input.inbox_item_id) {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('id, document_id, matched_supplier_id, extracted_data, created_supplier_invoice_id, created_journal_entry_id')
      .eq('id', input.inbox_item_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return failed(error)
    if (!data) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
    item = data as InboxItemRow
    if (item.created_supplier_invoice_id || item.created_journal_entry_id) {
      return {
        ok: false,
        code: 'INBOX_ITEM_ALREADY_CONVERTED',
        details: {
          supplier_invoice_id: item.created_supplier_invoice_id,
          journal_entry_id: item.created_journal_entry_id,
        },
      }
    }
  }
  const reading = item ? creditNoteFromReading(item.extracted_data) : null

  if (item && reading) {
    // The credit note must be from this invoice's supplier and for all of
    // it: the credit mirrors the whole original, so crediting a part (or a
    // misread amount) in full would take more off the books than the
    // supplier did.
    if (item.matched_supplier_id && item.matched_supplier_id !== original.supplier_id) {
      return {
        ok: false,
        code: 'SI_CREDIT_DOCUMENT_MISMATCH',
        details: { reason: 'supplier', inbox_supplier_id: item.matched_supplier_id, invoice_supplier_id: original.supplier_id },
      }
    }
    const verdict = compareCreditToInvoice(reading, original)
    const figures = {
      credit_total: creditAmount(reading.total),
      credit_currency: reading.currency,
      invoice_total: original.total,
      invoice_currency: original.currency,
    }
    if (verdict === 'partial') return { ok: false, code: 'SI_CREDIT_PARTIAL', details: figures }
    if (verdict !== 'full') {
      return { ok: false, code: 'SI_CREDIT_DOCUMENT_MISMATCH', details: { reason: verdict, ...figures } }
    }
  }

  // Date: given, else the credit note's own, else today (Stockholm).
  const documentDate = reading?.creditNoteDate ?? null
  const creditDate = input.credit_date ?? documentDate ?? getSwedishLocalDate()
  const dateSource: 'input' | 'document' | 'today' = input.credit_date ? 'input' : documentDate ? 'document' : 'today'
  if (!ISO_DATE_RE.test(creditDate)) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'credit_date', message: 'Expected YYYY-MM-DD.' } }
  }
  if (dateSource !== 'today' && creditDate < original.invoice_date) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'credit_date',
        message: `A credit note cannot be dated before the invoice it credits (${original.invoice_date}).`,
        credit_date: creditDate,
        invoice_date: original.invoice_date,
      },
    }
  }
  // A self-billing credit note's number is drawn from the series on insert.
  const creditNumber = selfBilling
    ? null
    : supplierCreditNoteNumber(
        original.supplier_invoice_number,
        input.supplier_credit_note_number ?? reading?.creditNoteNumber ?? null,
      )

  // The document: given, else the inbox item's. It becomes the credit
  // verifikat's underlag, so one already on another verifikat is refused.
  const documentId = input.document_id ?? item?.document_id ?? null
  if (documentId) {
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (docError) return failed(docError)
    if (!doc) return { ok: false, code: 'SI_CREDIT_DOCUMENT_UNAVAILABLE', details: { reason: 'not_found', document_id: documentId } }
    const linkedTo = (doc as { journal_entry_id: string | null }).journal_entry_id
    if (linkedTo) {
      return {
        ok: false,
        code: 'SI_CREDIT_DOCUMENT_UNAVAILABLE',
        details: { reason: 'linked', document_id: documentId, journal_entry_id: linkedTo },
      }
    }
  }

  // The credit is booked on its own date: that period must take a verifikat.
  const lock = await checkPeriodLock(supabase, companyId, creditDate)
  if (lock.locked) {
    return {
      ok: false,
      code: 'SI_CREDIT_PERIOD_LOCKED',
      details: {
        reason: lock.reason,
        credit_date: creditDate,
        date_source: dateSource,
        ...(lock.fiscal_period_id ? { fiscal_period_id: lock.fiscal_period_id } : {}),
      },
    }
  }

  // Fail closed (accounted#58): read as faktureringsmetoden, an unpaid
  // kontantmetod original would get a reversal of a cost never booked.
  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', companyId)
    .maybeSingle()
  const method = checkAccountingMethod(settingsRead)
  if (!method.ok) return { ok: false, code: method.code, details: method.details }
  const { accountingMethod } = method
  // Kontantmetoden skips only while the original is still UNPAID: nothing
  // reached the ledger. A paid original was booked by its payment verifikat
  // (expense + 2641), and leaving that un-reversed overstates both.
  const postsEntry = supplierCreditNoteNeedsJournalEntry(accountingMethod, original)
  // accounted#58: a deferring company's original that was never booked is
  // booked first, on its own date, by the Bokför step.
  let booksOriginalFirst = supplierCreditBooksOriginalFirst(
    settingsRead.data as { accounting_method?: string | null; defer_invoice_booking?: boolean | null },
    original,
  )
  const supplierType = supplier?.supplier_type || 'swedish_business'
  const payableSek = originalPayableSek(original)

  // The verifikat reverses the original's rows, so rows that do not add up to
  // what the invoice owes are refused. Asked here, of the rule the builder
  // itself posts by, BEFORE the dry-run answer and the arrival-number
  // sequence: a dry run and a staged credit refuse what the commit would, and
  // a refused Kreditera never burns an ankomstnummer or writes a credit note
  // row to delete again (same ordering as create.ts).
  if (postsEntry) {
    try {
      await assertSupplierCreditNoteRowsMatchPayable(
        supabase, companyId, original, originalItems, supplierType, payableSek,
      )
    } catch (err) {
      if (err instanceof SupplierCreditNoteRowsMismatchError) return rowsMismatch(err)
      // The lines could not be built at all (a foreign invoice without a
      // rate, momskoder that could not be read), so the verifikat could not
      // be either: the credit stops here, as on any failed read above.
      return failed(err)
    }
  }

  // The Bokför step's dry run is every check that booking the original runs
  // (its date's lock, a fiscal year, the accounts its rows need) and writes
  // nothing: a refusal there refuses the credit before anything is written.
  let originalEntryPreview: unknown = null
  if (booksOriginalFirst) {
    const planned = await bookSupplierInvoice(ctx, original.id, { dryRun: true })
    if (!planned.ok) {
      // Booked since it was read: the credit reverses that verifikat.
      if (planned.code !== 'SI_BOOK_ALREADY_BOOKED') return originalBookingRefusal(original.id, planned)
      booksOriginalFirst = false
    } else if (planned.dryRun) {
      originalEntryPreview = planned.preview.journal_entry ?? null
    }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        credit_note: {
          supplier_id: original.supplier_id,
          supplier_invoice_number: creditNumber,
          invoice_date: creditDate,
          due_date: creditDate,
          status: SUPPLIER_CREDIT_NOTE_STATUS,
          currency: original.currency,
          exchange_rate: original.exchange_rate,
          subtotal: original.subtotal,
          vat_amount: original.vat_amount,
          total: original.total,
          is_credit_note: true,
          credited_invoice_id: original.id,
          document_id: documentId,
          is_self_billed: selfBilling !== null,
          items: creditItemsFor('(new)', originalItems).map(({ supplier_invoice_id: _drop, ...rest }) => rest),
        },
        original_id: original.id,
        original_supplier_invoice_number: original.supplier_invoice_number,
        // Names the original when it has no supplier number.
        original_arrival_number: original.arrival_number ?? null,
        supplier_name: supplier?.name ?? null,
        credit_date: creditDate,
        date_source: dateSource,
        inbox_item_id: item?.id ?? null,
        original_will_become: 'credited',
        would_create_reversal_journal_entry: postsEntry,
        // accounted#58: the original's own verifikat posts first, on its date.
        ...(booksOriginalFirst ? { would_book_original_first: true, original_journal_entry: originalEntryPreview } : {}),
      },
    }
  }

  // accounted#58: the registration first, through the Bokför step, once every
  // check above has passed. If a later step fails, the registration stays: a
  // registered invoice belongs in the books either way, the failure names it
  // (partialPostedIds), and a retry credits it like any booked original.
  let originalJournalEntryId: string | null = null
  const warnings: OperationWarning[] = []
  if (booksOriginalFirst) {
    const booked = await bookSupplierInvoice(ctx, original.id)
    if (!booked.ok) {
      // A concurrent Bokför got there first: the credit reverses that verifikat.
      if (booked.code !== 'SI_BOOK_ALREADY_BOOKED') return originalBookingRefusal(original.id, booked)
    } else if (!booked.dryRun) {
      originalJournalEntryId = booked.data.journal_entry_id
      warnings.push(...(booked.warnings ?? []))
      log.info('credit: booked the deferred original first', { supplierInvoiceId, originalJournalEntryId })
    }
  }
  const afterOriginal = (failure: Failure): Failure =>
    originalJournalEntryId
      ? {
          ...failure,
          details: { ...(failure.details ?? {}), original_journal_entry_id: originalJournalEntryId },
          partialPostedIds: { ...(failure.partialPostedIds ?? {}), original_journal_entry_id: originalJournalEntryId },
        }
      : failure

  const { data: arrivalNumber, error: arrivalError } = await supabase.rpc('get_next_arrival_number', {
    p_company_id: companyId,
  })
  if (arrivalError || arrivalNumber == null) {
    log.error('credit: arrival number allocation failed', (arrivalError as unknown as Error) ?? new Error('null'))
    return afterOriginal({ ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'arrival_number' } })
  }

  const { data: inserted, error: insertError } = await supabase
    .from('supplier_invoices')
    .insert(
      buildSupplierCreditNoteRow(original, {
        userId,
        companyId,
        arrivalNumber: arrivalNumber as number,
        date: creditDate,
        supplierCreditNoteNumber: creditNumber,
        documentId,
        selfBilling,
      }),
    )
    .select()
    .single()
  if (insertError || !inserted) {
    log.error('credit: credit note insert failed', insertError as unknown as Error, { supplierInvoiceId })
    return afterOriginal({
      ok: false,
      code: 'SI_CREDIT_FAILED',
      details: { step: 'credit_note_insert', pg_code: (insertError as { code?: string } | null)?.code },
    })
  }
  const creditNote = inserted as SupplierInvoice

  if (originalItems.length > 0) {
    const { error: itemsError } = await supabase
      .from('supplier_invoice_items')
      .insert(creditItemsFor(creditNote.id, originalItems))
    if (itemsError) {
      await rollbackCreditNote(ctx, creditNote.id, 'items_insert', false)
      return afterOriginal({
        ok: false,
        code: 'SI_CREDIT_FAILED',
        details: { step: 'credit_items_insert', pg_code: (itemsError as { code?: string }).code },
      })
    }
  }

  let journalEntryId: string | null = null
  if (postsEntry) {
    try {
      // The ORIGINAL items: deferred lines carry their periodisering fields
      // there, so the credit reverses against the same 17xx interim account.
      // The original's payable: the builder holds the rows to it once more,
      // as the backstop of the check above.
      const entry = await createSupplierCreditNoteEntry(
        supabase,
        companyId,
        userId,
        creditNote,
        originalItems,
        supplierType,
        supplier?.name ?? undefined,
        payableSek,
        // The posting port's event, while POSTING_EVENTS is on: the person
        // (or the approved operation) credited it, from this inbox item when
        // there is one.
        () => ({ linkBasis: linkBasisColumns('user_created'), inboxItemId: item?.id ?? null }),
      )
      if (!entry) {
        // No fiscal year covers the date: a credit without its verifikat
        // would leave reskontra and ledger apart, so nothing is kept.
        await rollbackCreditNote(ctx, creditNote.id, 'no_fiscal_period', false)
        return afterOriginal({
          ok: false,
          code: 'SI_CREDIT_FAILED',
          details: { step: 'credit_journal_entry', reason: 'no_fiscal_period', credit_date: creditDate },
        })
      }
      journalEntryId = entry.id
    } catch (err) {
      if (err instanceof SupplierCreditNoteRowsMismatchError) {
        // The backstop: the check above passed, or could not be made, and
        // the builder refuses. Before the engine was called: nothing was
        // posted, so the credit note row goes.
        await rollbackCreditNote(ctx, creditNote.id, 'rows_mismatch', false)
        return afterOriginal(rowsMismatch(err))
      }
      // The engine threw: assume the entry may have committed.
      await rollbackCreditNote(ctx, creditNote.id, 'credit_journal_entry', true)
      if (isBookkeepingError(err)) return afterOriginal({ ok: false, code: 'SI_CREDIT_FAILED', error: err })
      log.error('credit: journal entry failed', err as Error, { supplierInvoiceId, creditNoteId: creditNote.id })
      return afterOriginal({ ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry' } })
    }

    const { error: linkError } = await supabase
      .from('supplier_invoices')
      .update({ registration_journal_entry_id: journalEntryId })
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
    if (linkError) {
      // Never leave a posted reversal without its credit note row: storno it
      // and keep the row as reversed.
      log.error('credit: linking the verifikat failed, stornoing it', linkError as unknown as Error, {
        creditNoteId: creditNote.id,
        journalEntryId,
      })
      try {
        await reverseOwnCreditEntry(ctx, journalEntryId, creditDate, creditNote.id)
      } catch (revErr) {
        log.error('credit: storno after link failure failed, manual reconciliation required', revErr as Error, {
          journalEntryId,
        })
      }
      await rollbackCreditNote(ctx, creditNote.id, 'je_link_failed', true)
      return afterOriginal({ ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry_link' } })
    }
    creditNote.registration_journal_entry_id = journalEntryId
  }

  // Flip the original. The status guard keeps two concurrent credits from
  // both landing: the loser takes its own verifikat back and bows out.
  const { data: flipped, error: flipError } = await supabase
    .from('supplier_invoices')
    .update({ status: 'credited', remaining_amount: 0 })
    .eq('id', original.id)
    .eq('company_id', companyId)
    .not('status', 'in', '(credited,reversed)')
    .select('id')
    .maybeSingle()
  if (flipError) {
    // The verifikat stands: say which rows exist rather than roll back.
    log.error('credit: flipping the original to credited failed', flipError as unknown as Error, {
      supplierInvoiceId,
      creditNoteId: creditNote.id,
    })
    return afterOriginal({
      ok: false,
      code: 'SI_CREDIT_FAILED',
      details: { step: 'original_status_flip', credit_note_id: creditNote.id, journal_entry_id: journalEntryId },
    })
  }
  if (!flipped) {
    log.warn('credit: race, the original was credited meanwhile; rolling back', {
      supplierInvoiceId,
      creditNoteId: creditNote.id,
    })
    if (journalEntryId) {
      try {
        await reverseOwnCreditEntry(ctx, journalEntryId, creditDate, creditNote.id)
      } catch (revErr) {
        log.error('credit: storno of the losing credit failed', revErr as Error, { journalEntryId })
      }
    }
    await rollbackCreditNote(ctx, creditNote.id, 'credit_race', journalEntryId !== null)
    return afterOriginal({ ok: false, code: 'SI_CREDIT_ALREADY_CREDITED', details: { reason: 'race' } })
  }

  // The document is the credit verifikat's underlag. The credit note row
  // already points at it; a failed link is a warning, never a failure.
  if (documentId && journalEntryId) {
    const { error: docLinkError } = await supabase
      .from('document_attachments')
      .update({
        journal_entry_id: journalEntryId,
        // The credit verifikat was booked from this document.
        ...linkBasisColumns('user_created'),
      })
      .eq('id', documentId)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
    if (docLinkError) {
      log.warn('credit: attaching the credit note document to the verifikat failed', {
        documentId,
        journalEntryId,
        error: docLinkError.message,
      })
      warnings.push({
        code: 'CREDIT_DOCUMENT_NOT_LINKED',
        message_sv:
          'Fakturan krediterades, men kreditfakturans dokument kunde inte kopplas till verifikationen. Koppla det under Bokföring.',
        message_en:
          'The invoice was credited, but the credit note document could not be attached to the verifikat. Attach it under Bookkeeping.',
      })
    }
  }

  // A self-billing credit note's document: made from the stored row (its
  // number came from the insert) and archived as the credit verifikat's
  // underlag, or anchored at payment when no verifikat was posted.
  if (selfBilling) {
    const archivedId = await archiveSelfBillingDocument(ctx, {
      supplierInvoiceId: creditNote.id,
      invoice: {
        supplier_invoice_number: creditNote.supplier_invoice_number,
        invoice_date: creditNote.invoice_date,
        due_date: creditNote.due_date,
        delivery_date: creditNote.delivery_date ?? null,
        currency: creditNote.currency,
        subtotal: creditNote.subtotal,
        vat_amount: creditNote.vat_amount,
        total: creditNote.total,
        is_credit_note: true,
      },
      items: creditItemsFor(creditNote.id, originalItems),
      snapshot: selfBilling.snapshot,
      journalEntryId,
    })
    if (archivedId) {
      creditNote.document_id = archivedId
    } else {
      warnings.push({ ...SELF_BILL_DOCUMENT_ARCHIVE_FAILED_WARNING })
    }
  }

  // Periodisering: stop the remaining months and storno the posted
  // dissolutions so origin, dissolutions, stornos and credit net to zero.
  try {
    const cancelled = await cancelSchedulesForSource(
      supabase,
      companyId,
      userId,
      { supplierInvoiceId: original.id },
      { reversalDate: creditDate },
    )
    if (cancelled.failedReversals > 0) {
      warnings.push({
        code: 'ACCRUAL_CANCEL_PARTIAL',
        message_sv:
          'Fakturan krediterades, men en eller flera periodiseringsverifikat kunde inte vändas. Periodiseringen är fortfarande aktiv: kontrollera under Bokföring → Periodiseringar.',
        message_en:
          'The invoice was credited, but one or more accrual vouchers could not be reversed. The schedule is still active: check Bookkeeping → Accruals.',
      })
    }
  } catch (err) {
    log.warn('credit: cancelling accrual schedules failed', { supplierInvoiceId, error: (err as Error)?.message })
    warnings.push({
      code: 'ACCRUAL_CANCEL_PARTIAL',
      message_sv:
        'Fakturan krediterades, men periodiseringarna kunde inte avslutas. Kontrollera under Bokföring → Periodiseringar.',
      message_en: 'The invoice was credited, but its accrual schedules could not be stopped. Check Bookkeeping → Accruals.',
    })
  }

  // The inbox item is handled: it now points at the credit note.
  if (item) {
    const { error: itemError } = await supabase
      .from('invoice_inbox_items')
      .update({ created_supplier_invoice_id: creditNote.id })
      .eq('id', item.id)
      .eq('company_id', companyId)
      .is('created_supplier_invoice_id', null)
    if (itemError) {
      log.warn('credit: marking the inbox item handled failed', { inboxItemId: item.id, error: itemError.message })
    }
    await rejectSupersededInboxConversions(supabase, companyId, item.id, creditNote.id)
  }

  try {
    await emit({
      type: 'supplier_invoice.credited',
      payload: { supplierInvoice: original as SupplierInvoice, creditNote, companyId, userId },
    })
  } catch (err) {
    log.warn('supplier_invoice.credited event emission failed', { error: (err as Error)?.message })
  }

  return {
    ok: true,
    created: true,
    data: {
      credit_note: creditNote,
      original_id: original.id,
      journal_entry_id: journalEntryId,
      original_journal_entry_id: originalJournalEntryId,
      document_id: documentId,
      inbox_item_id: item?.id ?? null,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
