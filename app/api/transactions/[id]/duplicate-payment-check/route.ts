/**
 * GET /api/transactions/[id]/duplicate-payment-check
 *
 * Proactive check used by the InvoiceMatchDialog: returns the candidate
 * verifikation that already books this bank transaction, or null if no
 * duplicate is detected. Lets the UI display the warning panel without
 * needing to first submit a doomed match.
 *
 * Same detector as the match-invoice route's pre-flight, so what you see
 * here matches what the POST would refuse.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'

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
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('id, date, amount, journal_entry_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (error || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Already linked → no possible duplicate to surface.
    if (transaction.journal_entry_id) {
      return NextResponse.json({ candidate: null })
    }

    try {
      const candidate = await detectDuplicatePaymentVoucher(supabase, {
        companyId: companyId!,
        transactionId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
      })
      return NextResponse.json({ candidate })
    } catch (err) {
      log.warn('duplicate-payment-voucher detection failed', err as Error)
      // Fail-open: returning null preserves current UX. The POST still
      // runs its own check, so a missed pre-flight doesn't allow a
      // duplicate booking.
      return NextResponse.json({ candidate: null })
    }
  },
)
