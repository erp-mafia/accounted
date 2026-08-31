import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { setTransactionIgnored } from '@/lib/transactions/ignore'

/**
 * POST /api/transactions/[id]/ignore
 *
 * Mark a bank transaction as ignored so it stops surfacing in the bank
 * reconciliation view (and other "to book" funnels) without creating a
 * verifikation. Use case: tiny ränteintäkter, rounding noise, opening-balance
 * artefacts, PSD2 ghost rows: anything the user wants off the unmatched list
 * but doesn't want to fabricate a journal entry for. No verifikat is written,
 * so a locked or closed period does not block it (issue #1661).
 *
 * Refuses when the transaction is already booked (directly or through a
 * payment allocation / voucher link: lib/transactions/is-booked.ts); once a
 * verifikation exists, the proper way to revisit it is /uncategorize (storno).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.ignore',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    try {
      const outcome = await setTransactionIgnored(supabase, companyId, id, true)
      if (!outcome.ok) {
        if (outcome.status === 404) {
          return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
        }
        return NextResponse.json(
          { error: getErrorEntry(outcome.code)?.message_sv ?? 'Transaktionen är redan bokförd.' },
          { status: outcome.status },
        )
      }
      if (!outcome.changed) {
        return NextResponse.json({ success: true, already_ignored: true })
      }
      return NextResponse.json({ success: true })
    } catch (err) {
      return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
    }
  },
  { requireWrite: true },
)

/**
 * DELETE /api/transactions/[id]/ignore
 *
 * Reverse a previous ignore. The row comes back into the unmatched list with
 * no further side effects: we never created a verifikation, so there's
 * nothing to storno.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.unignore',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    try {
      const outcome = await setTransactionIgnored(supabase, companyId, id, false)
      if (!outcome.ok) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
      }
      return NextResponse.json({ success: true })
    } catch (err) {
      return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
    }
  },
  { requireWrite: true },
)
