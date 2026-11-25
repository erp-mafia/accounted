/**
 * Kvittning: set off a customer invoice against a supplier invoice of the same
 * counterparty, the one service every door calls (the dashboard routes, the
 * v1 operation and the staged MCP tool).
 *
 * The booking itself is one SQL transaction, book_counterparty_setoff
 * (migration 20261022130100), reached through its engine door
 * (commitCounterpartySetoff) by the posting port's commitSqlPosting: the
 * verifikat (Dr 244x / Cr 151x, and 3740 for an öresavrundning the set-off
 * absorbs), both invoices' remaining amounts, a payment
 * row on each side and the set-off row. This module plans and previews,
 * refuses what it can before the database is asked, records the posting
 * port's event, and after the commit does the best-effort rest: the
 * kvittningsavräkning archived as underlag, the paid events, the stale match
 * suggestions and a befarad kundförlust reserve the payment made unnecessary.
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { oreRoundingLine } from '@/lib/bookkeeping/ore-rounding'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { emitInvoicePaidIfSettled, emitSupplierInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { postingPort } from '@/lib/posting/port'
import type { Invoice, SupplierInvoice } from '@/types'
import { counterpartySetoffBusinessEvent } from './business-event'
import type { SetoffErrorCode } from './errors'
import { setoffId } from './ids'
import { planSetoff, type SetoffPlan } from './plan'
import { countPairSetoffs, loadSetoffPair, type SetoffPairState } from './state'

export interface BookSetoffInput {
  invoiceId: string
  supplierInvoiceId: string
  /** In SEK; the smaller of the two remaining amounts when omitted. */
  amount?: number | null
  /** The verifikat date; today (Stockholm) when omitted. */
  setoffDate?: string | null
  /** The agreement or notice the set-off rests on, in a few words. */
  note?: string | null
  /**
   * The counterparty the approver saw (a staged operation pins it): refused
   * when the invoices no longer belong to it.
   */
  expectedPartyId?: string | null
}

export interface SetoffBooked {
  setoff_id: string
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  party_id: string
  amount: number
  setoff_date: string
  invoice: { invoice_id: string; status: string; remaining_amount: number }
  supplier_invoice: { supplier_invoice_id: string; status: string; remaining_amount: number }
  net: { direction: 'we_pay' | 'they_pay' | 'settled'; amount: number }
  underlag_document_id: string | null
}

/** What the RPC answers on success (book_counterparty_setoff). */
interface RpcBooked {
  ok: true
  setoff_id: string
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  party_id: string
  amount: number | string
  receivable_account: string
  payable_account: string
  invoice: { invoice_id: string; payment_id: string; status: string; paid_amount: number | string; remaining_amount: number | string }
  supplier_invoice: {
    supplier_invoice_id: string
    payment_id: string
    status: string
    paid_amount: number | string
    remaining_amount: number | string
  }
}

interface RpcRefused {
  ok: false
  code: SetoffErrorCode
  details?: Record<string, unknown>
}

/** The preview a dry run answers: what the set-off would book, in the v1 contract's words. */
export function setoffPreview(plan: SetoffPlan, state: Pick<SetoffPairState, 'customerName' | 'supplierName'>, note: string | null) {
  const receivable = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')
  const payable = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')
  return {
    party_id: plan.partyId,
    customer_name: state.customerName,
    supplier_name: state.supplierName,
    amount: plan.amount,
    setoff_date: plan.setoffDate,
    note,
    invoice: {
      invoice_id: plan.invoice.id,
      number: plan.invoice.number,
      remaining_before: plan.invoice.remainingBefore,
      remaining_after: plan.invoice.remainingAfter,
      status_after: plan.invoice.statusAfter,
      ore_rounding: plan.invoice.oreRounding,
    },
    supplier_invoice: {
      supplier_invoice_id: plan.supplierInvoice.id,
      number: plan.supplierInvoice.number,
      arrival_number: plan.supplierInvoice.arrivalNumber,
      remaining_before: plan.supplierInvoice.remainingBefore,
      remaining_after: plan.supplierInvoice.remainingAfter,
      status_after: plan.supplierInvoice.statusAfter,
    },
    net: plan.net,
    // The standard accounts; the booking uses the accounts the invoices' own
    // vouchers booked, which are these unless the company booked others.
    lines: [
      { account_number: payable, debit_amount: plan.amount, credit_amount: 0 },
      // 151x takes the amount and the 3740 line's other side: the whole
      // remaining amount when the set-off absorbs öresavrundning, and all 151x
      // carries when the issue verifikat booked the öre itself (crm#2283).
      { account_number: receivable, debit_amount: 0, credit_amount: roundOre(plan.amount + plan.invoice.oreRounding) },
      ...(plan.invoice.oreRounding !== 0 ? [oreLine(plan.invoice.oreRounding)] : []),
    ],
  }
}

function oreLine(residual: number) {
  const { account_number, debit_amount, credit_amount } = oreRoundingLine(residual, 'customer')
  return { account_number, debit_amount, credit_amount }
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505'
}

/**
 * Plan, and for a real run book, a set-off. A dry run reads only and answers
 * the preview; a real run answers SetoffBooked once the verifikat is posted.
 * The caller checks COUNTERPARTY_SETOFF_ENABLED.
 */
export async function bookCounterpartySetoff(
  ctx: OperationContext,
  input: BookSetoffInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<SetoffBooked>> {
  const { supabase, companyId, userId, log } = ctx
  const loaded = await loadSetoffPair(supabase, companyId, input.invoiceId, input.supplierInvoiceId)
  if (!loaded.ok) return { ok: false, code: loaded.code }
  const { state } = loaded

  const today = todayIsoStockholm()
  const setoffDate = input.setoffDate ?? today
  const planned = planSetoff({
    invoice: state.invoice,
    supplierInvoice: state.supplierInvoice,
    amount: input.amount,
    setoffDate,
    today,
  })
  if (!planned.ok) return { ok: false, code: planned.code, details: planned.details }
  const { plan } = planned
  if (input.expectedPartyId && input.expectedPartyId !== plan.partyId) {
    return { ok: false, code: 'SETOFF_PARTY_MISMATCH', details: { expected_party_id: input.expectedPartyId } }
  }

  const lock = await checkPeriodLock(supabase, companyId, setoffDate)
  if (lock.locked) {
    return { ok: false, code: 'SETOFF_PERIOD_LOCKED', details: { setoff_date: setoffDate, reason: lock.reason } }
  }
  if (lock.reason === 'no_fiscal_period') {
    return { ok: false, code: 'SETOFF_NO_FISCAL_PERIOD', details: { setoff_date: setoffDate } }
  }

  const note = input.note?.trim() ? input.note.trim() : null
  if (options.dryRun) return { ok: true, dryRun: true, preview: setoffPreview(plan, state, note) }

  const id = await setoffId(plan.invoice.id, plan.supplierInvoice.id, await countPairSetoffs(supabase, companyId, plan.invoice.id, plan.supplierInvoice.id))

  // The posting port (its SQL step): the set-off's one event, linked to the
  // verifikat before its number is drawn. Off: nothing is built.
  let businessEvents: SqlBusinessEventLink | undefined
  try {
    businessEvents = await postingPort.recordEventsForSql({
      supabase,
      companyId,
      events: () => [counterpartySetoffBusinessEvent(plan, linkBasisColumns('user_created'))],
    })
  } catch (err) {
    // strict: an event that could not be recorded stops the booking before any number.
    log.error('counterparty set-off: business event not recorded (strict)', err as Error)
    return { ok: false, code: 'SETOFF_BOOKING_FAILED' }
  }

  const { data, error } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'book_counterparty_setoff',
    args: [
      {
        setoffId: id,
        invoiceId: plan.invoice.id,
        supplierInvoiceId: plan.supplierInvoice.id,
        amount: plan.amount,
        setoffDate: plan.setoffDate,
        note,
        ...(businessEvents ? { businessEvents } : {}),
      },
    ],
  })
  if (error) {
    // The live-voucher index or the set-off row's key: another booking of the
    // same set-off got there first.
    if (isUniqueViolation(error)) return { ok: false, code: 'SETOFF_RACE' }
    log.error('book_counterparty_setoff RPC error', new Error(error.message), { invoiceId: plan.invoice.id, supplierInvoiceId: plan.supplierInvoice.id })
    return { ok: false, code: 'SETOFF_BOOKING_FAILED' }
  }
  const result = data as RpcBooked | RpcRefused | null
  if (!result) return { ok: false, code: 'SETOFF_BOOKING_FAILED' }
  if (!result.ok) return { ok: false, code: result.code, details: result.details }

  const warnings: OperationWarning[] = []
  const underlagId = await archiveSetoffNote(ctx, { plan, state, result, note })
  if (!underlagId) {
    warnings.push({
      code: 'SETOFF_UNDERLAG_NOT_ARCHIVED',
      message_sv: 'Kvittningen är bokförd men kvittningsavräkningen kunde inte arkiveras på verifikatet. Bifoga den eller avtalet manuellt.',
      message_en: 'The set-off is booked but the set-off note could not be archived on the voucher. Attach it or the agreement by hand.',
    })
  }
  await afterSetoffBooked(ctx, { plan, result })

  return {
    ok: true,
    data: {
      setoff_id: result.setoff_id,
      journal_entry_id: result.journal_entry_id,
      voucher_series: result.voucher_series,
      voucher_number: result.voucher_number,
      party_id: result.party_id,
      amount: Number(result.amount),
      setoff_date: plan.setoffDate,
      invoice: {
        invoice_id: result.invoice.invoice_id,
        status: result.invoice.status,
        remaining_amount: Number(result.invoice.remaining_amount),
      },
      supplier_invoice: {
        supplier_invoice_id: result.supplier_invoice.supplier_invoice_id,
        status: result.supplier_invoice.status,
        remaining_amount: Number(result.supplier_invoice.remaining_amount),
      },
      net: plan.net,
      underlag_document_id: underlagId,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Archive the kvittningsavräkning on the committed verifikat. Never throws: a
 * missing note is a warning, the verifikat already refers to both invoices.
 */
async function archiveSetoffNote(
  ctx: OperationContext,
  args: { plan: SetoffPlan; state: SetoffPairState; result: RpcBooked; note: string | null },
): Promise<string | null> {
  const { plan, state, result } = args
  try {
    const [settingsRes, partyRes] = await Promise.all([
      ctx.supabase.from('company_settings').select('company_name, org_number').eq('company_id', ctx.companyId).maybeSingle(),
      ctx.supabase.from('parties').select('display_name, legal_name, org_number').eq('company_id', ctx.companyId).eq('id', plan.partyId).maybeSingle(),
    ])
    const company = (settingsRes.data ?? {}) as { company_name?: string | null; org_number?: string | null }
    const party = (partyRes.data ?? {}) as { display_name?: string | null; legal_name?: string | null; org_number?: string | null }
    const voucherLabel = result.voucher_series && result.voucher_number ? formatVoucher(result) : null
    // Loaded here, not at the top: react-pdf stays out of every module that
    // reaches this service (the operation registry among them) until a note
    // is rendered.
    const { renderSetoffNote, setoffNoteFilename } = await import('./note-pdf')
    const pdf = await renderSetoffNote({
      companyName: company.company_name ?? null,
      companyOrgNumber: company.org_number ?? null,
      counterpartyName: party.legal_name ?? party.display_name ?? state.customerName ?? state.supplierName,
      counterpartyOrgNumber: party.org_number ?? null,
      setoffDate: plan.setoffDate,
      voucherLabel,
      amount: plan.amount,
      oreRounding: plan.invoice.oreRounding,
      invoice: {
        number: plan.invoice.number,
        invoiceDate: state.invoice.invoiceDate,
        total: state.invoice.total,
        remainingBefore: plan.invoice.remainingBefore,
        remainingAfter: plan.invoice.remainingAfter,
      },
      supplierInvoice: {
        number: plan.supplierInvoice.number,
        arrivalNumber: plan.supplierInvoice.arrivalNumber,
        invoiceDate: state.supplierInvoice.invoiceDate,
        total: state.supplierInvoice.total,
        remainingBefore: plan.supplierInvoice.remainingBefore,
        remainingAfter: plan.supplierInvoice.remainingAfter,
      },
      net: plan.net,
      receivableAccount: result.receivable_account,
      payableAccount: result.payable_account,
      note: args.note,
      generatedAt: todayIsoStockholm(),
    })
    const document = await uploadDocument(
      ctx.supabase,
      ctx.userId,
      ctx.companyId,
      {
        name: setoffNoteFilename(plan.setoffDate, plan.invoice.number),
        buffer: new Uint8Array(pdf).buffer as ArrayBuffer,
        type: 'application/pdf',
      },
      // The set-off's own note on the set-off's own verifikat.
      {
        upload_source: 'system',
        journal_entry_id: result.journal_entry_id,
        linkBasis: linkBasisColumns('system_derived'),
        extractionOwner: 'none',
      },
    )
    return document.id
  } catch (err) {
    ctx.log.error('failed to archive the set-off note', err as Error, { journalEntryId: result.journal_entry_id })
    return null
  }
}

/** What follows a payment, for each side the set-off settled. Best-effort: the set-off has committed. */
async function afterSetoffBooked(ctx: OperationContext, args: { plan: SetoffPlan; result: RpcBooked }): Promise<void> {
  const { supabase, companyId, userId, log } = ctx
  const { plan, result } = args
  try {
    const [invoiceRes, supplierRes] = await Promise.all([
      supabase.from('invoices').select('*').eq('company_id', companyId).eq('id', plan.invoice.id).maybeSingle(),
      supabase.from('supplier_invoices').select('*').eq('company_id', companyId).eq('id', plan.supplierInvoice.id).maybeSingle(),
    ])
    if (invoiceRes.data) {
      await emitInvoicePaidIfSettled({
        newStatus: result.invoice.status,
        invoice: invoiceRes.data as Invoice,
        paymentAmount: plan.amount,
        paymentDate: plan.setoffDate,
        userId,
        companyId,
      })
    }
    if (supplierRes.data) {
      await emitSupplierInvoicePaidIfSettled({
        newStatus: result.supplier_invoice.status,
        supplierInvoice: supplierRes.data as SupplierInvoice,
        paymentAmount: plan.amount,
        userId,
        companyId,
      })
    }
    if (result.invoice.status === 'paid') {
      await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', plan.invoice.id)
    }
    if (result.supplier_invoice.status === 'paid') {
      await clearSettledInvoiceSuggestions(supabase, companyId, 'supplier_invoice', plan.supplierInvoice.id)
    }
  } catch (err) {
    log.warn('counterparty set-off: follow-up after booking failed', err as Error, { setoffId: result.setoff_id })
  }
  // A befarad kundförlust reserve the set-off made (partly) unnecessary.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId: plan.invoice.id,
    entryDate: plan.setoffDate,
    trigger: 'payment',
  })
}
