import type { McpResource } from './types'

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
    // other MCP surface reports.
    const recentTx = transactions.data ?? []
    const open = recentTx.length > 0
      ? await supabase
          .from('open_bank_rows')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .in('id', recentTx.map((t) => t.id as string))
      : { count: 0, error: null }
    if (open.error) {
      throw new Error(`Failed to count recent unbooked transactions: ${open.error.message}`)
    }

    return {
      limit,
      journal_entries: journalEntries.data ?? [],
      invoices: invoices.data ?? [],
      transactions: recentTx,
      uncategorized_transaction_count: open.count ?? 0,
    }
  },
}
