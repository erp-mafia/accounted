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
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'

export const GET = withRouteContext(
  'transaction.booking_duplicate_check',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    // The columns the booking doors hand the guard (BookingTarget), so the
    // row read here is the guard's target as it is. currency / amount_sek /
    // exchange_rate: the detector compares in SEK and needs them to state a
    // foreign bank line in kronor (resolveTransactionAmountSek). The feed
    // identity (external_id ... bank_file_import_id) tells two entries of one
    // feed apart (crm#1271, crm#1312): without it the probe flagged a second
    // identical Swish the submit guard lets through, and the force bound to
    // that twin then failed there.
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select(
        'id, date, amount, currency, amount_sek, exchange_rate, journal_entry_id, cash_account_id, external_id, import_source, bank_connection_id, provider_transaction_id, bank_file_import_id',
      )
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (error || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Already booked (the pointer, a bank_line voucher link or a verifikat
    // naming the row, the same answer POST /book and /categorize give):
    // nothing left to book, so no twin to warn about; the booking door
    // refuses it with its own message. A failed read answers null here too,
    // and the door, which fails closed, decides.
    const bookable = await assertTransactionBookable(supabase, companyId, transaction)
    if (!bookable.ok) {
      return NextResponse.json({ candidate: null })
    }

    let candidate: BookedDuplicateCandidate | null = null
    try {
      candidate = await detectBookingDuplicate(supabase, companyId, transaction)
    } catch (err) {
      log.warn('booking-duplicate detection failed', err as Error)
    }

    return NextResponse.json({ candidate })
  },
)
