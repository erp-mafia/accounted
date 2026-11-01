import type { z } from 'zod'
import type { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { MATCHABLE_SUPPLIER_INVOICE_STATUSES, isMatchableSupplierInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { buildSupplierDescription, supplierInvoiceReference } from '@/lib/bookkeeping/supplier-invoice-description'
import {
  supplierInvoicePaymentBusinessEvent,
  type SupplierPaymentPostingContext,
} from '@/lib/bookkeeping/supplier-invoice-business-events'
import {
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { resolveSupplierPaymentSek, supplierPaymentSekInputIssue } from '@/lib/bookkeeping/supplier-payment-amounts'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { requireAccountingMethod } from '@/lib/company/accounting-method'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { planSupplierPayment } from '@/lib/invoices/apply-supplier-payment'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { findDuplicatePaymentCandidatesForSupplierInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import {
  recordSupplierInvoiceDuplicateGuardBypass,
  type DuplicateGuardBypassActor,
} from '@/lib/invoices/duplicate-guard-history'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitSupplierInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { futurePaymentDateRefusal } from '@/lib/invoices/payment-date'
import {
  recordSupplierInvoicePaymentRow,
  removeSupplierInvoicePaymentRow,
} from '@/lib/invoices/supplier-invoice-payment-row'
import { linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { findSignedBankPayment, signedBankPaymentDetails } from '@/lib/payments/orders/signed-payment'
import { postingPort } from '@/lib/posting/port'
import {
  bookRegistrationBeforeSettlement,
  planRegistrationBeforeSettlement,
  type RegistrationFirstPlan,
} from '@/lib/supplier-invoices/registration-first'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Supplier, SupplierInvoice, SupplierInvoiceItem } from '@/types'

/**
 * "Markera som betald" for a supplier invoice, the twin of settleInvoicePayment.
 * One definition behind the dashboard POST, its preview and the v1 POST, which
 * each held their own copy: the dashboard had no overpayment guard (1500 on a
 * remaining 1000 cleared 1500 off 2440 and pushed paid_amount past the total)
 * and took a credit note and a future date, v1 only warned when its payment row
 * failed and stornoed an orphan the dashboard cancelled.
 *
 * Two steps, as the registration-first and sale-first modules:
 *
 *   planSupplierSettlement   every refusal and every read, no write: a payable
 *     document, a date not ahead of today, no signed bank payment, an open
 *     period, the ledger plan (planSupplierPayment, the only payment math), the
 *     kontantmetoden refusals, the registration a deferring company books
 *     first, the SEK of a foreign payment, edited rows, the duplicate guard.
 *     The dry run of every door. A door that shows or refuses more (v1's
 *     stated-SEK rule, the preview's rows) reads the plan.
 *   bookSupplierSettlement   the write path, with one failure policy: the
 *     registration, the payment voucher, the payment row, the status under a
 *     compare-and-set, then the side effects. A voucher that ends up with no
 *     row or no status behind it is cancelled and its gap documented
 *     (cancelOrphanedPaymentEntry), so the ledger and the reskontra never part.
 *     The row goes in before the status so no invoice reaches paid without it:
 *     payment-sync, the bokslut and the Betalningar view all read it.
 *
 * A bank row is not paid through here: bookSupplierBankMatch is that door, and
 * it is the one door a signed bank payment does not stop, because the row IS
 * that payment.
 */

export type SupplierPaymentLine = CreateJournalEntryLineInput

/** The invoice as the door read it, with the relations the cash entry books from. */
export type SettleableSupplierInvoice = SupplierInvoice & {
  supplier?: Pick<Supplier, 'name' | 'supplier_type'> | null
  items?: SupplierInvoiceItem[] | null
}

export interface SupplierSettlementInput {
  /** In the invoice's currency. Omitted: all that is still owed. */
  amount?: number
  /** Omitted: today in Sweden. */
  paymentDate?: string
  /** The SEK that left the payment account, for a foreign invoice. */
  amountSek?: number
  /** Cleared SEK minus paid SEK, the alternative to amountSek. */
  exchangeRateDifference?: number
  /** The BAS account credited. Omitted: the company's primary bank account. */
  paymentAccount?: string
  /** The person's own rows instead of the generated verifikat. */
  lines?: SupplierPaymentLine[]
  notes?: string
  /** Book past the duplicate warning. Never past any other refusal. */
  force?: boolean
}

/** A mark-paid request body (MarkSupplierInvoicePaidSchema) as settlement input. */
export function supplierSettlementInput(body: z.infer<typeof MarkSupplierInvoicePaidSchema>): SupplierSettlementInput {
  return {
    amount: body.amount,
    paymentDate: body.payment_date,
    amountSek: body.amount_sek,
    exchangeRateDifference: body.exchange_rate_difference,
    paymentAccount: body.payment_account || undefined,
    lines: body.lines,
    notes: body.notes,
    force: body.force,
  }
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface SupplierSettlementPlan {
  invoice: SettleableSupplierInvoice
  input: SupplierSettlementInput
  paymentDate: string
  /** The debt this payment settles, in the invoice's currency. */
  paymentAmount: number
  /** The account a generated verifikat credits: the named one, else the primary bank account. */
  paymentAccount: string
  newPaidAmount: number
  newRemaining: number
  newStatus: 'paid' | 'partially_paid'
  paidAt: string | null
  accountingMethod: string
  invoiceAlreadyBooked: boolean
  /** Kontantmetoden on a never-booked invoice: the payment books the cost and the moms. */
  useCashEntry: boolean
  /** SEK off 2440 on the clearing path; the payment amount otherwise. */
  clearingSek: number
  exchangeRateDifference?: number
  registration: Extract<RegistrationFirstPlan, { ok: true }>
  /** The period of the edited rows; null without rows. */
  linesPeriodId: string | null
  /** The duplicate guard applied and the caller overrode it: the voucher records that. */
  overridesDuplicateGuard: boolean
  lastPaymentAccount: string | null
}

export interface SupplierSettlementResult {
  newStatus: 'paid' | 'partially_paid'
  newPaidAmount: number
  newRemaining: number
  paidAt: string | null
  journalEntryId: string
  /** The registration verifikat this payment booked first, else null. */
  registrationJournalEntryId: string | null
  warnings: OperationWarning[]
}

/** The document and its status: what makes an invoice payable at all. */
function payableRefusal(invoice: SettleableSupplierInvoice): Failure | null {
  if (invoice.is_credit_note) return { ok: false, code: 'SI_PAID_NOT_PAYABLE', details: { reason: 'credit_note' } }
  if (isMatchableSupplierInvoiceStatus(invoice.status)) return null
  const settled = ['paid', 'credited', 'reversed'].includes(invoice.status)
  return { ok: false, code: settled ? 'SI_PAID_ALREADY' : 'SI_PAID_NOT_PAYABLE', details: { current_status: invoice.status } }
}

function editedRowsRefusal(lines: SupplierPaymentLine[]): Failure | null {
  const { balanced, totalDebit, totalCredit } = lineBalance(lines)
  if (balanced) return null
  return { ok: false, code: 'INVOICE_PAID_LINES_UNBALANCED', details: { totalDebit, totalCredit } }
}

export async function planSupplierSettlement(
  ctx: OperationContext,
  invoice: SettleableSupplierInvoice,
  input: SupplierSettlementInput,
): Promise<{ ok: true; plan: SupplierSettlementPlan } | Failure> {
  const { supabase, companyId, log } = ctx
  const paymentDate = input.paymentDate || todayIsoStockholm()

  const futureDate = futurePaymentDateRefusal(paymentDate)
  if (futureDate) return { ok: false, ...futureDate }

  const notPayable = payableRefusal(invoice)
  if (notPayable) return notPayable

  // A bank payment signed for this invoice still executes: recording a payment
  // made another way beside it pays the supplier twice (crm#1243). No force:
  // the way out is cancelling that payment first.
  const signedBankPayment = await findSignedBankPayment(supabase, companyId, invoice.id)
  if (signedBankPayment) {
    return { ok: false, code: 'SI_BANK_PAYMENT_UNDER_WAY', details: signedBankPaymentDetails(signedBankPayment) }
  }

  const lock = await checkPeriodLock(supabase, companyId, paymentDate)
  if (lock.locked) {
    return {
      ok: false,
      code: 'SI_PAID_PERIOD_LOCKED',
      details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, payment_date: paymentDate },
    }
  }

  const sekInputIssue = supplierPaymentSekInputIssue({
    currency: invoice.currency,
    amountSek: input.amountSek,
    exchangeRateDifference: input.exchangeRateDifference,
    hasLines: !!input.lines,
  })
  if (sekInputIssue) return { ok: false, code: 'VALIDATION_ERROR', details: { ...sekInputIssue } }

  // In the invoice's currency, like remaining_amount and the payment row.
  const owed = invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
  const paymentAmount = roundOre(input.amount ?? owed)
  if (paymentAmount <= 0) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount', message: 'amount must be positive.' } }
  }

  const ledger = planSupplierPayment(invoice, paymentAmount)
  if (!ledger.ok) return { ok: false, code: ledger.code, details: ledger.details }
  const { newPaidAmount, newRemaining, newStatus, isFullyPaid } = ledger.plan

  // Fail closed (accounted#58): an unreadable method refuses instead of
  // clearing 2440 for a kontantmetod invoice that was never booked.
  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, last_supplier_payment_account')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod = requireAccountingMethod(settingsRead)

  // Route on the invoice's actual booking state, not the current setting: an
  // invoice booked at receipt (Dr cost + 2641 / Cr 2440) clears 2440 even after
  // a switch to kontantmetoden, or the debt orphans and the cost counts twice.
  const invoiceAlreadyBooked = !!invoice.registration_journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

  // The cash entry books the FULL invoice and takes no amount, so a partial or
  // a part-paid completion of a never-booked kontantmetoden invoice is refused
  // instead of over-booking the cost. Edited rows are not exempt: the dialog
  // pre-fills the same full-invoice shape.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod,
    priorPaidAmount: invoice.paid_amount,
    paysRemainingInFull: isFullyPaid,
  })
  if (cashBlock) {
    return {
      ok: false,
      code: 'SI_CASH_PARTIAL_UNSUPPORTED',
      details: { reason: cashBlock, payment_amount: paymentAmount, paid_amount: invoice.paid_amount, remaining_amount: owed },
    }
  }

  // Faktureringsmetoden with defer_invoice_booking: an invoice registered
  // without its verifikat is booked first by the Bokför step, then paid. A
  // refusal here refuses the payment before anything is written: never a 2440
  // clearing without the registration that credits it.
  const registration = await planRegistrationBeforeSettlement(ctx, invoice, { settlementDate: paymentDate })
  if (!registration.ok) return registration

  // The 2440 clearing books SEK: resolved from the ledger, never the
  // invoice-currency amount (#2955). Custom rows are SEK already and the cash
  // entry converts on its own.
  let clearingSek = paymentAmount
  let exchangeRateDifference = input.exchangeRateDifference
  if (!input.lines && !useCashEntry) {
    const sek = await resolveSupplierPaymentSek(supabase, companyId, invoice, {
      amount: paymentAmount,
      amountSek: input.amountSek,
      exchangeRateDifference: input.exchangeRateDifference,
      ...(registration.required ? { pendingRegistrationPayableSek: registration.payableSek } : {}),
    })
    if (!sek.ok) return { ok: false, code: sek.code, details: sek.details }
    clearingSek = sek.clearingSek
    exchangeRateDifference = sek.exchangeRateDifference
  }

  // Edited rows must balance and name accounts the engine can resolve, and the
  // payment date needs a fiscal period: all refused before the registration.
  let linesPeriodId: string | null = null
  if (input.lines) {
    const unbalanced = editedRowsRefusal(input.lines)
    if (unbalanced) return unbalanced
    const unresolvable = await findUnresolvableAccounts(supabase, companyId, input.lines.map((l) => l.account_number))
    if (unresolvable.length > 0) {
      const error = new AccountsNotInChartError(unresolvable)
      return { ok: false, code: error.code, error }
    }
    linesPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
    if (!linesPeriodId) {
      return { ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: { payment_date: paymentDate } }
    }
  }

  // Duplicate guard: last, so a warning never hides a refusal. A bank row that
  // already looks like this payment is surfaced before a new payment entry is
  // booked; a partial is an explicit, deliberate action and is not asked about.
  // match_reason `already_booked` is a row that is already a verifikat: the
  // remedy is a rättelse, not a link, and the UI words it that way.
  const force = input.force === true
  if (isFullyPaid && !force) {
    const candidates = await findDuplicatePaymentCandidatesForSupplierInvoice(supabase, {
      companyId,
      invoice: {
        supplier_invoice_number: invoice.supplier_invoice_number ?? null,
        payment_reference: invoice.payment_reference ?? null,
        supplier_name: invoice.supplier?.name,
        currency: invoice.currency ?? null,
        total: invoice.total ?? null,
        total_sek: invoice.total_sek ?? null,
        exchange_rate: invoice.exchange_rate ?? null,
      },
      // In the invoice's currency; the detector bands bank rows per currency.
      paymentAmount,
      paymentDate,
    })
    if (candidates.length > 0) return { ok: false, code: 'SI_PAID_LIKELY_DUPLICATE', details: { candidates } }
  }

  return {
    ok: true,
    plan: {
      invoice,
      input,
      paymentDate,
      paymentAmount,
      paymentAccount: input.paymentAccount ?? (await resolvePrimaryBankAccount(supabase, companyId, log)),
      newPaidAmount,
      newRemaining,
      newStatus,
      paidAt: isFullyPaid ? paidAtFromDate(paymentDate) : null,
      accountingMethod,
      invoiceAlreadyBooked,
      useCashEntry,
      clearingSek,
      exchangeRateDifference,
      registration,
      linesPeriodId,
      overridesDuplicateGuard: force && isFullyPaid,
      lastPaymentAccount: (settingsRead.data as { last_supplier_payment_account?: string | null } | null)?.last_supplier_payment_account ?? null,
    },
  }
}

export async function bookSupplierSettlement(
  ctx: OperationContext,
  plan: SupplierSettlementPlan,
  actor: DuplicateGuardBypassActor,
): Promise<({ ok: true } & SupplierSettlementResult) | Failure> {
  const { supabase, companyId, userId, log } = ctx
  const { invoice, input, paymentDate, paymentAmount, newPaidAmount, newRemaining, newStatus, paidAt } = plan

  // Every check has run: the registration (a no-op unless required), then the
  // payment against the 2440 it credits.
  const registration = await bookRegistrationBeforeSettlement(ctx, plan.registration)
  if (!registration.ok) return registration
  // A failure after the registration names it: that verifikat stands.
  const withRegistration = (details: Record<string, unknown>): Record<string, unknown> =>
    registration.bookedHere ? { ...details, registration_journal_entry_id: registration.journalEntryId } : details

  // The person (or, on an API key, the caller) states it is paid; the request
  // scope records client_asserted on a machine credential.
  const linkBasis: LinkBasisInput = { basis: 'user_created' }
  const posting = (): SupplierPaymentPostingContext => ({
    linkBasis: linkBasisColumnsFor(linkBasis),
    settledAmount: paymentAmount,
  })

  let journalEntryId: string | null = null
  try {
    journalEntryId = await postPaymentVoucher(ctx, plan, posting)
  } catch (err) {
    if (isBookkeepingError(err)) return { ok: false, code: 'SI_PAID_FAILED', error: err }
    log.error('failed to create payment journal entry', err as Error)
    return {
      ok: false,
      code: 'SI_PAID_FAILED',
      details: withRegistration({ reason: err instanceof Error ? getErrorMessage(err) : 'unknown' }),
    }
  }

  // Fail closed: every supplier payment posts a voucher. A helper that returned
  // null without throwing never flips the invoice: that would part the GL from
  // the AP sub-ledger.
  if (!journalEntryId) {
    log.error('supplier mark-paid produced no journal entry; refusing to mark paid', undefined)
    return { ok: false, code: 'SI_PAID_FAILED', details: withRegistration({ reason: 'no_journal_entry_created' }) }
  }

  const recorded = await recordSupplierInvoicePaymentRow(supabase, {
    userId,
    companyId,
    invoice,
    paymentDate,
    newPaidAmount,
    journalEntryId,
    exchangeRateDifference: plan.exchangeRateDifference,
    notes: input.notes,
    linkBasis,
  })
  if (!recorded.ok) {
    log.error('failed to record supplier_invoice_payments row: cancelling the voucher', undefined, { reason: recorded.error })
    await cancelOrphanedPaymentEntry(
      supabase, companyId, userId, journalEntryId,
      'Automatiskt makulerad: betalningspost kunde inte registreras',
    )
    return { ok: false, code: 'SI_PAID_FAILED', details: withRegistration({ reason: 'payment_record_insert_failed' }) }
  }

  // Only if the status is still payable and nothing was paid since the plan
  // read the invoice: a concurrent settle, part payment or credit loses here,
  // never after it. payment_order rows the insert settled follow the row's
  // delete (unsettle_payment_order_on_supplier_payment_delete).
  const { data: updated, error: updateError } = await supabase
    .from('supplier_invoices')
    .update({
      status: newStatus,
      remaining_amount: newRemaining,
      paid_amount: newPaidAmount,
      paid_at: paidAt,
      payment_journal_entry_id: journalEntryId,
    })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
    .eq('paid_amount', invoice.paid_amount)
    .select('id')

  if (updateError || !updated || updated.length === 0) {
    if (updateError) log.error('supplier invoice update failed', updateError)
    await cancelOrphanedPaymentEntry(
      supabase, companyId, userId, journalEntryId,
      updateError
        ? 'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning'
        : 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
    )
    await removeSupplierInvoicePaymentRow(supabase, companyId, recorded.id)
    return updateError
      ? { ok: false, code: 'SI_PAID_FAILED', details: withRegistration({ reason: 'si_update_failed' }) }
      : { ok: false, code: 'SI_PAID_ALREADY', details: withRegistration({ reason: 'race' }) }
  }

  // Warned about a possible double payment and booked anyway: the books record
  // it, naming the voucher (BFNAR 2013:2 p. 9.16). After the voucher exists and
  // never throws: the payment is already immutable.
  if (plan.overridesDuplicateGuard) {
    log.warn('duplicate-payment guard bypassed', { reason: 'force=true', paymentAmount, paymentDate })
    await recordSupplierInvoiceDuplicateGuardBypass(supabase, {
      companyId,
      invoice: {
        id: invoice.id,
        supplier_invoice_number: invoice.supplier_invoice_number ?? null,
        payment_reference: invoice.payment_reference ?? null,
        supplier_name: invoice.supplier?.name,
        currency: invoice.currency ?? null,
        total: invoice.total ?? null,
        total_sek: invoice.total_sek ?? null,
        exchange_rate: invoice.exchange_rate ?? null,
      },
      paymentAmount,
      paymentDate,
      paymentAccount: input.paymentAccount ?? null,
      journalEntryId,
      actor,
    })
  }

  // Fully settled: retire every transaction's suggestion pointer at this
  // invoice (issue #1259). This flow is not driven by a bank transaction, so
  // any pointer at it is now dead.
  if (newStatus === 'paid') {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'supplier_invoice', invoice.id)
  }

  // The kontantmetoden cash entry is the ONLY booking of the affärshändelse, so
  // its underlag hangs on THIS verifikat (BFL 5 kap 6 §); under
  // faktureringsmetoden the document normally sits on the registration already
  // and this is a no-op. Never throws: the payment is committed.
  await anchorSupplierInvoiceDocument(supabase, companyId, invoice.id)

  await emitSupplierInvoicePaidIfSettled({
    newStatus,
    supplierInvoice: {
      ...invoice,
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      paid_at: paidAt ?? invoice.paid_at,
    },
    paymentAmount,
    companyId,
    userId,
  })

  return {
    ok: true,
    newStatus,
    newPaidAmount,
    newRemaining,
    paidAt,
    journalEntryId,
    registrationJournalEntryId: registration.bookedHere ? registration.journalEntryId : null,
    warnings: registration.warnings,
  }
}

/** The payment voucher: the person's rows, the cash entry, or the 2440 clearing. */
async function postPaymentVoucher(
  ctx: OperationContext,
  plan: SupplierSettlementPlan,
  posting: () => SupplierPaymentPostingContext,
): Promise<string | null> {
  const { supabase, companyId, userId } = ctx
  const { invoice, input, paymentDate, useCashEntry } = plan

  if (input.lines && plan.linesPeriodId) {
    const entryInput: CreateJournalEntryInput = {
      fiscal_period_id: plan.linesPeriodId,
      entry_date: paymentDate,
      description: buildSupplierDescription(
        'Utbetalning leverantörsfaktura',
        supplierInvoiceReference(invoice.supplier_invoice_number, invoice.arrival_number),
        invoice.supplier?.name || undefined,
      ),
      source_type: useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid',
      source_id: invoice.id,
      lines: input.lines,
    }
    const entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () =>
        supplierInvoicePaymentBusinessEvent(
          invoice,
          entryInput,
          { paymentAccount: input.paymentAccount, generated: false, bankLine: false },
          posting(),
        ),
      input: entryInput,
    })
    return entry?.id ?? null
  }

  if (useCashEntry) {
    const entry = await createSupplierInvoiceCashEntry(
      supabase, companyId, userId,
      invoice,
      invoice.items ?? [],
      paymentDate,
      invoice.supplier?.supplier_type || 'swedish_business',
      invoice.supplier?.name,
      plan.paymentAccount,
      // Foreign invoice: the SEK that left the account pins the entry to the
      // payment-date rate, as a bank match does.
      input.amountSek,
      undefined, // bankTransaction: no bank line on this door
      undefined, // bankFeeSek
      posting,
    )
    return entry?.id ?? null
  }

  const entry = await createSupplierInvoicePaymentEntry(
    supabase, companyId, userId,
    invoice,
    plan.clearingSek,
    paymentDate,
    plan.exchangeRateDifference,
    invoice.supplier?.name,
    plan.paymentAccount,
    undefined, // bankTransaction: no bank line on this door
    undefined, // bankFeeSek
    undefined, // sekClearingDebt
    posting,
  )
  return entry?.id ?? null
}
