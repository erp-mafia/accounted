import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getJournalEntryLinkedTransactions } from '@/lib/core/bookkeeping/journal-entry-transactions'

/**
 * GET /api/bookkeeping/journal-entries/[id]/transactions
 *
 * The bank transactions and skattekonto rows anchored to this verifikation:
 * the mirror of "Visa verifikat" on the transactions page, so the
 * verifieringskedja is followable from the verifikat side too. Read-only.
 *
 * An id outside the active company resolves to an empty list (every
 * underlying query is company-scoped), so this neither leaks nor 404s.
 *
 * Marked private, no-store: the payload carries bank descriptions and amounts.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'journal_entry.transactions',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params
    const transactions = await getJournalEntryLinkedTransactions(supabase, companyId, id)
    return NextResponse.json(
      { data: { transactions } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
)
