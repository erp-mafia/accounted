import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * POST /api/transactions/[id]/ignore
 *
 * Mark a bank transaction as ignored so it stops surfacing in the bank
 * reconciliation view (and other "to book" funnels) without creating a
 * verifikation. Use case: tiny ränteintäkter, rounding noise, opening-balance
 * artefacts: anything the user wants off the unmatched list but doesn't want
 * to fabricate a journal entry for.
 *
 * Refuses when the transaction is already booked; once a verifikation exists,
 * the proper way to revisit it is /uncategorize (storno).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.ignore',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, journal_entry_id, is_ignored')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (transaction.journal_entry_id) {
      return NextResponse.json(
        { error: 'Transaktionen är redan bokförd: använd Avmatcha eller backa verifikationen för att ändra status.' },
        { status: 409 }
      )
    }

    if (transaction.is_ignored) {
      return NextResponse.json({ success: true, already_ignored: true })
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update({ is_ignored: true })
      .eq('id', id)
      .eq('company_id', companyId)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
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

    const { error: updateError } = await supabase
      .from('transactions')
      .update({ is_ignored: false })
      .eq('id', id)
      .eq('company_id', companyId)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
