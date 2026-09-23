import type { McpResource } from './types'
import { fetchJunctionLinkedTxIds } from '@/lib/reconciliation/bank-reconciliation'

export const recentActivityResource: McpResource = {
  uri: 'Accounted://recent-activity',
  name: 'Recent Activity',
  description: 'Most recent journal entries, invoices, and bank transactions for the current company. Optional ?limit=N (default 20, max 100). Use to orient on the latest state without burning tool calls.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId, query }) => {
    const limit = Math.min(Math.max(Number(query?.get('limit') ?? 20), 1), 100)

    const [journalEntries, invoices, transactions] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('id, voucher_number, voucher_series, entry_date, description, status, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase
        .from('invoices')
        .select('id, invoice_number, customer_id, invoice_date, due_date, total, currency, status, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase
        .from('transactions')
        .select('id, date, description, amount, currency, journal_entry_id, category, merchant_name')
        .eq('company_id', companyId)
        .order('date', { ascending: false })
        .limit(limit),
    ])

    // Never report an empty list when the query failed: an agent that is told
    // "zero invoices" reasons from false state, which is worse than an error.
    if (journalEntries.error) {
      throw new Error(`Failed to read recent journal entries: ${journalEntries.error.message}`)
    }
    if (invoices.error) {
      throw new Error(`Failed to read recent invoices: ${invoices.error.message}`)
    }
    if (transactions.error) {
      throw new Error(`Failed to read recent transactions: ${transactions.error.message}`)
    }

    // A NULL pointer is not "unbooked" on its own: rows bulk-booked into a
    // samlingsverifikat or split over several verifikat (1:N) are anchored
    // through transaction_voucher_links (lib/transactions/is-booked.ts).
    const recentTx = transactions.data ?? []
    const pointerUnbooked = recentTx.filter((t) => !t.journal_entry_id)
    const junctionLinked =
      pointerUnbooked.length > 0
        ? await fetchJunctionLinkedTxIds(
            supabase,
            companyId,
            pointerUnbooked.map((t) => t.id as string),
          )
        : new Set<string>()

    return {
      limit,
      journal_entries: journalEntries.data ?? [],
      invoices: invoices.data ?? [],
      transactions: recentTx,
      uncategorized_transaction_count: pointerUnbooked.filter((t) => !junctionLinked.has(t.id as string))
        .length,
    }
  },
}
