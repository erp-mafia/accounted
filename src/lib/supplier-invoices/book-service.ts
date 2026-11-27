/**
 * The deferred "Bokför" step for supplier invoices (#967), one implementation
 * behind every door: the dashboard route POST /api/supplier-invoices/[id]/book,
 * the v1 operation supplier-invoices.book and its MCP tool
 * (lib/operations/invoice-booking.ts), and every settlement of a still
 * unbooked invoice, which books it here first (registration-first.ts).
 *
 * Companies with company_settings.defer_invoice_booking=true register
 * supplier invoices without a verifikat; ekonomi books the registration entry
 * here once the kontering is verified.
 *
 * Rules, in order:
 *   - the invoice exists in the company, is not a credit note and is not
 *     booked yet;
 *   - no registration verifikat booked from the invoice stands: one can,
 *     after its storno was deleted (standing-registration.ts), and the
 *     invoice is then handed back to it instead of being booked again;
 *   - status registered, approved or overdue. A settlement never reaches an
 *     unbooked invoice of a deferring company first: every door that settles
 *     one books its registration through this function beforehand
 *     (registration-first.ts). So a paid or partially paid invoice without
 *     a registration is either a kontantmetoden payment that booked the
 *     whole invoice (a later switch to faktureringsmetoden would double-post
 *     it here) or a payment made before that rule (2026-10-16) that booked
 *     only the 2440 clearing, which needs a rättelse, not this step;
 *   - faktureringsmetoden: under kontantmetoden the invoice books at payment;
 *   - the invoice date is not in a locked or closed period, nor on or before
 *     the company lock date (PERIOD_LOCKED, checked before anything is
 *     generated);
 *   - an open fiscal year covers the invoice date;
 *   - every month-end an upplupen kostnad (29xx line) books on can take its
 *     entry (SI_ACCRUED_COST_PERIOD_LOCKED from the registration builder,
 *     dry run included).
 *
 * A dry run reads, checks and previews the lines the generator would post,
 * and writes nothing.
 */
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  ACCRUAL_RELEASE_FAILED_WARNING,
  createSchedulesForSupplierInvoice,
} from '@/lib/bookkeeping/accruals/from-invoices'
import { supplierInvoiceRegistrationDate } from '@/lib/bookkeeping/booking-mode'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import {
  buildSupplierInvoiceRegistrationEntryInput,
  createSupplierInvoiceRegistrationEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { findStandingRegistration } from '@/lib/supplier-invoices/standing-registration'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

// Statuses where the registration entry can still be created afterwards.
// Paid and partially paid invoices are excluded: a payment that reached one
// without a registration booked either the whole invoice (kontantmetoden,
// before a switch of method), which this step would double-post, or only the
// 2440 clearing (a deferring company's payment before registration-first.ts),
// which is corrected by a rättelse. Every settlement door now books the
// registration first, through bookSupplierInvoice, while the invoice is still
// in one of these statuses.
export const SUPPLIER_INVOICE_BOOKABLE_STATUSES = ['registered', 'approved', 'overdue']

const ACCRUAL_PARTIAL: OperationWarning = {
  code: 'ACCRUAL_SCHEDULE_FAILED',
  message_sv:
    'Fakturan bokfördes, men en eller flera periodiseringar kunde inte ' +
    'skapas. Kontrollera under Bokföring → Periodiseringar.',
  message_en:
    'The invoice was booked, but one or more accrual schedules (periodiseringar) could not be created. Check Bokföring > Periodiseringar.',
}

const ACCRUAL_FAILED: OperationWarning = {
  code: 'ACCRUAL_SCHEDULE_FAILED',
  message_sv:
    'Fakturan bokfördes, men periodiseringarna kunde inte skapas. ' +
    'Kontrollera under Bokföring → Periodiseringar.',
  message_en:
    'The invoice was booked, but its accrual schedules (periodiseringar) could not be created. Check Bokföring > Periodiseringar.',
}

export interface BookSupplierInvoiceResult {
  /** The supplier invoice row as the CAS-guarded link returned it. */
  supplier_invoice: SupplierInvoice
  journal_entry_id: string
}

type SupplierInvoiceWithJoins = SupplierInvoice & {
  items?: SupplierInvoiceItem[] | null
  supplier?: { id: string; name?: string | null; supplier_type?: string | null } | null
}

export async function bookSupplierInvoice(
  ctx: OperationContext,
  supplierInvoiceId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookSupplierInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: row } = await supabase
    .from('supplier_invoices')
    .select('*, items:supplier_invoice_items(*), supplier:suppliers(id, name, supplier_type)')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .single()
  const invoice = row as SupplierInvoiceWithJoins | null

  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  if (invoice.registration_journal_entry_id) return { ok: false, code: 'SI_BOOK_ALREADY_BOOKED' }
  if (invoice.is_credit_note) return { ok: false, code: 'SI_BOOK_NOT_BOOKABLE' }
  if (!SUPPLIER_INVOICE_BOOKABLE_STATUSES.includes(invoice.status)) {
    return { ok: false, code: 'SI_BOOK_INVALID_STATUS', details: { currentStatus: invoice.status } }
  }

  // A registration booked from this invoice can stand while the invoice
  // names none (standing-registration.ts). The invoice takes that verifikat
  // back instead of being booked a second time. A failed read aborts: booking
  // without the answer could post the registration twice.
  let standing: { id: string } | null
  try {
    standing = await findStandingRegistration(supabase, companyId, supplierInvoiceId)
  } catch (err) {
    log.error('failed to look for a standing registration before booking', err as Error, {
      invoiceId: supplierInvoiceId,
    })
    return { ok: false, code: 'SI_BOOK_FAILED' }
  }
  if (standing) {
    if (!options.dryRun) {
      const { error: relinkError } = await supabase
        .from('supplier_invoices')
        .update({ registration_journal_entry_id: standing.id })
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .is('registration_journal_entry_id', null)
      if (relinkError) {
        log.error('failed to hand the invoice back to its standing registration', relinkError, {
          invoiceId: supplierInvoiceId,
          journalEntryId: standing.id,
        })
        return { ok: false, code: 'SI_BOOK_FAILED' }
      }
    }
    return { ok: false, code: 'SI_BOOK_ALREADY_BOOKED' }
  }

  // The registration entry is a faktureringsmetoden concept; under
  // kontantmetoden the invoice is booked in full when it is paid.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()
  // Fail closed: booking with guessed settings could apply the wrong
  // method's rules, so a failed/missing settings read aborts.
  if (settingsError || !settings) {
    log.error('failed to load company settings for deferred booking', settingsError ?? undefined, {
      invoiceId: supplierInvoiceId,
    })
    return { ok: false, code: 'SI_BOOK_FAILED' }
  }
  if ((settings.accounting_method || 'accrual') !== 'accrual') {
    return { ok: false, code: 'SI_BOOK_CASH_METHOD' }
  }

  const items = (invoice.items ?? []) as SupplierInvoiceItem[]
  const supplierType = invoice.supplier?.supplier_type || 'company'

  // The date the registration builder dates the verifikat on: the invoice
  // date, or for an EU goods acquisition at the latest the 15th of the month
  // after its delivery (ML 7 kap. 26 §).
  const registrationDate = supplierInvoiceRegistrationDate(invoice, supplierType)
  const verdict = await checkPeriodLock(supabase, companyId, registrationDate)
  if (verdict.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: verdict.reason,
        ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
        invoice_date: invoice.invoice_date,
        ...(registrationDate !== invoice.invoice_date ? { entry_date: registrationDate } : {}),
      },
    }
  }

  const supplierName = invoice.supplier?.name ?? undefined
  const noPeriod: Failure = {
    ok: false,
    code: 'SI_BOOK_NO_FISCAL_PERIOD',
    details: { invoiceDate: invoice.invoice_date },
  }
  const generatorFailure = (err: unknown): Failure => {
    if (isBookkeepingError(err)) return { ok: false, code: 'SI_BOOK_FAILED', error: err }
    log.error('deferred registration booking failed', err as Error, { invoiceId: supplierInvoiceId })
    return { ok: false, code: 'SI_BOOK_FAILED' }
  }

  if (options.dryRun) {
    try {
      const input = await buildSupplierInvoiceRegistrationEntryInput(
        supabase,
        companyId,
        invoice,
        items,
        supplierType,
        supplierName,
      )
      if (!input) return noPeriod
      return {
        ok: true,
        dryRun: true,
        preview: {
          supplier_invoice_id: invoice.id,
          arrival_number: invoice.arrival_number ?? null,
          supplier_invoice_number: invoice.supplier_invoice_number ?? null,
          // Which invoice this is, for the approver: four staged Bokför
          // operations used to read the same (feedback seq 930807).
          supplier_name: supplierName ?? null,
          total: invoice.total,
          currency: invoice.currency,
          status: invoice.status,
          journal_entry: toEntryPreview(input),
          creates_accrual_schedules: items.some((item) => item.accrual_period_start && item.accrual_period_end),
        },
      }
    } catch (err) {
      return generatorFailure(err)
    }
  }

  let journalEntry
  try {
    journalEntry = await createSupplierInvoiceRegistrationEntry(
      supabase,
      companyId,
      userId,
      invoice,
      items,
      supplierType,
      supplierName,
      // The posting port's event, while POSTING_EVENTS is on: the person (or
      // the approved operation) booked the registration.
      () => ({ linkBasis: linkBasisColumns('user_created') }),
    )
  } catch (err) {
    return generatorFailure(err)
  }

  // Returns null ONLY when no fiscal period covers invoice_date (other
  // failures throw). Nothing was posted, so a plain error is safe.
  if (!journalEntry) return noPeriod

  // CAS-guarded link: only claim the invoice if it is still unbooked AND
  // still in a bookable status. A concurrent book/mark-paid/credit that got
  // there first would otherwise leave this entry double-posting 2440 +
  // ingående moms (mark-paid moves to paid without touching the
  // registration link), so cancel it.
  const { data: linked, error: linkError } = await supabase
    .from('supplier_invoices')
    .update({ registration_journal_entry_id: journalEntry.id })
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .is('registration_journal_entry_id', null)
    .in('status', SUPPLIER_INVOICE_BOOKABLE_STATUSES)
    .select()
    .single()

  if (linkError || !linked) {
    await cancelOrphanedPaymentEntry(
      supabase,
      companyId,
      userId,
      journalEntry.id,
      'Bokföring av leverantörsfaktura avbröts: fakturan bokfördes samtidigt av en annan begäran.',
    )
    return { ok: false, code: 'SI_BOOK_CONFLICT' }
  }

  // The invoice's retained source document (attached at registration) has
  // been floating until now: the deferred flow books later, and every
  // missing-underlag surface only accepts an ANCHORED doc
  // (document_attachments.journal_entry_id set). Anchor it to the fresh
  // registration verifikat, same as the create route does when it books
  // immediately. Never throws; a no-op when the invoice has no document.
  await anchorSupplierInvoiceDocument(supabase, companyId, supplierInvoiceId)

  // Periodiseringar ride on the registration entry, so they can only be
  // created now. Non-blocking: the entry is committed (immutable); a
  // schedule failure is surfaced as a warning and retried from the
  // periodiseringar page.
  const warnings: OperationWarning[] = []
  const hasAccrualItems = items.some((item) => item.accrual_period_start && item.accrual_period_end)
  if (hasAccrualItems) {
    try {
      const scheduleResult = await createSchedulesForSupplierInvoice(
        supabase,
        companyId,
        userId,
        invoice,
        items,
        journalEntry.id,
      )
      if (scheduleResult.failed > 0) warnings.push(ACCRUAL_PARTIAL)
      if ((scheduleResult.releasesFailed ?? 0) > 0) warnings.push({ ...ACCRUAL_RELEASE_FAILED_WARNING })
    } catch (err) {
      log.error('accrual schedule creation failed on deferred booking', err as Error, {
        invoiceId: supplierInvoiceId,
      })
      warnings.push(ACCRUAL_FAILED)
    }
  }

  return {
    ok: true,
    data: { supplier_invoice: linked as SupplierInvoice, journal_entry_id: journalEntry.id },
    warnings,
  }
}
