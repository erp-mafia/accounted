import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchGLLinesForMatching, tryReconcileTransaction } from '@/lib/reconciliation/bank-reconciliation'
import type { Transaction } from '@/types'

export const GET = withRouteContext(
  'reconciliation.bank.unmatched_entries',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get('date_from') || undefined
    const dateTo = searchParams.get('date_to') || undefined
    const accountNumber = searchParams.get('account_number') || '1930'
    // Optional: when set, rank the returned candidates for this specific bank
    // transaction (used by the Transactions-page "Matcha mot befintlig
    // verifikation" dialog). Ranking happens server-side on purpose:
    // lib/reconciliation/bank-reconciliation pulls in server-only deps (event
    // bus, match-log) and must never reach the client bundle.
    const transactionId = searchParams.get('transaction_id') || undefined
    // When true, also return vouchers already matched to a bank transaction (each
    // carries linked_transaction_count) so the user can attach a second/third
    // transaction to the same verifikat, the N:1 "lägga på flera" case. Default
    // false keeps the list to unmatched candidates only.
    const includeMatched = searchParams.get('include_matched') === 'true'

    // Defense-in-depth: only allow account numbers that the company has actually
    // registered as a cash account. Without this, a curious caller could probe
    // arbitrary GL accounts for posted-but-unmatched amounts. Applies uniformly
    // including '1930': the cash_accounts backfill seeds 1930 for every company
    // that had a SEK PSD2 account, and the AccountPickerDialog seeds it for new
    // companies on first connection.
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumber)
      .maybeSingle()

    if (!cashAccount) {
      return NextResponse.json(
        { error: 'Okänt kassakonto för det här företaget' },
        { status: 400 },
      )
    }

    const lines = await fetchGLLinesForMatching(supabase, companyId, accountNumber, dateFrom, dateTo, includeMatched)

    if (transactionId) {
      // company-scoped fetch (defense-in-depth). A malformed/foreign id yields no
      // row → we fall through to the unranked list rather than erroring.
      const { data: tx } = await supabase
        .from('transactions')
        .select('id, amount, date, currency, reference')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (!tx) {
        // transaction_id was supplied but doesn't resolve to a row in the
        // caller's company: the ranking context is invalid. Return no candidates
        // rather than silently falling back to the full unranked list, so a
        // fabricated or foreign id can never yield a broader result set.
        return NextResponse.json({ data: [] })
      }

      const txCurrency = (tx.currency as string | null) ?? 'SEK'
      const txDate = tx.date as string
      const ranked = lines
        .map((line) => {
          // Score each line in isolation; confidence 0 means "no auto-match
          // rule fired": the line still appears so the user can pick it
          // manually (e.g. a salary or Fortnox voucher with a tweaked date).
          const match = tryReconcileTransaction(tx as unknown as Transaction, [line], txCurrency)
          return { ...line, confidence: match?.confidence ?? 0 }
        })
        .sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence
          const da = Math.abs(new Date(a.entry_date).getTime() - new Date(txDate).getTime())
          const db = Math.abs(new Date(b.entry_date).getTime() - new Date(txDate).getTime())
          return da - db
        })
      return NextResponse.json({ data: ranked })
    }

    return NextResponse.json({ data: lines })
  },
)
