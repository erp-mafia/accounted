/**
 * Every report RPC the app calls, with the arguments the app passes on a
 * default request, against the measured company. One case per distinct call:
 * where several reports make the same call, `usedBy` lists them. Traced from
 * the call sites on 2026-10-24 (src/lib/reports, src/lib/reconciliation,
 * src/lib/bokslut, src/app/api/reports, the dashboard loaders); when a call
 * site changes its arguments, change the case with it.
 *
 * Defaults the cases follow:
 *   - fiscal-range reports open on year to date: from the period start to
 *     today, in the open year 2026;
 *   - the VAT report opens on the last month that has ended (September),
 *     periodisk sammanställning on the current quarter, behandlingshistorik
 *     and the bank reconciliation on the current month;
 *   - the year-end reports (årsredovisning, bokslutsbilagor) on the last
 *     closed year, 2025.
 * The case ids are the keys of budgets.json.
 */
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'
import type { FiscalYear } from './fixture'

export interface Period {
  id: string
  start: string
  end: string
  /** fiscal_periods.opening_balance_entry_id: the reports exclude it from activity. */
  obEntryId: string | null
}

/** What the runner reads from the seeded database before it starts. */
export interface BenchContext {
  companyId: string
  userId: string
  today: string
  periods: Record<FiscalYear, Period>
  /** The 1930 bank account's cash_accounts row. */
  cashAccountId: string
  /** A later page of the 1930 huvudbok card: the line 70 % of the way into the year. */
  accountPageCursor: { afterDate: string; afterVoucher: number; afterLineId: string }
  /** A later grundbok page: the verifikat 70 % of the way into the year. */
  registerCursor: { afterSeries: string; afterNumber: number; afterId: string }
  /** The account with the most lines that still fit inline (2 000): a single-account drill-down. */
  drilldownAccount: string
  /** The company's own VAT-classified accounts, approximating fetchDynamicVatAccounts(). */
  ownVatAccounts: string[]
  /** The open (unbooked) bank rows of the reconciliation month, as the covering-set check reads them. */
  openBankRows: { ids: string[]; low: string; high: string }
}

/** The posting path's case: run.ts times commit_journal_entry on a draft made the way the engine makes one. */
export const POST_CASE_ID = 'post.commit_journal_entry'

export interface RpcCase {
  /** Stable key: budgets.json and the result files use it. */
  id: string
  rpc: string
  args: Record<string, unknown>
  /** The reports and pages that make this call. */
  usedBy: string
  /** Known to take most of a second or more: five runs, and left out of mixed mode so it does not set the load. */
  heavy?: boolean
  /** A view read instead of an RPC, with the door's filters: `rpc` names the relation and `args` stays empty. */
  read?: { sql: string; values: unknown[] }
}

/** The fixed momsdeklaration accounts, derived as src/lib/reports/vat-declaration.ts derives VAT_ACCOUNTS. */
const VAT_ACCOUNTS = Object.entries(VAT_ACCOUNT_TABLE)
  .filter(([, row]) => row.declared !== false)
  .map(([account]) => account)
const RUTA_05_ACCOUNTS = Object.entries(VAT_ACCOUNT_TABLE)
  .filter(([, row]) => row.declared !== false && row.box === '05')
  .map(([account]) => account)
/** VAT_SETTLEMENT_NET_ACCOUNTS in src/lib/reports/vat-declaration.ts. */
const VAT_NET_ACCOUNTS = ['2650', '1650']
/** INVOICE_ENGINE_SOURCE_TYPES and AR_ACCOUNTS in src/lib/reports/invoice-register-coverage.ts. */
const INVOICE_ENGINE_SOURCE_TYPES = [
  'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note', 'reminder_fee', 'rot_rut_payout',
  'rot_rut_reclaim', 'customer_loss', 'counterparty_setoff', 'rot_rut_reclassification', 'storno', 'correction',
]
const AR_ACCOUNTS = ['1510', '1513']
/** The paid capability set the dashboard layout asks for (src/lib/entitlements/has-capability.ts). */
const LAYOUT_CAPABILITY_KEYS = [
  'ai', 'bank_sync', 'skatteverket', 'email_send', 'stripe_payments', 'woocommerce_sync', 'shopify_sync',
  'zettle_sync', 'multi_user', 'collections',
]

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function sameDayYearBefore(isoDate: string): string {
  return `${Number(isoDate.slice(0, 4)) - 1}${isoDate.slice(4)}`
}

export function buildCases(ctx: BenchContext): RpcCase[] {
  const co = ctx.companyId
  const open = ctx.periods['2026']
  const prior = ctx.periods['2025']
  const ytd = { p_from_date: open.start, p_to_date: ctx.today }
  const tb = (period: Period, mode: string, from: string | null, to: string | null) => ({
    p_company_id: co,
    p_fiscal_period_id: period.id,
    p_closing_mode: mode,
    p_from_date: from,
    p_to_date: to,
    p_exclude_entry_id: period.obEntryId,
    p_dimensions: null,
  })
  const month = { start: '2026-10-01', end: '2026-10-31' }
  const vatMonth = { p_start: '2026-09-01', p_end: '2026-09-30' }
  const bank = {
    p_company_id: co,
    p_account_number: '1930',
    p_currency: 'SEK',
    p_cash_account_id: ctx.cashAccountId,
    p_include_unassigned: true,
  }

  return [
    // ---- every request ----
    {
      id: 'request.resolve_active_company',
      rpc: 'resolve_active_company',
      args: {},
      usedBy: 'auth proxy and route wrapper: twice per page, once per API call',
    },

    // ---- Hem and the dashboard layout ----
    {
      id: 'hem.capability_grant_rows',
      rpc: 'company_capability_grant_rows',
      args: { p_company_id: co, p_capability_keys: LAYOUT_CAPABILITY_KEYS, p_connector_only: false },
      usedBy: 'dashboard layout (every page)',
    },
    {
      id: 'hem.nav_flags',
      rpc: 'get_dashboard_nav_flags',
      args: { p_company_id: co },
      usedBy: 'dashboard layout (every page)',
    },
    {
      id: 'hem.verifikat_without_documents',
      rpc: 'verifikat_without_documents',
      args: { p_company_id: co, p_limit: 25, p_offset: 0 },
      usedBy: 'Hem: saknar underlag, and the worklist count',
    },
    {
      id: 'hem.collection_open_invoice_ids',
      rpc: 'collection_open_invoice_ids',
      args: { p_company_id: co },
      usedBy: 'Hem: overdue invoices',
    },
    {
      id: 'hem.collection_attention_case_ids',
      rpc: 'collection_attention_case_ids',
      args: { p_company_id: co },
      usedBy: 'Hem: overdue invoices, collection attention',
    },
    {
      id: 'hem.peppol_failed_invoice_ids',
      rpc: 'peppol_failed_invoice_ids',
      args: { p_company_id: co, p_limit: 200 },
      usedBy: 'Hem: failed Peppol deliveries',
    },
    {
      id: 'bookkeeping.list_verifikat_missing_underlag',
      rpc: 'list_verifikat_missing_underlag',
      args: {
        p_company_id: co,
        p_period_id: null,
        p_series: null,
        p_date_from: null,
        p_date_to: null,
        p_search_pattern: null,
        p_search_voucher_series: null,
        p_search_voucher_number: null,
        p_order: ['entry_date.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc'],
        p_limit: 20,
        p_offset: 0,
      },
      usedBy: 'Verifikat list behind the Hem row (missing_underlag=true)',
    },

    // ---- the most visited pages: the read each one's first view waits on ----
    // Written as PostgREST writes them (embeds as lateral joins, the list's
    // own order and page size), so the planner meets the shape production
    // sends. scripts/perf/README.md, "Page budgets", lists the pages.
    {
      id: 'page.bookkeeping.list',
      rpc: 'list_fiscal_period_entries_with_related',
      args: {
        p_company_id: co,
        p_period_id: open.id,
        p_include_related: true,
        p_status: null,
        p_date_from: null,
        p_date_to: null,
        p_sort_date: 'desc',
        p_limit: 20,
        p_offset: 0,
        p_exclude_draft: true,
        p_collapse_corrections: true,
        p_series: null,
      },
      usedBy: '/bookkeeping: the first page of the verifikat list',
    },
    {
      id: 'page.invoices.list',
      rpc: 'invoices',
      args: {},
      read: {
        sql: `SELECT i.id, i.customer_id, i.invoice_number, i.external_invoice_number, i.is_self_billed,
                     i.document_type, i.status, i.quote_status, i.invoice_date, i.due_date, i.valid_until,
                     i.subtotal, i.total, i.total_sek, i.currency, i.ore_rounding, i.credited_invoice_id,
                     i.remaining_amount, i.paid_at, i.deduction_total, i.journal_entry_id,
                     row_to_json(c.*)::jsonb AS customer
              FROM public.invoices i
              LEFT JOIN LATERAL (SELECT cu.name FROM public.customers cu WHERE cu.id = i.customer_id) c ON true
              WHERE i.company_id = $1
              ORDER BY i.invoice_date DESC, i.id DESC LIMIT 1000 OFFSET 0`,
        values: [co],
      },
      usedBy: '/invoices: the page of 1 000 rows the list paints from',
    },
    {
      id: 'page.invoices.payout_requests',
      rpc: 'rot_rut_payout_requests',
      args: {},
      read: {
        sql: `SELECT r.id, r.status, r.created_at, COALESCE(it.items, '[]') AS items
              FROM public.rot_rut_payout_requests r
              LEFT JOIN LATERAL (
                SELECT json_agg(x) AS items FROM (
                  SELECT i.invoice_id FROM public.rot_rut_payout_request_items i WHERE i.request_id = r.id
                ) x
              ) it ON true
              WHERE r.company_id = $1
              ORDER BY r.created_at ASC, r.id ASC LIMIT 1000 OFFSET 0`,
        values: [co],
      },
      usedBy: '/invoices: every begäran of the company with the invoices in it',
    },
    {
      id: 'page.invoices.deduction_lines',
      rpc: 'invoices',
      args: {},
      read: {
        sql: `SELECT i.id, COALESCE(dl.lines, '[]') AS deduction_lines
              FROM public.invoices i
              LEFT JOIN LATERAL (
                SELECT json_agg(y) AS lines FROM (
                  SELECT ii.deduction_type FROM public.invoice_items ii
                  WHERE ii.invoice_id = i.id AND ii.deduction_type IS NOT NULL
                ) y
              ) dl ON true
              WHERE i.company_id = $1 AND i.deduction_total > 0
              ORDER BY i.deduction_total ASC, i.id ASC LIMIT 1000 OFFSET 0`,
        values: [co],
      },
      usedBy: '/invoices: the deduction kinds of the invoices that carry a deduction',
    },
    {
      id: 'page.supplier_invoices.list',
      rpc: 'supplier_invoices',
      args: {},
      read: {
        sql: `SELECT s.*, row_to_json(su.*)::jsonb AS supplier
              FROM public.supplier_invoices s
              LEFT JOIN LATERAL (SELECT x.id, x.name FROM public.suppliers x WHERE x.id = s.supplier_id) su ON true
              WHERE s.company_id = $1
              ORDER BY s.due_date ASC, s.id ASC LIMIT 1000 OFFSET 0`,
        values: [co],
      },
      usedBy: '/supplier-invoices: GET /api/supplier-invoices?status=all, one page of its read',
    },
    {
      id: 'page.transactions.window',
      rpc: 'transactions',
      args: {},
      read: {
        sql: `SELECT t.*, public.is_booked(t) AS is_booked,
                     COALESCE(l.links, '[]') AS transaction_voucher_links, COALESCE(pc.parts, '[]') AS parts_count
              FROM public.transactions t
              LEFT JOIN LATERAL (
                SELECT json_agg(x) AS links FROM (
                  SELECT v.journal_entry_id, v.role, row_to_json(j.*) AS journal_entry
                  FROM public.transaction_voucher_links v
                  LEFT JOIN LATERAL (
                    SELECT je.voucher_series, je.voucher_number FROM public.journal_entries je WHERE je.id = v.journal_entry_id
                  ) j ON true
                  WHERE v.transaction_id = t.id
                ) x
              ) l ON true
              LEFT JOIN LATERAL (
                SELECT json_agg(y) AS parts FROM (
                  SELECT count(*) AS count FROM public.bank_transaction_parts p WHERE p.transaction_id = t.id
                ) y
              ) pc ON true
              WHERE t.company_id = $1
              ORDER BY t.date DESC, t.id ASC LIMIT 200 OFFSET 0`,
        values: [co],
      },
      usedBy: '/transactions: the window of the 200 newest bank rows',
    },
    {
      id: 'page.transactions.pending',
      rpc: 'transactions',
      args: {},
      read: {
        sql: `SELECT t.*, COALESCE(l.links, '[]') AS transaction_voucher_links, COALESCE(pc.parts, '[]') AS parts_count
              FROM public.transactions t
              LEFT JOIN LATERAL (
                SELECT json_agg(x) AS links FROM (
                  SELECT v.journal_entry_id, v.role, row_to_json(j.*) AS journal_entry
                  FROM public.transaction_voucher_links v
                  LEFT JOIN LATERAL (
                    SELECT je.voucher_series, je.voucher_number FROM public.journal_entries je WHERE je.id = v.journal_entry_id
                  ) j ON true
                  WHERE v.transaction_id = t.id
                ) x
              ) l ON true
              LEFT JOIN LATERAL (
                SELECT json_agg(y) AS parts FROM (
                  SELECT count(*) AS count FROM public.bank_transaction_parts p WHERE p.transaction_id = t.id
                ) y
              ) pc ON true
              WHERE t.company_id = $1 AND t.is_business IS NULL AND t.is_ignored = false
              ORDER BY t.date DESC, t.id ASC LIMIT 1000 OFFSET 0`,
        values: [co],
      },
      usedBy: '/transactions: the rows waiting to be booked, the list the page opens on',
    },
    {
      id: 'page.hem.overdue_invoices',
      rpc: 'invoices',
      args: {},
      read: {
        sql: `SELECT i.id, i.invoice_number, i.customer_id, i.status, i.due_date, i.total, i.total_sek,
                     i.remaining_amount, i.currency
              FROM public.invoices i
              WHERE i.company_id = $1 AND i.status = ANY('{sent,overdue,partially_paid}')
                AND i.document_type = 'invoice' AND i.credited_invoice_id IS NULL AND i.total >= 0
                AND i.remaining_amount > 0 AND i.due_date < $2
              ORDER BY i.due_date, i.id LIMIT 1000 OFFSET 0`,
        values: [co, ctx.today],
      },
      usedBy: 'Hem: the overdue invoices behind the Att göra row (lib/worklist), one page of its read',
    },

    // ---- statements: the trial balance in its closing modes ----
    {
      id: 'tb.ytd.include',
      rpc: 'get_trial_balance_aggregates',
      args: tb(open, 'include', open.start, ctx.today),
      usedBy: 'saldobalans, balansrapport, balansräkning, huvudbok overview',
    },
    {
      id: 'tb.ytd.exclude_all_year_end',
      rpc: 'get_trial_balance_aggregates',
      args: tb(open, 'exclude-all-year-end', open.start, ctx.today),
      usedBy: 'resultatrapport, resultaträkning, dimensionsresultat',
    },
    {
      id: 'tb.prior_ytd.exclude_all_year_end',
      rpc: 'get_trial_balance_aggregates',
      args: tb(prior, 'exclude-all-year-end', prior.start, sameDayYearBefore(ctx.today)),
      usedBy: 'resultatrapport: the same window last year',
    },
    {
      id: 'tb.year.include',
      rpc: 'get_trial_balance_aggregates',
      args: tb(open, 'include', null, null),
      usedBy: 'INK2, kund- and leverantörsreskontra avstämning, bokslut readiness',
    },
    {
      id: 'tb.year.exclude_all_year_end',
      rpc: 'get_trial_balance_aggregates',
      args: tb(open, 'exclude-all-year-end', null, null),
      usedBy: 'kassaflödesanalys, INK2 tax adjustments',
    },
    {
      id: 'tb.year.exclude_final',
      rpc: 'get_trial_balance_aggregates',
      args: tb(open, 'exclude-final', null, null),
      usedBy: 'INK2',
    },
    {
      id: 'tb.closed_year.include',
      rpc: 'get_trial_balance_aggregates',
      args: tb(prior, 'include', null, null),
      usedBy: 'årsredovisning 2025, statement reconciliation',
    },
    {
      id: 'tb.closed_year.exclude_final',
      rpc: 'get_trial_balance_aggregates',
      args: tb(prior, 'exclude-final', null, null),
      usedBy: 'årsredovisning 2025',
    },
    {
      id: 'tb.closed_year.to_balance_day',
      rpc: 'get_trial_balance_aggregates',
      args: tb(prior, 'include', null, prior.end),
      usedBy: 'bokslutsbilagor 2025, semesterskuld',
    },
    {
      id: 'opening_balances.prior_years',
      rpc: 'compute_prior_opening_balances',
      args: { p_company_id: co, p_period_start: open.start },
      usedBy: 'the IB of every trial balance, KPI and huvudbok request (no year has a linked IB verifikat)',
    },
    {
      id: 'latest_vouchers.resultatrapport',
      rpc: 'latest_posted_vouchers',
      args: { p_company_id: co, p_fiscal_period_id: open.id, ...ytd },
      usedBy: 'resultatrapport',
    },
    {
      id: 'latest_vouchers.balansrapport',
      rpc: 'latest_posted_vouchers',
      args: { p_company_id: co, p_fiscal_period_id: open.id, p_from_date: null, p_to_date: ctx.today },
      usedBy: 'balansrapport',
    },
    {
      id: 'kpi.aggregates',
      rpc: 'get_kpi_report_aggregates',
      args: { p_company_id: co, p_fiscal_period_id: open.id, p_ob_entry_id: open.obEntryId },
      usedBy: 'KPI',
    },
    {
      id: 'monthly_breakdown.aggregates',
      rpc: 'get_kpi_report_aggregates',
      args: { p_company_id: co, p_fiscal_period_id: open.id, p_ob_entry_id: null },
      usedBy: 'månadsöversikt (resultaträkning view)',
    },
    {
      id: 'kpi.paid_invoice_days',
      rpc: 'get_paid_invoice_days',
      args: { p_company_id: co, p_from: open.start, p_paid_before: addDays(open.end, 1) },
      usedBy: 'KPI',
    },
    {
      id: 'kpi.supplier_invoices',
      rpc: 'get_kpi_supplier_invoices',
      args: { p_company_id: co, p_from: open.start, p_to: open.end },
      usedBy: 'KPI',
    },
    {
      id: 'dimension_pnl.buckets',
      rpc: 'get_dimension_pnl_buckets',
      args: { p_company_id: co, p_fiscal_period_id: open.id, p_dim_no: '6', ...ytd },
      usedBy: 'dimensionsresultat (projekt)',
    },
    {
      id: 'dimension_cross.buckets',
      rpc: 'get_dimension_cross_buckets',
      args: { p_company_id: co, p_fiscal_period_id: open.id, p_dim_a: '1', p_dim_b: '6', ...ytd },
      usedBy: 'resultat per två dimensioner (kostnadsställe x projekt)',
    },
    {
      id: 'dimension_cross.cell_lines',
      rpc: 'get_dimension_cross_lines',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id, p_dim_a: '1', p_code_a: 'KS01', p_dim_b: '6', p_code_b: 'P001',
        p_account_from: null, p_account_to: null, ...ytd,
        p_after_date: null, p_after_voucher: null, p_after_line_id: null, p_limit: 200,
      },
      usedBy: 'resultat per två dimensioner: the lines of one cell, first page',
    },

    // ---- huvudbok and grundbok ----
    {
      id: 'huvudbok.line_counts',
      rpc: 'get_ledger_line_counts',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id, ...ytd, p_exclude_entry_id: open.obEntryId, p_dimensions: null,
      },
      usedBy: 'huvudbok overview',
    },
    {
      id: 'huvudbok.account_page',
      rpc: 'get_general_ledger_account_page',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id, p_account_number: '1930', ...ytd,
        p_exclude_entry_id: open.obEntryId, p_dimensions: null,
        p_after_date: null, p_after_voucher: null, p_after_line_id: null, p_limit: 500,
      },
      usedBy: 'huvudbok: the 1930 card, first page',
    },
    {
      id: 'huvudbok.account_page.later',
      rpc: 'get_general_ledger_account_page',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id, p_account_number: '1930', ...ytd,
        p_exclude_entry_id: open.obEntryId, p_dimensions: null,
        p_after_date: ctx.accountPageCursor.afterDate, p_after_voucher: ctx.accountPageCursor.afterVoucher,
        p_after_line_id: ctx.accountPageCursor.afterLineId, p_limit: 500,
      },
      usedBy: 'huvudbok: the 1930 card, Visa fler deep in the year',
    },
    {
      id: 'huvudbok.drilldown_lines',
      rpc: 'get_general_ledger_lines',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id,
        p_account_from: ctx.drilldownAccount, p_account_to: ctx.drilldownAccount, ...ytd,
        p_exclude_entry_id: open.obEntryId, p_dimensions: null,
      },
      usedBy: 'huvudbok overview for one account whose lines fit inline (drill-down from another report)',
    },
    {
      id: 'grundbok.page',
      rpc: 'get_journal_register_page',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id,
        p_after_series: null, p_after_number: null, p_after_id: null, p_limit: 201,
      },
      usedBy: 'grundbok, first page',
    },
    {
      id: 'grundbok.page.later',
      rpc: 'get_journal_register_page',
      args: {
        p_company_id: co, p_fiscal_period_id: open.id, p_after_series: ctx.registerCursor.afterSeries,
        p_after_number: ctx.registerCursor.afterNumber, p_after_id: ctx.registerCursor.afterId, p_limit: 201,
      },
      usedBy: 'grundbok, Visa fler deep in the year',
    },
    {
      id: 'grundbok.totals',
      rpc: 'get_journal_register_totals',
      args: { p_company_id: co, p_fiscal_period_id: open.id },
      usedBy: 'grundbok, first page',
    },

    // ---- reskontra ----
    {
      id: 'ar.ledger_invoices',
      rpc: 'get_ar_ledger_invoices',
      args: { p_company_id: co, p_as_of_date: null, p_customer_id: null },
      usedBy: 'kundreskontra (twice), KPI, bokslut readiness',
    },
    {
      id: 'ar.register_coverage',
      rpc: 'get_invoice_register_coverage',
      args: {
        p_company_id: co, p_ar_accounts: AR_ACCOUNTS, p_engine_source_types: INVOICE_ENGINE_SOURCE_TYPES,
        p_today: ctx.today, p_fiscal_period_id: null,
      },
      usedBy: 'kundreskontra, KPI',
    },
    {
      id: 'ar.register_coverage.period',
      rpc: 'get_invoice_register_coverage',
      args: {
        p_company_id: co, p_ar_accounts: AR_ACCOUNTS, p_engine_source_types: INVOICE_ENGINE_SOURCE_TYPES,
        p_today: ctx.today, p_fiscal_period_id: open.id,
      },
      usedBy: 'kundreskontra avstämning, bokslut readiness',
    },
    {
      id: 'ap.ledger_invoices',
      rpc: 'get_supplier_ledger_invoices',
      args: { p_company_id: co, p_as_of_date: null, p_supplier_id: null },
      usedBy: 'leverantörsreskontra (twice), bokslut readiness',
    },

    // ---- moms ----
    {
      id: 'vat.declaration_totals',
      rpc: 'get_vat_declaration_totals',
      args: {
        p_company_id: co, ...vatMonth,
        p_accounts: [...new Set([...VAT_ACCOUNTS, ...VAT_NET_ACCOUNTS, ...ctx.ownVatAccounts])],
        p_ruta_accounts: VAT_ACCOUNTS, p_net_accounts: VAT_NET_ACCOUNTS,
      },
      usedBy: 'momsdeklaration September, avräkningsförslag',
    },
    {
      id: 'vat.settlement_window',
      rpc: 'get_vat_declaration_totals',
      args: {
        p_company_id: co, p_start: '2026-10-01', p_end: addDays('2026-09-30', 400),
        p_accounts: [...VAT_ACCOUNTS, ...VAT_NET_ACCOUNTS],
        p_ruta_accounts: VAT_ACCOUNTS, p_net_accounts: VAT_NET_ACCOUNTS,
      },
      usedBy: 'avräkningsförslag: the late-settlement window after the period',
    },
    {
      id: 'vat.ruta_source_lines',
      rpc: 'get_vat_ruta_source_lines',
      args: {
        p_company_id: co, ...vatMonth,
        p_accounts: [...new Set([...RUTA_05_ACCOUNTS, ...ctx.ownVatAccounts.filter((a) => a.startsWith('3'))])],
        p_ruta_accounts: VAT_ACCOUNTS, p_net_accounts: VAT_NET_ACCOUNTS,
        p_cursor_date: null, p_cursor_voucher_number: null, p_cursor_entry_id: null, p_cursor_line_id: null,
        p_limit: 501,
      },
      usedBy: 'momsdeklaration: drill-down of ruta 05',
    },
    {
      id: 'vat.rc_basis_gaps',
      rpc: 'get_entries_with_account_lines',
      args: {
        p_company_id: co, p_start: vatMonth.p_start, p_end: vatMonth.p_end,
        p_accounts: ['2614', '2624', '2634'], p_statuses: ['posted'], p_all_lines: true,
      },
      usedBy: 'momsdeklaration: reverse-charge basis check',
    },
    {
      id: 'ps.eu_sales_entries',
      rpc: 'get_entries_with_account_lines',
      args: {
        p_company_id: co, p_start: '2026-10-01', p_end: '2026-12-31',
        p_accounts: ['3107', '3108', '3308'], p_statuses: ['posted', 'reversed'], p_all_lines: false,
      },
      usedBy: 'periodisk sammanställning, current quarter',
    },

    // ---- behandlingshistorik ----
    {
      id: 'audit.sources.month',
      rpc: 'behandlingshistorik_sources',
      args: {
        p_company_id: co, p_period_id: open.id, p_from: `${month.start}T00:00:00.000Z`,
        p_to: `${month.end}T23:59:59.999Z`, p_fiscal_year: false,
      },
      usedBy: 'behandlingshistorik, the default month',
    },
    {
      id: 'audit.decisions.month',
      rpc: 'behandlingshistorik_decisions',
      args: {
        p_company_id: co, p_period_id: open.id, p_from: `${month.start}T00:00:00.000Z`,
        p_to: `${month.end}T23:59:59.999Z`, p_fiscal_year: false,
      },
      usedBy: 'behandlingshistorik, the default month',
    },
    {
      id: 'audit.sources.year',
      rpc: 'behandlingshistorik_sources',
      args: {
        p_company_id: co, p_period_id: open.id, p_from: `${open.start}T00:00:00.000Z`,
        p_to: `${open.end}T23:59:59.999Z`, p_fiscal_year: true,
      },
      usedBy: 'behandlingshistorik, the whole year (one choice away; a separate project per !822)',
      heavy: true,
    },

    // ---- bank reconciliation and year end ----
    {
      id: 'reconciliation.facts.month',
      rpc: 'get_bank_reconciliation_facts',
      args: { ...bank, p_date_from: month.start, p_date_to: month.end },
      usedBy: 'avstämning 1930, the default month (list and account status)',
    },
    {
      id: 'reconciliation.facts.ytd',
      rpc: 'get_bank_reconciliation_facts',
      args: { ...bank, p_date_from: open.start, p_date_to: ctx.today },
      usedBy: 'Konton (/accounts) landing',
    },
    {
      id: 'reconciliation.items.month',
      rpc: 'get_bank_reconciliation_items',
      args: {
        ...bank, p_date_from: month.start, p_date_to: month.end, p_with_rows: true, p_with_ledger: true,
        p_matched_offset: 0, p_matched_limit: 200, p_matched_after_open: true,
      },
      usedBy: 'avstämning 1930: the items list',
    },
    {
      id: 'reconciliation.unexplained_bank_legs',
      rpc: 'get_unexplained_bank_legs',
      args: {
        p_company_id: co, p_account_number: '1930', p_low: ctx.openBankRows.low, p_high: ctx.openBankRows.high,
        p_own_transaction_ids: ctx.openBankRows.ids,
      },
      usedBy: 'avstämning 1930: the covering-set check of the open rows',
    },
    {
      id: 'bank.open_rows.month_count',
      rpc: 'open_bank_rows',
      args: {},
      read: {
        sql: `SELECT count(*) FROM public.open_bank_rows t
              WHERE t.company_id = $1 AND t.is_business IS NULL AND t.date >= $2 AND t.date <= $3`,
        values: [co, month.start, month.end],
      },
      usedBy: 'countUnbookedBankTransactions on a range: the period lock, data_status on every report read, the VAT close',
    },
    {
      id: 'bank.open_rows.count',
      rpc: 'open_bank_rows',
      args: {},
      read: {
        sql: `SELECT count(*) FROM public.open_bank_rows t WHERE t.company_id = $1 AND t.is_business IS NULL`,
        values: [co],
      },
      usedBy: 'countUnbookedBankTransactions with no range: Hem, the MCP briefing, recent activity',
    },
    {
      id: 'bank.open_rows.page',
      rpc: 'open_bank_rows',
      args: {},
      read: {
        sql: `SELECT t.id, t.date, t.amount FROM public.open_bank_rows t
              WHERE t.company_id = $1 ORDER BY t.date DESC, t.id LIMIT 501`,
        values: [co],
      },
      usedBy: 'GET /api/transactions?unmatched=true: Bokför direkt, the receipt matcher',
    },
    {
      id: 'bank.open_rows.oldest',
      rpc: 'open_bank_rows',
      args: {},
      read: {
        sql: `SELECT t.id, t.date, t.amount FROM public.open_bank_rows t
              WHERE t.company_id = $1 ORDER BY t.date ASC LIMIT 20`,
        values: [co],
      },
      usedBy: 'the MCP attention resource: the oldest open rows',
    },
    {
      id: 'bank.is_booked.page',
      rpc: 'is_booked',
      args: {},
      read: {
        sql: `SELECT t.id, public.is_booked(t) AS is_booked FROM public.transactions t
              WHERE t.company_id = $1 ORDER BY t.date DESC, t.id LIMIT 50`,
        values: [co],
      },
      usedBy: '/transactions: a page of bank rows',
    },
    {
      id: 'bank.is_booked.booked_page',
      rpc: 'is_booked',
      args: {},
      read: {
        sql: `SELECT t.id FROM public.transactions t
              WHERE t.company_id = $1 AND public.is_booked(t) = true
              ORDER BY t.date DESC, t.id LIMIT 501`,
        values: [co],
      },
      usedBy: 'GET /transactions?status=booked in v1, /api/transactions?reconciled=true',
    },
    {
      id: 'bank.balance_facts',
      rpc: 'get_bank_balance_facts',
      args: {
        p_company_id: co, p_cash_account_id: ctx.cashAccountId, p_include_unassigned: true, p_currency: 'SEK',
        p_through: ctx.today,
      },
      usedBy: 'the bank balance check, the rail',
    },
    {
      id: 'yearend.bank_facts',
      rpc: 'get_bank_reconciliation_facts',
      args: { ...bank, p_date_from: prior.start, p_date_to: prior.end },
      usedBy: 'bokslut readiness and checklist, bokslutsbilagor 2025',
    },
    {
      id: 'yearend.voucher_gaps',
      rpc: 'detect_voucher_gaps',
      args: { p_company_id: co, p_fiscal_period_id: prior.id, p_series: 'A' },
      usedBy: 'bokslut readiness, year-end preview, bokslutsbilagor',
    },
  ]
}
