import type { McpResource } from './types'
import { fetchAnchoredTransactionIds } from '@/lib/transactions/unbooked'

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
        .select('id, date, description, amount, currency, journal_entry_id, category, merchant_name, is_business, is_ignored')
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

    // Unbooked as lib/transactions/unbooked.ts defines it, the count every
    // other MCP surface reports: not ignored, not triaged as private, and no
    // verifikat. A NULL pointer is not enough on its own: rows bulk-booked
    // into a samlingsverifikat, split over several verifikat (1:N) or settled
    // through an invoice allocation are anchored elsewhere.
    const recentTx = transactions.data ?? []
    const pointerUnbooked = recentTx.filter((t) => !t.journal_entry_id && !t.is_ignored && t.is_business !== false)
    const anchored =
      pointerUnbooked.length > 0
        ? await fetchAnchoredTransactionIds(
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
      uncategorized_transaction_count: pointerUnbooked.filter((t) => !anchored.has(t.id as string)).length,
    }
  },
}
