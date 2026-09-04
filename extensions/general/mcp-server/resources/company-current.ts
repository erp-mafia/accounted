import type { McpResource } from './types'

/**
 * Per-company working memory for agents. Read at session start so Claude
 * knows what exists in the tenant before composing tool calls: counts,
 * active fiscal period, lock dates, voucher-series state, recent activity,
 * approaching deadlines. Mirrors the `context.md` pattern from
 * Shipper+Claude's "Agent-native Architectures" guidance.
 *
 * Read-only and per-request; no caching. Target payload <8 KB.
 */
export const companyCurrentResource: McpResource = {
  uri: 'Accounted://company/current',
  name: 'Active Company',
  description: 'Working memory for the API key default company: identity, active fiscal period, lock dates, entity counts, voucher series state, recent activity, and filing deadlines. For another company, call gnubok_get_agent_briefing with company_id.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    const today = new Date().toISOString().slice(0, 10)

    const [
      companyRes,
      settingsRes,
      activePeriodRes,
      openPeriodsRes,
      customerCountRes,
      supplierCountRes,
      openInvoiceCountRes,
      openSupplierInvoiceCountRes,
      uncategorizedTxCountRes,
      voucherSequencesRes,
      lastCategorizationRes,
      lastInvoiceSentRes,
      lastBankSyncRes,
      upcomingDeadlinesRes,
    ] = await Promise.all([
      supabase
        .from('companies')
        .select('id, name, org_number, entity_type, archived_at, created_at')
        .eq('id', companyId)
        .single(),

      supabase
        .from('company_settings')
        .select('pays_salaries, f_skatt, vat_registered, vat_number, moms_period, fiscal_year_start_month, accounting_method, default_voucher_series, bookkeeping_locked_through, auto_lock_period_days, invoice_prefix, next_invoice_number, invoice_default_days, is_sandbox')
        .eq('company_id', companyId)
        .maybeSingle(),

      // The fiscal period covering today: the "active" one for new entries.
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
        .eq('company_id', companyId)
        .lte('period_start', today)
        .gte('period_end', today)
        .maybeSingle(),

      // All open (un-closed) periods so an agent can post into a prior open year.
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, locked_at')
        .eq('company_id', companyId)
        .eq('is_closed', false)
        .order('period_start', { ascending: false })
        .limit(5),

      supabase
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),

      supabase
        .from('suppliers')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),

      // Open AR: anything not paid/credited/cancelled. Proformas, delivery
      // notes and quotes are never receivables, so only fakturor count.
      supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('document_type', 'invoice')
        .in('status', ['draft', 'sent', 'overdue']),

      // Open AP: anything still pending payment.
      supabase
        .from('supplier_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('status', ['registered', 'approved', 'overdue', 'partially_paid']),

      // Uncategorized bank transactions awaiting a journal entry.
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('journal_entry_id', null),

      // Voucher-series state across open fiscal periods. Scoped by company_id:
      // the table also carries user_id, but a multi-company user would otherwise
      // pull series belonging to their other tenants into this company's context
      // (cross-tenant leak flagged by PR #505 review).
      supabase
        .from('voucher_sequences')
        .select('voucher_series, last_number, fiscal_period_id, fiscal_periods!inner(name, period_start, period_end)')
        .eq('company_id', companyId)
        .order('voucher_series', { ascending: true }),

      // Recency signals: when did each surface last move?
      // 'bank_transaction' is the source_type the engine writes when a bank
      // transaction is categorized (journal_entries_source_type_check); there
      // is no 'transaction' value, so filtering on it matched nothing.
      supabase
        .from('journal_entries')
        .select('created_at')
        .eq('company_id', companyId)
        .eq('source_type', 'bank_transaction')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // "Sent" lives in the delivery log, not on invoices: that table has no
      // sent timestamp at all. Both send paths write invoice_deliveries.sent_at
      // (email -> status 'sent', manual mark-as-sent -> 'marked_sent'), and the
      // invoice detail view reads the same rows for its "Skickad" date, so the
      // agent and the UI now agree. Only sent_at is selected: the rest of the
      // delivery row is recipient/message PII this resource has no use for.
      supabase
        .from('invoice_deliveries')
        .select('sent_at')
        .eq('company_id', companyId)
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      supabase
        .from('bank_connections')
        .select('last_synced_at')
        .eq('company_id', companyId)
        .not('last_synced_at', 'is', null)
        .order('last_synced_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Scoped by company_id: the table also carries user_id (legacy single-tenant
      // design), but RLS + multi-tenant refactor added company_id and the column is
      // indexed. Multi-company users would otherwise see deadlines from all their
      // companies mixed into one company's context (cross-tenant leak flagged by
      // PR #505 review).
      supabase
        .from('deadlines')
        .select('id, title, due_date, deadline_type, priority, status')
        .eq('company_id', companyId)
        .eq('is_completed', false)
        .gte('due_date', today)
        .order('due_date', { ascending: true })
        .limit(5),
    ])

    if (companyRes.error || !companyRes.data) {
      throw new Error(`Company not found: ${companyRes.error?.message ?? 'unknown'}`)
    }

    // A null recency signal is a factual claim ("this never happened") that the
    // agent acts on, so a failed read must surface as an error rather than
    // degrade into that claim. resources/read turns the throw into a JSON-RPC
    // error, same as period-active does for its period read. PGRST116 is the
    // legitimate no-rows case and stays null.
    const recencyReads = [
      { label: 'last categorization', error: lastCategorizationRes.error },
      { label: 'last invoice delivery', error: lastInvoiceSentRes.error },
      { label: 'last bank sync', error: lastBankSyncRes.error },
    ]
    for (const read of recencyReads) {
      if (read.error && read.error.code !== 'PGRST116') {
        throw new Error(`Failed to read ${read.label}: ${read.error.message}`)
      }
    }

    const settings = settingsRes.data
    const activePeriod = activePeriodRes.data
    const periodStatus: 'open' | 'locked' | 'closed' = activePeriod?.is_closed
      ? 'closed'
      : activePeriod?.locked_at
        ? 'locked'
        : 'open'

    type VoucherSequenceRow = {
      voucher_series: string
      last_number: number
      fiscal_period_id: string
      fiscal_periods:
        | { name?: string; period_start?: string; period_end?: string }
        | { name?: string; period_start?: string; period_end?: string }[]
        | null
    }
    const voucherSeries = (voucherSequencesRes.data ?? []).map((row: VoucherSequenceRow) => {
      const fp = Array.isArray(row.fiscal_periods) ? row.fiscal_periods[0] : row.fiscal_periods
      return {
        series: row.voucher_series,
        next_number: row.last_number + 1,
        fiscal_period_id: row.fiscal_period_id,
        fiscal_period_name: fp?.name ?? null,
        period_start: fp?.period_start ?? null,
        period_end: fp?.period_end ?? null,
      }
    })

    return {
      company: companyRes.data,
      settings: settings ?? null,
      base_currency: 'SEK',
      fiscal: {
        active_period: activePeriod
          ? {
              id: activePeriod.id,
              name: activePeriod.name,
              period_start: activePeriod.period_start,
              period_end: activePeriod.period_end,
              status: periodStatus,
              locked_at: activePeriod.locked_at,
              has_closing_entry: !!activePeriod.closing_entry_id,
            }
          : null,
        company_lock_date: settings?.bookkeeping_locked_through ?? null,
        open_periods: openPeriodsRes.data ?? [],
      },
      counts: {
        customers: customerCountRes.count ?? 0,
        suppliers: supplierCountRes.count ?? 0,
        open_invoices: openInvoiceCountRes.count ?? 0,
        open_supplier_invoices: openSupplierInvoiceCountRes.count ?? 0,
        uncategorized_transactions: uncategorizedTxCountRes.count ?? 0,
      },
      voucher_series: voucherSeries,
      recent: {
        last_categorization_at: lastCategorizationRes.data?.created_at ?? null,
        last_invoice_sent_at: lastInvoiceSentRes.data?.sent_at ?? null,
        last_bank_sync_at: lastBankSyncRes.data?.last_synced_at ?? null,
      },
      upcoming_deadlines: upcomingDeadlinesRes.data ?? [],
    }
  },
}
