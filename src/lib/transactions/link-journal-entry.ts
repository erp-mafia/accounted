/**
 * Link a bank transaction to an already-posted journal entry without creating
 * new bookkeeping. Optionally settle a customer invoice in the same call by
 * inserting an invoice_payments row pointing at the existing JE and flipping
 * the invoice status with an optimistic-lock pattern.
 *
 * One implementation behind the dashboard route
 * (app/api/transactions/[id]/link-journal-entry/route.ts: the duplicate-
 * payment UI, where the user confirms the suggested existing voucher) and
 * the operation transactions.link-journal-entry (lib/operations/
 * transactions.ts), which serves v1, the MCP tool
 * gnubok_link_transaction_to_journal_entry and its approval. The bank side
 * of the link (which pairs may link, and the locked pointer write) is the
 * bank link core in lib/transactions/bank-link.ts, shared with the
 * reconciliation page's manualLink.
 *
 * NEVER creates a new journal entry. The match log records
 * 'linked_to_existing_voucher' for audit on success.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { roundOre } from '@/lib/money'
import { recordInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import {
  hasLiveJournalEntryLink,
  prepareBankLink,
  writeBankLink,
  type PreparedBankLink,
} from '@/lib/transactions/bank-link'
import { createLogger } from '@/lib/logger'
import { conflictCode } from '@/lib/errors/structured-errors'
import type { Invoice, Transaction } from '@/types'
import { isMatchableInvoiceStatus, MATCHABLE_INVOICE_STATUSES } from '@/lib/invoices/matchable-statuses'

const log = createLogger('transactions/link-journal-entry')

// Codes returned by linkTransactionToJournalEntry. All map to entries in
// lib/errors/structured-errors.ts so every door (the dashboard route, the
// operation) can surface the right HTTP status and the localized message.
// The TX-not-found case reuses the shared TX_CATEGORIZE_TX_NOT_FOUND code
// rather than a link-specific one: it predates this route and is the
// canonical "bank tx not found in this company" envelope.
export type LinkTransactionJournalEntryErrorCode =
  | ReturnType<typeof conflictCode>
  | 'TX_CATEGORIZE_TX_NOT_FOUND'
  | 'LINK_TX_TX_ALREADY_LINKED'
  | 'LINK_TX_TX_IGNORED'
  | 'BANK_ANCHOR_SETTLEMENT_CHANGED'
  | 'LINK_TX_JE_NOT_FOUND'
  | 'LINK_TX_JE_NOT_POSTED'
  | 'LINK_TX_INVOICE_NOT_FOUND'
  | 'LINK_TX_INVOICE_NOT_OPEN'
  | 'LINK_TX_INVOICE_CREDIT_NOTE'
  | 'LINK_TX_INVOICE_CURRENCY_MISMATCH'
  | 'LINK_TX_INVOICE_RACE'
  | 'MATCH_INVOICE_RECORD_PAYMENT_FAILED'
  | 'BANK_BOOKING_CURRENCY_MISMATCH'
  | 'LINK_TX_DB_ERROR'

export interface LinkTransactionJournalEntryParams {
  transactionId: string
  journalEntryId: string
  invoiceId?: string
}

export interface LinkTransactionJournalEntryResult {
  transactionId: string
  journalEntryId: string
  voucherLabel: string
  invoiceId: string | null
  invoiceStatus: 'paid' | 'partially_paid' | null
  paidAmount: number | null
  remainingAmount: number | null
}

/**
 * What a dry run read on the way, so an approver can recognise the pair:
 * the row (its counterparty text, amount, currency, date), the verifikat's
 * date and the invoice number.
 */
export interface LinkTransactionJournalEntrySubject {
  transactionDescription: string | null
  transactionAmount: number
  transactionCurrency: string
  transactionDate: string
  voucherDate: string
  invoiceNumber: string | null
}

export type LinkTransactionJournalEntryOutcome =
  // dryRun: the result the link WOULD produce; nothing was written.
  | { ok: true; result: LinkTransactionJournalEntryResult; dryRun?: false }
  | { ok: true; result: LinkTransactionJournalEntryResult; dryRun: true; subject: LinkTransactionJournalEntrySubject }
  | { ok: false; code: LinkTransactionJournalEntryErrorCode; details?: Record<string, unknown> }

/**
 * Canonical verifikat-label format: `${series}-${number}` (e.g. "A-12").
 * Centralised so the MCP staging preview and the committed result can't
 * diverge: divergence is a BFL 5 kap 7§ traceability hazard because the
 * verifikationsserie label that ends up in the audit trail must match the
 * label the user saw at approval time.
 *
 * Fallbacks ('A' series, empty number) are defensive only; in practice a
 * posted verifikat always has both. Callers should never construct this
 * string inline: import this helper instead.
 */
export function formatVoucherLabel(
  voucherSeries: string | null | undefined,
  voucherNumber: number | string | null | undefined,
): string {
  const series = voucherSeries ?? 'A'
  const num = voucherNumber ?? ''
  return num === '' ? series : `${series}-${num}`
}

// The liveness predicate lives with the bank link core; re-exported for the
// re-booking guards that import it from here.
export { hasLiveJournalEntryLink }

/**
 * A refusal of the bank link core as this door's structured error code. The
 * core's checks are the reconciliation page's: a row the page refuses to
 * link (ignored, or a verifikat with no line on the row's bank account) is
 * refused here by name too, on the dry run and the approval alike, instead
 * of the database's bank-anchor guard answering at the write.
 */
function linkRefusal(
  prepared: Extract<PreparedBankLink, { ok: false }>,
): Extract<LinkTransactionJournalEntryOutcome, { ok: false }> {
  switch (prepared.code) {
    case 'TRANSACTION_NOT_FOUND':
      return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
    case 'TRANSACTION_ALREADY_LINKED':
      return {
        ok: false,
        code: 'LINK_TX_TX_ALREADY_LINKED',
        details: { existingJournalEntryId: prepared.existingJournalEntryId ?? null },
      }
    case 'TRANSACTION_IGNORED':
      return { ok: false, code: 'LINK_TX_TX_IGNORED' }
    case 'ENTRY_NOT_FOUND':
      return { ok: false, code: 'LINK_TX_JE_NOT_FOUND' }
    case 'ENTRY_NOT_POSTED':
    case 'ENTRY_REVERSED':
      return { ok: false, code: 'LINK_TX_JE_NOT_POSTED', details: { currentStatus: prepared.entryStatus ?? null } }
    case 'CURRENCY_MISMATCH':
      return { ok: false, code: 'BANK_BOOKING_CURRENCY_MISMATCH', details: { reason: prepared.error } }
    default:
      // NOT_SETTLED (and TRANSACTION_OTHER_ACCOUNT, which cannot happen on
      // the row's own account): the answer the bank-anchor guard gives the
      // same pair at the write.
      return { ok: false, code: 'BANK_ANCHOR_SETTLEMENT_CHANGED', details: { reason: prepared.error } }
  }
}

// Data minimization (GDPR Art.5(1)(c)): only the columns needed for the
// checks, the optimistic-lock invoice update, the invoice_payments insert,
// and the compensating-rollback path. No select('*').
const LINK_TX_COLUMNS =
  'id, date, amount, currency, exchange_rate, description, merchant_name, cash_account_id, journal_entry_id, invoice_id, is_business, is_ignored, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id'

export async function linkTransactionToJournalEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkTransactionJournalEntryParams,
  options: { dryRun?: boolean } = {},
): Promise<LinkTransactionJournalEntryOutcome> {
  const { transactionId, journalEntryId, invoiceId } = params

  // Every bank check is the bank link core's (lib/transactions/bank-link.ts),
  // the one manualLink runs for the reconciliation page.
  const prepared = await prepareBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    accountNumber: null,
    txColumns: LINK_TX_COLUMNS,
  })
  if (!prepared.ok) return linkRefusal(prepared)
  const transaction = prepared.tx as Record<string, unknown> & {
    date: string
    amount: number
    currency: string
    exchange_rate: number | null
  }
  const journalEntry = prepared.entry

  type FetchedInvoice = Pick<
    Invoice,
    | 'id'
    | 'status'
    | 'total'
    | 'paid_amount'
    | 'remaining_amount'
    | 'currency'
    | 'exchange_rate'
    | 'paid_at'
    | 'invoice_number'
    | 'credited_invoice_id'
  > & { customer?: { name?: string } | null }
  let invoice: FetchedInvoice | null = null
  let newPaidAmount = 0
  let newRemaining = 0
  let isFullyPaid = false
  let newStatus: 'paid' | 'partially_paid' = 'paid'

  if (invoiceId) {
    // Data minimization (GDPR Art.5(1)(c) / SOC 2 CC6.1): explicit column
    // list rather than select('*, customer:customers(name)'). Adding new
    // PII columns to invoices won't silently widen this fetch.
    const { data: invoiceRow, error: fetchInvError } = await supabase
      .from('invoices')
      .select(
        'id, status, total, paid_amount, remaining_amount, currency, exchange_rate, paid_at, invoice_number, credited_invoice_id, customer:customers(name)'
      )
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoiceRow) {
      return { ok: false, code: 'LINK_TX_INVOICE_NOT_FOUND' }
    }

    if (invoiceRow.credited_invoice_id) {
      return { ok: false, code: 'LINK_TX_INVOICE_CREDIT_NOTE' }
    }

    if (!isMatchableInvoiceStatus(invoiceRow.status as string)) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_NOT_OPEN',
        details: { currentStatus: invoiceRow.status as string },
      }
    }

    invoice = invoiceRow as unknown as FetchedInvoice

    // BFL 5 kap 2§ + currency-integrity guard: invoices.paid_amount and
    // remaining_amount are stored in the INVOICE'S currency. Mixing a
    // foreign-currency tx.amount into those columns silently corrupts the
    // ledger (a 230 SEK payment would record "230 USD paid" on a USD
    // invoice). This link path is for the same-currency case only;
    // cross-currency payments must go through /api/transactions/[id]/match-
    // invoice which routes through buildInvoicePaymentClearingLines and
    // posts the FX diff on 3960/7960. Reject here to keep the contract clear.
    if (transaction.currency !== invoice.currency) {
      return {
        ok: false,
        code: 'LINK_TX_INVOICE_CURRENCY_MISMATCH',
        details: {
          transactionCurrency: transaction.currency as string,
          invoiceCurrency: invoice.currency,
        },
      }
    }

    const paidAmount = transaction.amount as number
    newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
    const currentRemaining =
      invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
    newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
    isFullyPaid = newRemaining <= 0
    newStatus = isFullyPaid ? 'paid' : 'partially_paid'
  }

  // Dry run (the v1 ?dry_run=true door): every check above ran on the same
  // reads the commit uses; answer the projected result and write nothing.
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      result: {
        transactionId,
        journalEntryId,
        voucherLabel: formatVoucherLabel(
          journalEntry.voucher_series as string | null,
          journalEntry.voucher_number as number | null,
        ),
        invoiceId: invoiceId ?? null,
        invoiceStatus: invoice ? newStatus : null,
        paidAmount: invoice ? newPaidAmount : null,
        remainingAmount: invoice ? newRemaining : null,
      },
      subject: {
        transactionDescription:
          ((transaction.merchant_name as string | null) || (transaction.description as string | null)) ?? null,
        transactionAmount: transaction.amount as number,
        transactionCurrency: (transaction.currency as string | null) ?? 'SEK',
        transactionDate: transaction.date as string,
        voucherDate: journalEntry.entry_date as string,
        invoiceNumber: (invoice?.invoice_number as string | null | undefined) ?? null,
      },
    }
  }

  // Snapshot tx state so the compensating-rollback path can restore the row
  // if a subsequent step fails: otherwise a partial state would persist
  // (tx linked, invoice unchanged, no payment row).
  const priorTxState = {
    // null, or a stale 'reversed'-entry id we're clearing (validated not-live above)
    journal_entry_id: prepared.previousJournalEntryId,
    // A link to a voucher on a sibling ledger moved the row there.
    ...(prepared.repointCashAccountId ? { cash_account_id: transaction.cash_account_id } : {}),
    invoice_id: transaction.invoice_id,
    potential_invoice_id: transaction.potential_invoice_id,
    potential_supplier_invoice_id: transaction.potential_supplier_invoice_id,
    potential_rot_rut_payout_request_id: transaction.potential_rot_rut_payout_request_id ?? null,
    is_business: transaction.is_business,
  }

  const written = await writeBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    prepared,
    fields: {
      invoice_id: invoiceId ?? null,
      potential_invoice_id: null,
      potential_supplier_invoice_id: null,
      potential_rot_rut_payout_request_id: null,
    },
    // The caller named this verifikat for this row (the duplicate dialog, v1,
    // the MCP tool); the request scope says whether a person approved it.
    linkBasis: { basis: 'user_confirmed' },
  })
  if (!written.ok && !written.race) {
    const { error } = written
    return {
      ok: false,
      code: error.code === 'PT409' ? conflictCode(error.message) : 'LINK_TX_DB_ERROR',
      details: { reason: error.message },
    }
  }
  // CAS lost: a concurrent linker changed the pointer between the liveness
  // check and this write, so 0 rows matched. Fail BEFORE any invoice side
  // effects: otherwise we'd settle the invoice + insert an invoice_payments row
  // for a transaction we didn't actually link.
  if (!written.ok) {
    return {
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: prepared.previousJournalEntryId },
    }
  }

  async function rollbackTxLink(reason: string): Promise<void> {
    // SOC 2 PI1.3 (processing integrity): if a rollback itself fails, the
    // ledger ends up in a partial state: tx pointing at the existing
    // verifikat with no invoice_payments row, or the invoice row at an
    // intermediate paid_amount. We surface the rollback failure (IDs only,
    // no amounts or counterparty names) so a reconciliation job can
    // detect and repair the divergence. The original failure code still
    // goes back to the caller as the proximate cause.
    const { error: rollbackErr } = await supabase
      .from('transactions')
      .update(priorTxState)
      .eq('id', transactionId)
      .eq('company_id', companyId)
    if (rollbackErr) {
      log.warn('failed to roll back transaction link after subsequent step failed', {
        companyId,
        transactionId,
        journalEntryId,
        reason,
        rollbackError: rollbackErr.message,
      })
    }
  }

  const paidAt = invoice && isFullyPaid ? paidAtFromDate(transaction.date) : null

  if (invoice && invoiceId) {
    const { data: updatedRows, error: updateInvError } = await supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: paidAt,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .in('status', [...MATCHABLE_INVOICE_STATUSES])
      .select('id')

    if (updateInvError) {
      await rollbackTxLink('invoice update errored')
      return { ok: false, code: 'LINK_TX_DB_ERROR', details: { reason: updateInvError.message } }
    }

    if (!updatedRows || updatedRows.length === 0) {
      await rollbackTxLink('invoice optimistic lock returned 0 rows')
      return { ok: false, code: 'LINK_TX_INVOICE_RACE' }
    }

    // BFL 5 kap 2§ + ML 8 kap 21-23§: the payment row must record the rate
    // effective on the PAYMENT date, not the invoice-creation date. If
    // transaction.exchange_rate is null (SEK tx, no rate needed), leave the
    // payment row's rate null too: a downstream Riksbanken lookup can
    // populate it lazily if reporting needs it. Falling back to
    // invoice.exchange_rate would silently record the wrong (invoice-date)
    // rate, which corrupts the FX-diff figures in any later VAT or income
    // reporting.
    const paymentExchangeRate = transaction.exchange_rate ?? null

    // The AR sub-ledger row goes through the single writer
    // (lib/invoices/invoice-payment-row.ts). This path plans strictly (no öre
    // absorption, same currency only), so the applied amount IS the bank line
    // to the öre: the writer is used for one set of row semantics, not for a
    // different number. A unique violation (23505) means the row already
    // exists for this voucher and is not an error here.
    const recorded = await recordInvoicePaymentRow(supabase, {
      userId,
      companyId,
      invoice: {
        id: invoiceId,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate,
        paid_amount: invoice.paid_amount,
      },
      paymentDate: transaction.date,
      newPaidAmount,
      journalEntryId,
      transactionId,
      exchangeRate: paymentExchangeRate,
      notes: 'Kopplad till befintlig verifikation (ingen ny bokföring skapad)',
      source: 'link',
      // The caller named the verifikat and the invoice it settles.
      linkBasis: { basis: 'user_confirmed' },
    })

    if (!recorded.ok && recorded.code !== '23505') {
      const { error: invRevertErr } = await supabase
        .from('invoices')
        .update({
          status: invoice.status,
          paid_at: invoice.paid_at ?? null,
          paid_amount: invoice.paid_amount ?? 0,
          remaining_amount: invoice.remaining_amount ?? invoice.total,
        })
        .eq('id', invoiceId)
        .eq('company_id', companyId)
      if (invRevertErr) {
        log.warn('failed to revert invoice status after payment insert failed', {
          companyId,
          invoiceId,
          rollbackError: invRevertErr.message,
        })
      }
      await rollbackTxLink('invoice_payments insert failed')
      return { ok: false, code: 'MATCH_INVOICE_RECORD_PAYMENT_FAILED' }
    }

    // The invoice is settled, so every transaction still carrying a suggestion
    // pointer at it is dead: retire them (issue #1259). No exceptTransactionId
    // needed: this row's own hints were already nulled by the tx update above,
    // so the invoice-id filter no longer selects it.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId)
    }
  }

  // The transaction is now anchored to an existing verifikat: complete any
  // matched inbox items against it (underlag link + consumed stamp) so they
  // leave the active inbox. Best-effort, logged inside.
  await propagateUnderlagForBookedTransaction(supabase, companyId, transactionId, journalEntryId)

  await logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
    invoiceId,
    newState: {
      journal_entry_id: journalEntryId,
      invoice_id: invoiceId ?? null,
      invoice_status: invoice ? newStatus : null,
    },
  })

  if (invoice && invoiceId) {
    const settledInvoice = {
      ...invoice,
      status: newStatus,
      paid_at: paidAt,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    } as Invoice
    try {
      await eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: settledInvoice,
          transaction: {
            ...transaction,
            journal_entry_id: journalEntryId,
            invoice_id: invoiceId,
            potential_rot_rut_payout_request_id: null,
            potential_invoice_id: null,
            potential_supplier_invoice_id: null,
            is_business: true,
          } as Transaction,
          userId,
          companyId,
        },
      })
    } catch {
      /* non-critical */
    }
    // Linking the payment that settles the invoice in full is its
    // invoice.paid transition; a partial link is not. The CAS update above
    // admits one winner, so this fires once. Subscribers get the full
    // committed row like every other settlement door (the narrow read above
    // lacks e.g. stripe_payment_link_id, which the Stripe handler needs), so
    // it is re-read on this transition only. Same-currency only (guarded
    // above), so the applied amount is in the invoice currency.
    if (newStatus === 'paid') {
      const { data: committedInvoice } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle()
      await emitInvoicePaidIfSettled({
        newStatus,
        invoice: (committedInvoice as Invoice | null) ?? settledInvoice,
        paymentAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
        paymentDate: transaction.date as string,
        userId,
        companyId,
      })
    }
  }

  const voucherLabel = formatVoucherLabel(
    journalEntry.voucher_series as string | null,
    journalEntry.voucher_number as number | null,
  )

  return {
    ok: true,
    result: {
      transactionId,
      journalEntryId,
      voucherLabel,
      invoiceId: invoiceId ?? null,
      invoiceStatus: invoice ? newStatus : null,
      paidAmount: invoice ? newPaidAmount : null,
      remainingAmount: invoice ? newRemaining : null,
    },
  }
}
