import { NextResponse } from 'next/server'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.uncategorize',
  async (_request, { supabase, user, companyId }, { params }) => {
    const { id } = await params

    // Fetch transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (!transaction.journal_entry_id) {
      return NextResponse.json({ error: 'Transaction has no journal entry' }, { status: 400 })
    }

    // Verify journal entry is posted
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', transaction.journal_entry_id)
      .eq('company_id', companyId)
      .single()

    if (entryError || !entry) {
      return NextResponse.json({ error: 'Journal entry not found' }, { status: 400 })
    }

    if (entry.status !== 'posted') {
      return NextResponse.json({ error: 'Journal entry is not posted' }, { status: 400 })
    }

    // Storno reversal (legally compliant: never deletes)
    try {
      await reverseEntry(supabase, companyId, user.id, transaction.journal_entry_id)
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      const message = err instanceof Error ? err.message : 'Reversal failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }

    // Reset transaction categorization
    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        is_business: null,
        category: null,
        journal_entry_id: null,
      })
      .eq('id', id)
      .eq('company_id', companyId)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to reset transaction' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
