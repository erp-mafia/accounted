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
        .select('id, invoice_number, customer_id, invoice_date, due_date, total_amount, currency, status, created_at')
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

    return {
      limit,
      journal_entries: journalEntries.data ?? [],
      invoices: invoices.data ?? [],
      transactions: transactions.data ?? [],
      uncategorized_transaction_count: (transactions.data ?? []).filter(
        (t) => !t.journal_entry_id
      ).length,
    }
  },
}
