/**
 * GET /api/transactions/[id]/booking-duplicate-check
 *
 * Asks the booking-time duplicate guard before anything is booked: returns
 * the already-booked twin of this bank line (`candidate`, or null). The
 * transactions list calls it when a row's Bokför is clicked, so a row whose
 * affärshändelse is already in the ledger (typically a salary payout booked
 * by the salary run, or an invoice marked paid) opens on "finns redan" with
 * Koppla, instead of on a template proposal and a missing-underlag warning
 * that invite a second verifikat.
 *
 * Same detector as POST /book and /categorize (`detectBookingDuplicate`), so
 * what this answers is exactly what those would refuse. Fail-open: a
 * detection error answers null and leaves the ordinary flow; the booking
 * doors still run the guard themselves.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'

export const GET = withRouteContext(
  'transaction.booking_duplicate_check',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    // currency / amount_sek / exchange_rate: the detector compares in SEK and
    // needs them to state a foreign bank line in kronor (see
    // resolveTransactionAmountSek).
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('id, date, amount, currency, amount_sek, exchange_rate, journal_entry_id, cash_account_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (error || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Already linked: nothing left to book, so no twin to warn about.
    if (transaction.journal_entry_id) {
      return NextResponse.json({ candidate: null })
    }

    let candidate: BookedDuplicateCandidate | null = null
    try {
      candidate = await detectBookingDuplicate(supabase, companyId!, {
        id: transaction.id,
        date: transaction.date,
        amount: transaction.amount,
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      })
    } catch (err) {
      log.warn('booking-duplicate detection failed', err as Error)
    }

    return NextResponse.json({ candidate })
  },
)
