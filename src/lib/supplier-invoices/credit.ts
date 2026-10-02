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
 *     ledger, and the document becomes its underlag (BFL 5 kap 6 §);
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
import type { AccountingMethod, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { eventBus } from '@/lib/events'
import { getSwedishLocalDate, reverseEntry } from '@/lib/bookkeeping/engine'
import { createSupplierCreditNoteEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { supplierCreditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { normalizeVatRateToFraction } from '@/lib/vat/supplier-invoice-line-checks'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { isoDateSchema } from '@/lib/invariants/zod'
import {
  SUPPLIER_CREDIT_NOTE_STATUS,
  buildSupplierCreditNoteRow,
  supplierCreditNoteNumber,
} from './credit-note'
import { compareCreditToInvoice, creditAmount, creditNoteFromReading } from './credit-target'

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
  vat_treatment, reverse_charge, remaining_amount,
  registration_journal_entry_id, payment_journal_entry_id, paid_at, paid_amount,
  is_credit_note, credited_invoice_id, arrival_number, default_dimensions,
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
  const supplier = pickSupplier(original.supplier)
  const originalItems = original.items ?? []

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
  const creditNumber = supplierCreditNoteNumber(
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

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod = ((settings as { accounting_method?: string } | null)?.accounting_method ??
    'accrual') as AccountingMethod
  // Kontantmetoden skips only while the original is still UNPAID: nothing
  // reached the ledger. A paid original was booked by its payment verifikat
  // (expense + 2641), and leaving that un-reversed overstates both.
  const postsEntry = supplierCreditNoteNeedsJournalEntry(accountingMethod, original)

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
          items: creditItemsFor('(new)', originalItems).map(({ supplier_invoice_id: _drop, ...rest }) => rest),
        },
        original_id: original.id,
        original_supplier_invoice_number: original.supplier_invoice_number,
        supplier_name: supplier?.name ?? null,
        credit_date: creditDate,
        date_source: dateSource,
        inbox_item_id: item?.id ?? null,
        original_will_become: 'credited',
        would_create_reversal_journal_entry: postsEntry,
      },
    }
  }

  const { data: arrivalNumber, error: arrivalError } = await supabase.rpc('get_next_arrival_number', {
    p_company_id: companyId,
  })
  if (arrivalError || arrivalNumber == null) {
    log.error('credit: arrival number allocation failed', (arrivalError as unknown as Error) ?? new Error('null'))
    return { ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'arrival_number' } }
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
      }),
    )
    .select()
    .single()
  if (insertError || !inserted) {
    log.error('credit: credit note insert failed', insertError as unknown as Error, { supplierInvoiceId })
    return {
      ok: false,
      code: 'SI_CREDIT_FAILED',
      details: { step: 'credit_note_insert', pg_code: (insertError as { code?: string } | null)?.code },
    }
  }
  const creditNote = inserted as SupplierInvoice

  if (originalItems.length > 0) {
    const { error: itemsError } = await supabase
      .from('supplier_invoice_items')
      .insert(creditItemsFor(creditNote.id, originalItems))
    if (itemsError) {
      await rollbackCreditNote(ctx, creditNote.id, 'items_insert', false)
      return {
        ok: false,
        code: 'SI_CREDIT_FAILED',
        details: { step: 'credit_items_insert', pg_code: (itemsError as { code?: string }).code },
      }
    }
  }

  let journalEntryId: string | null = null
  if (postsEntry) {
    try {
      // The ORIGINAL items: deferred lines carry their periodisering fields
      // there, so the credit reverses against the same 17xx interim account.
      const entry = await createSupplierCreditNoteEntry(
        supabase,
        companyId,
        userId,
        creditNote,
        originalItems,
        supplier?.supplier_type || 'swedish_business',
        supplier?.name ?? undefined,
      )
      if (!entry) {
        // No fiscal year covers the date: a credit without its verifikat
        // would leave reskontra and ledger apart, so nothing is kept.
        await rollbackCreditNote(ctx, creditNote.id, 'no_fiscal_period', false)
        return { ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry', reason: 'no_fiscal_period', credit_date: creditDate } }
      }
      journalEntryId = entry.id
    } catch (err) {
      // The engine threw: assume the entry may have committed.
      await rollbackCreditNote(ctx, creditNote.id, 'credit_journal_entry', true)
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREDIT_FAILED', error: err }
      log.error('credit: journal entry failed', err as Error, { supplierInvoiceId, creditNoteId: creditNote.id })
      return { ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry' } }
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
        await reverseEntry(supabase, companyId, userId, journalEntryId, creditDate)
      } catch (revErr) {
        log.error('credit: storno after link failure failed, manual reconciliation required', revErr as Error, {
          journalEntryId,
        })
      }
      await rollbackCreditNote(ctx, creditNote.id, 'je_link_failed', true)
      return { ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry_link' } }
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
    return {
      ok: false,
      code: 'SI_CREDIT_FAILED',
      details: { step: 'original_status_flip', credit_note_id: creditNote.id, journal_entry_id: journalEntryId },
    }
  }
  if (!flipped) {
    log.warn('credit: race, the original was credited meanwhile; rolling back', {
      supplierInvoiceId,
      creditNoteId: creditNote.id,
    })
    if (journalEntryId) {
      try {
        await reverseEntry(supabase, companyId, userId, journalEntryId, creditDate)
      } catch (revErr) {
        log.error('credit: storno of the losing credit failed', revErr as Error, { journalEntryId })
      }
    }
    await rollbackCreditNote(ctx, creditNote.id, 'credit_race', journalEntryId !== null)
    return { ok: false, code: 'SI_CREDIT_ALREADY_CREDITED', details: { reason: 'race' } }
  }

  const warnings: OperationWarning[] = []

  // The document is the credit verifikat's underlag. The credit note row
  // already points at it; a failed link is a warning, never a failure.
  if (documentId && journalEntryId) {
    const { error: docLinkError } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: journalEntryId })
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
      document_id: documentId,
      inbox_item_id: item?.id ?? null,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
