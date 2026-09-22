import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBestInvoiceMatch } from '@/lib/invoices/invoice-matching'
import { findRotRutPayoutMatch } from '@/lib/invoices/rot-rut-payout-matching'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/rot-rut-payout-candidates'
import type { Transaction } from '@/types'

/**
 * POST /api/transactions/batch-match-invoices
 * Run invoice matching for all uncategorized income transactions without potential_invoice_id.
 * Rows that match no invoice are then tried against open ROT/RUT payout
 * requests (Skatteverkets utbetalning), so bank rows imported before that
 * hint existed still get a suggestion on the next run.
 */
export const POST = withRouteContext(
  'transaction.batch_match_invoices',
  async (_request, { supabase, companyId }) => {
    // Fetch uncategorized income transactions without a potential match
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .is('is_business', null)
      .gt('amount', 0)
      .is('potential_invoice_id', null)
      .is('invoice_id', null)
      .order('date', { ascending: false })
      .limit(50)

    if (txError || !transactions) {
      return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 })
    }

    // Open begäran, loaded once: the matcher is pure and the table is tiny.
    let openRotRutRequests = await loadOpenRotRutPayoutRequests(supabase, companyId!)

    let matched = 0
    const matchedInvoiceIds = new Set<string>()

    for (const tx of transactions) {
      try {
        const bestMatch = await getBestInvoiceMatch(
          supabase,
          companyId,
          tx as Transaction,
          0.50
        )

        if (bestMatch && !matchedInvoiceIds.has(bestMatch.invoice.id)) {
          await supabase
            .from('transactions')
            .update({ potential_invoice_id: bestMatch.invoice.id })
            .eq('id', tx.id)

          matchedInvoiceIds.add(bestMatch.invoice.id)
          matched++
          continue
        }

        if (
          openRotRutRequests.length > 0 &&
          !(tx as Transaction).potential_rot_rut_payout_request_id
        ) {
          const payoutMatch = findRotRutPayoutMatch(tx as Transaction, openRotRutRequests)
          if (payoutMatch) {
            const { error: hintError } = await supabase
              .from('transactions')
              .update({ potential_rot_rut_payout_request_id: payoutMatch.request.id })
              .eq('id', tx.id)
            // A hint that never persisted must not drain the pool or count.
            if (hintError) throw hintError
            // One payout per begäran: drain so a same-amount sibling can't claim it.
            openRotRutRequests = openRotRutRequests.filter((r) => r.id !== payoutMatch.request.id)
            matched++
          }
        }
      } catch {
        // Continue with other transactions
      }
    }

    return NextResponse.json({
      processed: transactions.length,
      matched,
    })
  },
  { requireWrite: true },
)
