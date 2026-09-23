/**
 * GET /api/transactions/[id]/duplicate-payment-check
 *
 * Proactive check used by the InvoiceMatchDialog and MatchAllocationDialog:
 * returns the candidate verifikation that already books this bank
 * transaction (`candidate`, 1:1, or null), and the set of one or more posted
 * unlinked vouchers whose bank legs add up exactly to the row
 * (`candidate_set`, or null). Lets the UI display the warning panel without
 * needing to first submit a doomed match.
 *
 * Same detectors as the match-invoice and match-batch pre-flights, so what
 * you see here matches what the POSTs would refuse.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  detectDuplicatePaymentVoucher,
  detectExplainingVoucherSetForTransaction,
  type ExplainingVoucherSet,
} from '@/lib/invoices/duplicate-payment-detection'

export const GET = withRouteContext(
  'transaction.duplicate_payment_check',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Membership is enforced by withRouteContext (see its docstring): the
    // resolved companyId is always a company the caller is a member of, so
    // intra-company multi-user visibility of transaction metadata here is
    // the intended tenancy model. The selected column set is intentionally
    // narrow (id, date, amount, journal_entry_id) so this endpoint cannot
    // leak description / counterparty fields that aren't required to
    // surface a duplicate-payment candidate. GDPR Art.5(1)(c)/(f).
    //
    // currency / amount_sek / exchange_rate are part of that minimum, not an
    // expansion of it: they carry no personal data, and without them the
    // detector cannot state a non-SEK bank line in SEK and would compare a
    // foreign amount against an always-SEK ledger leg. A narrow column list is
    // exactly how this guard would go dead on FX rows.
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('id, date, amount, currency, amount_sek, exchange_rate, journal_entry_id, cash_account_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (error || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Already linked → no possible duplicate to surface.
    if (transaction.journal_entry_id) {
      return NextResponse.json({ candidate: null, candidate_set: null })
    }

    // Both detectors fail open: returning null preserves current UX. The
    // POSTs still run their own checks, so a missed pre-flight doesn't allow
    // a duplicate booking.
    let candidate: Awaited<ReturnType<typeof detectDuplicatePaymentVoucher>> = null
    try {
      candidate = await detectDuplicatePaymentVoucher(supabase, {
        companyId: companyId!,
        transactionId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
        transactionCurrency: transaction.currency ?? null,
        transactionAmountSek: transaction.amount_sek ?? null,
        transactionExchangeRate: transaction.exchange_rate ?? null,
      })
    } catch (err) {
      log.warn('duplicate-payment-voucher detection failed', err as Error)
    }

    let candidateSet: ExplainingVoucherSet | null = null
    try {
      candidateSet = await detectExplainingVoucherSetForTransaction(supabase, companyId!, {
        id: transaction.id,
        date: transaction.date,
        amount: transaction.amount,
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
        journal_entry_id: null,
      })
    } catch (err) {
      log.warn('explaining-voucher-set detection failed', err as Error)
    }

    return NextResponse.json({ candidate, candidate_set: candidateSet })
  },
)
