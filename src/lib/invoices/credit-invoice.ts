/**
 * Credit an issued customer invoice with a kreditfaktura ("Kreditera").
 *
 * One implementation behind every door. The dashboard creates the credit
 * note as a draft (POST /api/invoices with credited_invoice_id:
 * createCreditNoteDraft) and issues it when the user marks it sent
 * (issueCreditNoteDraft); the v1 route (POST /invoices/{id}/credit) and the
 * MCP executor (gnubok_credit_invoice) do both in one call (creditInvoice).
 * Before this each of the three held its own copy and they had drifted: v1
 * and MCP copied the items without the ROT/RUT and periodisering fields (the
 * reversal then credited 1510 for the whole total and left 1513 standing,
 * and reversed deferred revenue on 30xx while the schedule kept dissolving),
 * v1 dropped override revenue accounts, a self-billed original was numbered
 * "KR-null" or after its id, MCP and the dashboard credited a credit note
 * (a second reversal of the same sale), and v1/MCP flipped the original to
 * 'credited' before the verifikat existed, keeping an issued credit note
 * with no verifikat when the period was missing or locked. The supplier
 * side was merged the same way (lib/supplier-invoices/credit.ts, #2980).
 *
 * What a credit does (ML 17 kap 22-23 §): the credit note gets its own
 * number (KR-<the original's number>), refers to the original and mirrors
 * it line for line with negated amounts, the same VAT, payee, ROT/RUT and
 * periodisering fields, so the reversing verifikat is the exact mirror of
 * the original's (Cr 1513 for Skatteverket's share and Cr 1510 for the
 * customer's on ROT/RUT, Dr 29xx where revenue is still deferred). The seller
 * reduces utgående moms in the credit note's period, dated today in
 * Stockholm, which must be open: the period is checked before anything is
 * written. Issue is fail closed: the original is flipped to 'credited' only
 * after the verifikat exists, and a draft whose verifikat could not be posted
 * goes back to draft for a retry (issueCreditNote is idempotent).
 *
 * A deferred-booking original (#967) that was never booked is booked first,
 * on its own date, through the Bokför step (accounted#45): the sale and its
 * credit are both affärshändelser, and a reversal of a sale the books never
 * recorded would understate revenue and utgående moms. When the original
 * cannot be booked the credit is refused before anything is written.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { creditBooksOriginalFirst } from '@/lib/bookkeeping/booking-mode'
import { scheduleCollectionForwardDrain } from '@/lib/collections/forward-hook'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { Logger } from '@/lib/logger'
import type { AccountingMethod, CompanySettings, CreditNote, Invoice, InvoiceItem } from '@/types'
import {
  buildCreditNoteFields,
  creditNoteNumber,
  creditNoteOriginalReference,
  isCreditNoteDocument,
} from './build-credit-note'
import { buildCreditNoteItem } from './build-credit-note-item'
import {
  creditIssueFailureCode,
  creditNoteNeedsJournalEntry,
  issueCreditNote,
  originalBookingRefusal,
  type CreditIssueFailureCode,
  type CreditNoteIssueFailure,
  type CreditNoteOriginalInvoice,
} from './issue-credit-note'
import { bookInvoice } from './book-service'
import { archiveIssuedInvoicePdf, type IssuePartialFailure } from './issue-and-book-invoice'
import { recordManualInvoiceDelivery } from './invoice-deliveries'
import { isCreditableInvoiceStatus } from '@/lib/bookkeeping/creditable-statuses'

/** The joined row a credit note is created and issued from. */
const CREDIT_ROW_SELECT = '*, customer:customers(*), items:invoice_items(*)'

type CreditRow = CreditNote & {
  customer?: { name?: string | null } | null
  items?: InvoiceItem[] | null
}

export interface CreditRefusal {
  code: string
  details?: Record<string, unknown>
}

/**
 * What creditNoteRefusal reads off the original. `total` is required: it is
 * how a credit note without a link to its original is recognised.
 */
export type CreditableOriginal = Pick<Invoice, 'status' | 'total'> &
  Partial<Pick<Invoice, 'document_type' | 'credited_invoice_id' | 'invoice_number' | 'external_invoice_number'>> & {
    deduction_reclaimed_total?: number | null
  }

/**
 * Why an invoice cannot be credited, or null when it can. The one guard
 * list every door runs, MCP staging included.
 */
export function creditNoteRefusal(original: CreditableOriginal): CreditRefusal | null {
  if (original.document_type && original.document_type !== 'invoice') {
    return { code: 'INVOICE_CREDIT_NOT_INVOICE', details: { document_type: original.document_type } }
  }
  // A credit note is document_type 'invoice' too: crediting it would post a
  // second reversal of the same sale (Dr revenue/26xx, Cr 1510 again). One
  // imported without a link to its original is recognised by its total
  // below zero (isCreditNoteDocument), whatever status the import gave it.
  if (isCreditNoteDocument(original)) {
    return { code: 'INVOICE_CREDIT_NOT_INVOICE', details: { reason: 'credit_note' } }
  }
  if (original.status === 'credited') {
    return { code: 'INVOICE_CREDIT_ALREADY_CREDITED' }
  }
  // 'partially_paid' is not here, and that is a real gap, not a rule: an
  // ändringsfaktura per ML (2023:200) 17 kap 22-23 §§ references the
  // original's löpnummer whatever has been paid. It is not widened here
  // alone because issueCreditNote() flips the original to 'credited' with the
  // same three-status compare-and-set, AFTER the reversing verifikat is
  // posted: widening only this check would post an immutable voucher and
  // then fail on the flip. 'draft' (never issued, no löpnummer to reference)
  // and 'cancelled' are refused either way.
  if (!isCreditableInvoiceStatus(original.status)) {
    return { code: 'INVOICE_CREDIT_NOT_SENT', details: { current_status: original.status } }
  }
  // A refused ROT/RUT share booked onto the customer (rot_rut_reclaim) moved
  // kronor from 1513 to 1510 after issue; the credit note reverses the
  // issue-time split and would leave a phantom fordran on 1510 and a phantom
  // liability on 1513. Reverse the reclaim voucher first.
  if (Number(original.deduction_reclaimed_total ?? 0) > 0) {
    return {
      code: 'INVOICE_CREDIT_ROT_RUT_RECLAIMED',
      details: { deduction_reclaimed_total: original.deduction_reclaimed_total },
    }
  }
  // Self-billed originals carry their number in external_invoice_number
  // (issue #1820); an issued invoice without either cannot be referred to.
  if (!creditNoteOriginalReference({
    invoice_number: original.invoice_number ?? null,
    external_invoice_number: original.external_invoice_number ?? null,
  })) {
    return { code: 'INVOICE_CREDIT_NO_NUMBER' }
  }
  return null
}

export type CreditNoteDraftResult =
  | { ok: true; creditNote: CreditRow; outcome: 'created' | 'existing' | 'reopened' }
  | {
      ok: false
      code: 'INVOICE_CREATE_INSERT_FAILED' | 'INVOICE_CREATE_ITEMS_FAILED' | 'DB_ERROR'
      dbError?: { code?: string; message?: string } | null
    }

/**
 * The credit note of `original` as a draft, created once: an existing one is
 * returned (idempotent), a cancelled draft that was never booked is reopened
 * so its deterministic KR number is reused, and a half-written one (items
 * failed) is removed again. The caller has run creditNoteRefusal. Issuing it
 * is issueCreditNoteDraft's job: until then nothing is booked and the
 * original keeps its status.
 */
export async function createCreditNoteDraft(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  original: Invoice & { items?: InvoiceItem[] | null },
  input: { reason?: string | null },
  log: Logger,
): Promise<CreditNoteDraftResult> {
  const originalRef = creditNoteOriginalReference(original) as string
  const today = todayIsoStockholm()

  const { data: existing, error: existingError } = await supabase
    .from('invoices')
    .select(CREDIT_ROW_SELECT)
    .eq('credited_invoice_id', original.id)
    .eq('company_id', companyId)
    .eq('creation_complete', true)
    .maybeSingle()

  if (existingError) {
    log.error('failed to check for an existing credit note', existingError)
    return { ok: false, code: 'DB_ERROR', dbError: existingError }
  }
  if (existing) {
    if (existing.status === 'cancelled' && !existing.journal_entry_id) {
      const { error: reopenError } = await supabase
        .from('invoices')
        .update({
          status: 'draft',
          invoice_date: today,
          due_date: today,
          notes: input.reason || `Krediterar faktura ${originalRef}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .eq('company_id', companyId)
        .eq('status', 'cancelled')

      if (reopenError) {
        log.error('failed to reopen cancelled credit note draft', reopenError)
        return { ok: false, code: 'DB_ERROR', dbError: reopenError }
      }

      const { data: reopened, error: reopenedError } = await supabase
        .from('invoices')
        .select(CREDIT_ROW_SELECT)
        .eq('id', existing.id)
        .eq('company_id', companyId)
        .single()

      if (reopenedError || !reopened) {
        return { ok: false, code: 'DB_ERROR', dbError: reopenedError ?? { message: 'Credit note draft not found' } }
      }
      return { ok: true, creditNote: reopened as CreditRow, outcome: 'reopened' }
    }
    return { ok: true, creditNote: existing as CreditRow, outcome: 'existing' }
  }

  const { data: creditNote, error: creditNoteError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: creditNoteNumber(originalRef),
      ...buildCreditNoteFields(original, {
        originalReference: originalRef,
        reason: input.reason,
        today,
      }),
      status: 'draft',
      creation_complete: false,
    })
    .select()
    .single()

  if (creditNoteError) {
    if (creditNoteError.code === '23505') {
      // A concurrent credit of the same original won: return its note.
      const { data: raced } = await supabase
        .from('invoices')
        .select(CREDIT_ROW_SELECT)
        .eq('credited_invoice_id', original.id)
        .eq('company_id', companyId)
        .eq('creation_complete', true)
        .maybeSingle()
      if (raced) return { ok: true, creditNote: raced as CreditRow, outcome: 'existing' }
    }
    log.error('credit note insert failed', creditNoteError)
    return { ok: false, code: 'INVOICE_CREATE_INSERT_FAILED', dbError: creditNoteError }
  }

  const creditNoteItems = (original.items ?? []).map((item: InvoiceItem) =>
    buildCreditNoteItem(creditNote.id, item),
  )

  const { error: itemsError } = await supabase.from('invoice_items').insert(creditNoteItems)

  if (itemsError) {
    const { error: cleanupError } = await supabase
      .from('invoices')
      .delete()
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
      .eq('creation_complete', false)
    if (cleanupError) {
      log.error('failed to clean up incomplete credit note', cleanupError, {
        creditNoteId: creditNote.id,
      })
    }
    log.error('credit note items insert failed; rolled back', itemsError, {
      creditNoteId: creditNote.id,
    })
    return { ok: false, code: 'INVOICE_CREATE_ITEMS_FAILED', dbError: itemsError }
  }

  const { error: completionError } = await supabase
    .from('invoices')
    .update({ creation_complete: true, updated_at: new Date().toISOString() })
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .eq('creation_complete', false)

  if (completionError) {
    log.error('failed to mark credit note creation complete', completionError, {
      creditNoteId: creditNote.id,
    })
    return { ok: false, code: 'INVOICE_CREATE_ITEMS_FAILED' }
  }

  const { data: complete, error: completeError } = await supabase
    .from('invoices')
    .select(CREDIT_ROW_SELECT)
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .eq('creation_complete', true)
    .single()

  if (completeError || !complete) {
    log.error('failed to read completed credit note', completeError)
    return { ok: false, code: 'INVOICE_CREATE_ITEMS_FAILED' }
  }

  return { ok: true, creditNote: complete as CreditRow, outcome: 'created' }
}

export interface IssueCreditNoteDraftInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** The credit note with customer and items joined (CREDIT_ROW_SELECT). */
  creditNote: CreditRow
  /** Full company settings: the accounting method and the archived PDF. */
  settings: CompanySettings
  log: Logger
  /**
   * Record a manual delivery once this call issued the draft ("Markera som
   * skickad"). Off where the credit note is issued without being delivered
   * (v1 credit, MCP).
   */
  recordDelivery: boolean
}

export type IssueCreditNoteDraftResult =
  | {
      ok: true
      journalEntryId: string | null
      partialFailures: IssuePartialFailure[]
      /** The original's own verifikat when the issue booked it first (accounted#45). */
      originalJournalEntryId?: string
    }
  | {
      ok: false
      code:
        | 'INVOICE_CREDIT_ORIGINAL_NOT_FOUND'
        | 'INVOICE_CREDIT_ALREADY_ISSUED'
        | 'INVOICE_MARK_SENT_STATUS_FAILED'
        | 'INVOICE_MARK_SENT_RACE'
        | CreditIssueFailureCode
      details?: Record<string, unknown>
      failures?: CreditNoteIssueFailure[]
      /** INVOICE_CREDIT_REPAIR_REQUIRED: the verifikat that posted. */
      journalEntryId?: string | null
      /** The original's own verifikat when it was booked before the failure (accounted#45). */
      originalJournalEntryId?: string
    }


/**
 * Issue a credit-note draft: compare-and-set it to 'sent' (skipped when it
 * already is, the repair of an earlier incomplete issue), post the reversing
 * verifikat and flip the original through issueCreditNote, and put it back
 * to draft when no verifikat could be posted. Then the PDF is archived as
 * underlag and, when asked, the manual delivery recorded.
 */
export async function issueCreditNoteDraft(
  input: IssueCreditNoteDraftInput,
): Promise<IssueCreditNoteDraftResult> {
  const { supabase, companyId, userId, creditNote, settings, log } = input

  const accountingMethod = (settings.accounting_method || 'accrual') as AccountingMethod
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings.entity_type)

  const { data: original } = await supabase
    .from('invoices')
    .select('id, invoice_number, external_invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
    .eq('id', creditNote.credited_invoice_id)
    .eq('company_id', companyId)
    .single()

  if (!original) {
    return { ok: false, code: 'INVOICE_CREDIT_ORIGINAL_NOT_FOUND' }
  }

  const originalInvoice = original as CreditNoteOriginalInvoice
  // Self-billed originals carry their number in external_invoice_number
  // (invoice_number is null by design); without the fallback the credit-note
  // PDF loses its ML 17 kap 22 reference to the original (issue #1820).
  const originalInvoiceNumber =
    original.invoice_number ?? original.external_invoice_number ?? undefined

  const journalEntryRequired = creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
  const isRecovery = creditNote.status === 'sent'

  if (
    isRecovery &&
    originalInvoice.status === 'credited' &&
    (!journalEntryRequired || !!creditNote.journal_entry_id)
  ) {
    return { ok: false, code: 'INVOICE_CREDIT_ALREADY_ISSUED' }
  }

  // Compare-and-set prevents two concurrent requests from posting two journal
  // entries for the same draft.
  let statusFlipped = false
  if (!isRecovery) {
    const { data: updatedRows, error: updateError } = await supabase
      .from('invoices')
      .update({ status: 'sent' })
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select('id')

    if (updateError) {
      log.error('credit note status update to sent failed', updateError)
      return { ok: false, code: 'INVOICE_MARK_SENT_STATUS_FAILED' }
    }
    if (!updatedRows || updatedRows.length === 0) {
      return { ok: false, code: 'INVOICE_MARK_SENT_RACE' }
    }
    statusFlipped = true
  }

  const partialFailures: IssuePartialFailure[] = []

  const issueResult = await issueCreditNote({
    supabase,
    companyId,
    userId,
    creditNote,
    originalInvoice,
    entityType,
    accountingMethod,
    deferInvoiceBooking: !!settings.defer_invoice_booking,
    log,
  })
  // Issued: when the credited invoice is under collection, a database trigger
  // queued the credit note for the provider.
  scheduleCollectionForwardDrain(companyId)
  const journalEntryId = issueResult.journalEntryId
  const originalJournalEntryId = issueResult.originalJournalEntryId
  partialFailures.push(...issueResult.failures)

  if (!issueResult.complete) {
    // If no immutable entry was created, restoring the draft is safe and
    // lets the user fix the period/account issue before trying again.
    if (statusFlipped && issueResult.journalEntryRequired && !issueResult.journalEntryId) {
      await supabase
        .from('invoices')
        .update({ status: 'draft' })
        .eq('id', creditNote.id)
        .eq('company_id', companyId)
        .eq('status', 'sent')
        .is('journal_entry_id', null)
    }
    return {
      ok: false,
      ...creditIssueFailureCode(issueResult),
      failures: issueResult.failures,
      journalEntryId,
      ...(originalJournalEntryId ? { originalJournalEntryId } : {}),
    }
  }

  // Render and archive the PDF as underlag so it remains retrievable even if
  // the invoice row is later cancelled. Credit notes are real invoices
  // (document_type 'invoice'), so this mirrors the invoice path.
  const isRealInvoice = !creditNote.document_type || creditNote.document_type === 'invoice'
  if (isRealInvoice) {
    const pdfFailure = await archiveIssuedInvoicePdf({
      supabase,
      companyId,
      userId,
      invoice: creditNote as Invoice,
      settings,
      journalEntryId,
      originalInvoiceNumber,
      log,
    })
    if (pdfFailure) partialFailures.push(pdfFailure)
  }

  if (statusFlipped && input.recordDelivery) {
    try {
      await recordManualInvoiceDelivery({
        supabase,
        companyId,
        userId,
        invoiceId: creditNote.id,
      })
    } catch (err) {
      log.error('failed to record manual invoice delivery', err as Error)
      partialFailures.push({
        step: 'delivery_history',
        reason: 'Utskicket kunde inte sparas i fakturans historik.',
      })
    }
  }

  return { ok: true, journalEntryId, partialFailures, ...(originalJournalEntryId ? { originalJournalEntryId } : {}) }
}

export interface CreditInvoiceContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

export type CreditInvoiceResult =
  | { ok: true; dryRun: true; preview: Record<string, unknown> }
  | {
      ok: true
      dryRun?: false
      creditNoteId: string
      journalEntryId: string | null
      partialFailures: IssuePartialFailure[]
      /** The original's own verifikat when the credit booked it first (accounted#45). */
      originalJournalEntryId?: string
    }
  | {
      ok: false
      code: string
      details?: Record<string, unknown>
      /** A database failure behind UNKNOWN_ERROR / the insert codes. */
      error?: unknown
      /** The issue steps that failed (INVOICE_CREDIT_ISSUE_INCOMPLETE / _REPAIR_REQUIRED). */
      failures?: CreditNoteIssueFailure[]
      /** Set when a verifikat was posted before the failure (INVOICE_CREDIT_REPAIR_REQUIRED). */
      postedIds?: Record<string, string>
    }

/**
 * Credit `invoiceId` in one call: the refusal, the period of today when a
 * verifikat is needed, the Bokför step's dry run for a deferred original
 * that is still unbooked, the draft, its issue. A dry run answers the credit
 * note it would issue and writes nothing.
 */
export async function creditInvoice(
  ctx: CreditInvoiceContext,
  invoiceId: string,
  input: { reason?: string | null },
  options: { dryRun?: boolean } = {},
): Promise<CreditInvoiceResult> {
  const { supabase, companyId, userId, log } = ctx

  const { data: original, error: fetchError } = await supabase
    .from('invoices')
    .select(CREDIT_ROW_SELECT)
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError) return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  if (!original) return { ok: false, code: 'INVOICE_CREDIT_ORIGINAL_NOT_FOUND' }
  const originalRow = original as Invoice & {
    items?: InvoiceItem[] | null
    deduction_reclaimed_total?: number | null
  }

  const refusal = creditNoteRefusal(originalRow)
  if (refusal) return { ok: false, ...refusal }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, code: 'UNKNOWN_ERROR', error: settingsError }
  if (!settings) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  const companySettings = settings as CompanySettings
  const accountingMethod = (companySettings.accounting_method || 'accrual') as AccountingMethod
  // A credit note reverses whatever actually reached the ledger: always under
  // faktureringsmetoden, under kontantmetoden once the original was paid
  // (issue #2552).
  const journalEntryRequired = creditNoteNeedsJournalEntry(accountingMethod, originalRow)
  // accounted#45: a deferred original that was never booked is booked first,
  // on its own date, by the Bokför step.
  const booksOriginalFirst = creditBooksOriginalFirst(companySettings, originalRow)

  // Fail closed before anything is written: the credit note is dated today
  // in Stockholm and its verifikat needs an open period for that date. A
  // missing period refuses too: the entry builder would book nothing.
  const today = todayIsoStockholm()
  if (journalEntryRequired) {
    const periodRefusal = await creditPeriodRefusal(supabase, companyId, today)
    if (periodRefusal) return { ok: false, ...periodRefusal }
  }

  // The Bokför step's dry run is every check that booking the original runs
  // (its date's lock, a fiscal year, the accounts the lines need) and writes
  // nothing: a refusal there refuses the credit before the draft exists.
  let originalEntryPreview: unknown = null
  if (booksOriginalFirst) {
    const originalBooking = await bookInvoice(ctx, originalRow.id, { dryRun: true })
    if (!originalBooking.ok) {
      if (originalBooking.code !== 'INVOICE_BOOK_ALREADY_BOOKED') {
        const { code, details } = originalBookingRefusal(originalRow.id, originalBooking)
        return { ok: false, code, details }
      }
    } else if (originalBooking.dryRun) {
      originalEntryPreview = originalBooking.preview.journal_entry ?? null
    }
  }

  const originalRef = creditNoteOriginalReference(originalRow) as string
  if (options.dryRun) {
    const {
      deduction_personnummer_encrypted: _encrypted,
      ...fields
    } = buildCreditNoteFields(originalRow, { originalReference: originalRef, reason: input.reason, today })
    return {
      ok: true,
      dryRun: true,
      preview: {
        id: '(allocated on commit)',
        invoice_number: creditNoteNumber(originalRef),
        status: 'sent',
        document_type: 'invoice',
        ...fields,
        items: (originalRow.items ?? []).map((item) => {
          const { invoice_id: _invoiceId, ...row } = buildCreditNoteItem('', item)
          return row
        }),
        would_create_journal_entry: journalEntryRequired,
        // accounted#45: the original's own verifikat posts first, on its date.
        ...(booksOriginalFirst
          ? { would_book_original_first: true, original_journal_entry: originalEntryPreview }
          : {}),
        accounting_method: accountingMethod,
        original_invoice_number: originalRef,
      },
    }
  }

  const draft = await createCreditNoteDraft(supabase, companyId, userId, originalRow, input, log)
  if (!draft.ok) {
    return {
      ok: false,
      code: draft.code === 'DB_ERROR' ? 'UNKNOWN_ERROR' : draft.code,
      ...(draft.dbError ? { details: { pg_code: draft.dbError.code }, error: draft.dbError } : {}),
    }
  }
  const creditNote = draft.creditNote

  // An existing draft from an earlier day books on its own date: check it.
  if (journalEntryRequired && creditNote.status === 'draft' && creditNote.invoice_date !== today) {
    const periodRefusal = await creditPeriodRefusal(supabase, companyId, creditNote.invoice_date)
    if (periodRefusal) return { ok: false, ...periodRefusal }
  }

  const issued = await issueCreditNoteDraft({
    supabase,
    companyId,
    userId,
    creditNote,
    settings: companySettings,
    log,
    recordDelivery: false,
  })
  if (!issued.ok) {
    return {
      ok: false,
      code: issued.code,
      ...(issued.details ? { details: issued.details } : {}),
      ...(issued.failures ? { failures: issued.failures } : {}),
      ...(issued.code === 'INVOICE_CREDIT_REPAIR_REQUIRED' && issued.journalEntryId
        ? {
            postedIds: {
              credit_note_id: creditNote.id,
              original_invoice_id: originalRow.id,
              journal_entry_id: issued.journalEntryId,
              ...(issued.originalJournalEntryId
                ? { original_journal_entry_id: issued.originalJournalEntryId }
                : {}),
            },
          }
        : issued.originalJournalEntryId
          ? {
              // The original was booked (accounted#45) but the credit was
              // not: that verifikat stands, and a retry posts only the credit.
              postedIds: {
                credit_note_id: creditNote.id,
                original_invoice_id: originalRow.id,
                original_journal_entry_id: issued.originalJournalEntryId,
              },
            }
          : {}),
    }
  }

  return {
    ok: true,
    creditNoteId: creditNote.id,
    journalEntryId: issued.journalEntryId,
    partialFailures: issued.partialFailures,
    ...(issued.originalJournalEntryId ? { originalJournalEntryId: issued.originalJournalEntryId } : {}),
  }
}

/** INVOICE_CREDIT_PERIOD_LOCKED when `date` cannot take the reversing verifikat. */
async function creditPeriodRefusal(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<CreditRefusal | null> {
  const verdict = await checkPeriodLock(supabase, companyId, date)
  if (!verdict.locked && verdict.reason !== 'no_fiscal_period') return null
  return {
    code: 'INVOICE_CREDIT_PERIOD_LOCKED',
    details: {
      reason: verdict.reason,
      ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
      invoice_date: date,
    },
  }
}
