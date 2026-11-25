/**
 * JS ports of the reskontra reads over plain table rows, for unit tests that
 * answer `supabase.rpc(...)` from in-memory tables:
 *
 *   get_ar_ledger_invoices        20261023093950_ar_ledger_invoices_rpc.sql
 *   get_invoice_register_coverage 20261110100000_invoice_register_coverage_empty_register.sql
 *   get_supplier_ledger_invoices  20261023094010_supplier_ledger_invoices_rpc.sql
 *   get_paid_invoice_days         20261023094020_kpi_invoice_reads.sql
 *   get_kpi_supplier_invoices     20261023094020_kpi_invoice_reads.sql
 *
 * The ledger ports return the population the SQL documents, but keep the
 * paid invoices the SQL drops as provably settled and keep the rows in table
 * order (which stands in for id order). The reports must read the same
 * either way: tests/pg/reskontra-population-rpc.pg.test.ts runs the report
 * generators over the SQL and over these ports on the same books and
 * compares the reports.
 *
 * Fixture conveniences: a missing company_id is the company asked for, a
 * missing invoices.document_type is 'invoice', and a customer's (supplier's)
 * name comes from the customers (suppliers) table when one is given, else
 * from the row's own `customer` (`supplier`) embed.
 */
import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface ReskontraTables {
  invoices?: Row[]
  customers?: Row[]
  invoice_items?: Row[]
  invoice_payments?: Row[]
  invoice_write_offs?: Row[]
  rot_rut_payout_request_items?: Row[]
  rot_rut_payout_requests?: Row[]
  journal_entries?: Row[]
  journal_entry_lines?: Row[]
  supplier_invoices?: Row[]
  suppliers?: Row[]
  supplier_invoice_payments?: Row[]
  fiscal_periods?: Row[]
}

const AR_LIVE = ['sent', 'overdue', 'partially_paid', 'credited']
const AR_HISTORICAL = [...AR_LIVE, 'paid', 'written_off']
const AP_LIVE = ['registered', 'approved', 'partially_paid', 'overdue']
const AP_HISTORICAL = [...AP_LIVE, 'paid']

function rowsOf(tables: ReskontraTables, name: keyof ReskontraTables): Row[] {
  return tables[name] ?? []
}

function ofCompany(row: Row, companyId: unknown): boolean {
  return (row.company_id ?? companyId) === companyId
}

function nameFrom(table: Row[] | undefined, id: unknown, embed: unknown): string | null {
  if (table) {
    const hit = table.find((r) => r.id === id)
    return hit ? ((hit.name as string | null) ?? null) : null
  }
  const e = (Array.isArray(embed) ? embed[0] : embed) as { name?: string | null } | null | undefined
  return e?.name ?? null
}

function paymentFacts(payments: Row[], invoiceKey: string, invoiceId: unknown, companyId: unknown, asOf: string | null) {
  if (asOf === null) return { has_payment_rows: false, payment_amounts: null }
  const own = payments.filter((p) => p[invoiceKey] === invoiceId && ofCompany(p, companyId))
  return {
    has_payment_rows: own.length > 0,
    payment_amounts: own.length > 0
      ? own.filter((p) => String(p.payment_date) <= asOf).map((p) => p.amount)
      : null,
  }
}

function writtenOffAsOf(tables: ReskontraTables, companyId: unknown, invoiceId: unknown, asOf: string): boolean {
  const rows = rowsOf(tables, 'invoice_write_offs').filter(
    (w) => ofCompany(w, companyId) && String(w.entry_date) <= asOf,
  )
  return rows.some(
    (w) =>
      w.invoice_id === invoiceId &&
      w.kind === 'confirmed' &&
      !rows.some((a) => a.kind === 'annulled' && a.reverses_id === w.id),
  )
}

function postedOrReversed(e: Row): boolean {
  return e.status === 'posted' || e.status === 'reversed'
}

/** get_ar_ledger_invoices, without the early drop and in table order. */
/** registered_receivable_sek: a SEK row's posted verifikat on 151x, 1513 aside, else null. */
function registeredReceivable(tables: ReskontraTables, companyId: unknown, i: Row): number | null {
  if ((i.currency ?? 'SEK') !== 'SEK' || i.journal_entry_id == null) return null
  const entry = rowsOf(tables, 'journal_entries').find(
    (e) => e.id === i.journal_entry_id && ofCompany(e, companyId) && e.status === 'posted',
  )
  if (!entry) return null
  const lines = rowsOf(tables, 'journal_entry_lines').filter(
    (l) =>
      l.journal_entry_id === entry.id &&
      String(l.account_number).startsWith('151') &&
      l.account_number !== '1513',
  )
  if (lines.length === 0) return null
  const sum = lines.reduce((acc, l) => acc + Number(l.debit_amount ?? 0) - Number(l.credit_amount ?? 0), 0)
  return Math.round(sum * 100) / 100
}

export function portArLedgerInvoices(tables: ReskontraTables, args: Row): Row[] {
  const companyId = args.p_company_id
  const asOf = (args.p_as_of_date as string | null | undefined) ?? null
  const customerId = (args.p_customer_id as string | null | undefined) ?? null
  const invoices = rowsOf(tables, 'invoices')
  const payments = rowsOf(tables, 'invoice_payments')
  const entries = rowsOf(tables, 'journal_entries')
  const requests = rowsOf(tables, 'rot_rut_payout_requests')

  return invoices
    .filter((i) => {
      if (!ofCompany(i, companyId)) return false
      if ((i.document_type ?? 'invoice') !== 'invoice') return false
      if (customerId && i.customer_id !== customerId) return false
      const status = i.status as string
      if (asOf === null) {
        if (!AR_LIVE.includes(status) && !(status === 'paid' && Number(i.deduction_total) > 0)) return false
      } else if (!AR_HISTORICAL.includes(status) || String(i.invoice_date) > asOf) {
        return false
      }
      if (status === 'credited' && Number(i.total) < 0) return false
      if (asOf !== null && status === 'written_off' && writtenOffAsOf(tables, companyId, i.id, asOf)) return false
      return true
    })
    .map((i) => {
      const isCreditNote = Number(i.total) < 0 && i.journal_entry_id != null
      const hasDeduction = Number(i.deduction_total) > 0
      const engineEntry = entries
        .filter(
          (e) =>
            ofCompany(e, companyId) &&
            e.source_type === 'invoice_created' &&
            e.source_id === i.id &&
            postedOrReversed(e),
        )
        .sort(
          (a, b) =>
            String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
            String(b.id).localeCompare(String(a.id)),
        )[0]
      const linkedEntry = entries.find(
        (e) => ofCompany(e, companyId) && e.id === i.journal_entry_id && postedOrReversed(e),
      )
      const voucherOf = (e: Row | undefined) =>
        e
          ? { id: e.id, voucher_number: e.voucher_number, voucher_series: e.voucher_series ?? null, description: e.description ?? null }
          : null
      return {
        id: i.id,
        customer_id: i.customer_id ?? null,
        customer_name: nameFrom(tables.customers, i.customer_id, i.customer),
        invoice_number: i.invoice_number ?? null,
        external_invoice_number: i.external_invoice_number ?? null,
        invoice_date: i.invoice_date,
        due_date: i.due_date,
        status: i.status,
        total: i.total ?? null,
        paid_amount: i.paid_amount ?? null,
        currency: i.currency ?? null,
        exchange_rate: i.exchange_rate ?? null,
        deduction_total: i.deduction_total ?? 0,
        deduction_reclaimed_total: i.deduction_reclaimed_total ?? 0,
        paid_at: i.paid_at ?? null,
        journal_entry_id: i.journal_entry_id ?? null,
        registered_receivable_sek: registeredReceivable(tables, companyId, i),
        ...paymentFacts(payments, 'invoice_id', i.id, companyId, asOf),
        credit_links: isCreditNote
          ? payments
              .filter((l) => ofCompany(l, companyId) && l.journal_entry_id === i.journal_entry_id)
              .map((l) => {
                const paid = invoices.find((x) => x.id === l.invoice_id)
                return {
                  id: l.id ?? null,
                  invoice_id: l.invoice_id,
                  journal_entry_id: l.journal_entry_id,
                  amount: l.amount,
                  currency: l.currency ?? 'SEK',
                  payment_exchange_rate: l.payment_exchange_rate ?? null,
                  payment_date: l.payment_date,
                  invoice: paid ? { invoice_date: paid.invoice_date } : null,
                }
              })
          : null,
        payout_items: hasDeduction
          ? rowsOf(tables, 'rot_rut_payout_request_items')
              .filter((it) => it.invoice_id === i.id)
              .flatMap((it) => {
                const request = requests.find(
                  (r) => r.id === it.request_id && ofCompany(r, companyId) && r.settlement_journal_entry_id != null,
                )
                if (!request) return []
                const settlement = entries.find((e) => e.id === request.settlement_journal_entry_id)
                return [{
                  id: it.id ?? null,
                  decided_amount: it.decided_amount ?? null,
                  request_status: request.status,
                  settlement_entry_date: settlement ? (settlement.entry_date as string) : null,
                }]
              })
          : null,
        ...(customerId ? { voucher: voucherOf(engineEntry) ?? voucherOf(linkedEntry) } : {}),
      }
    })
}

/** get_supplier_ledger_invoices, without the early drop and in table order. */
export function portSupplierLedgerInvoices(tables: ReskontraTables, args: Row): Row[] {
  const companyId = args.p_company_id
  const asOf = (args.p_as_of_date as string | null | undefined) ?? null
  const supplierId = (args.p_supplier_id as string | null | undefined) ?? null
  const entries = rowsOf(tables, 'journal_entries')
  return rowsOf(tables, 'supplier_invoices')
    .filter((si) => {
      if (!ofCompany(si, companyId)) return false
      if (supplierId && si.supplier_id !== supplierId) return false
      const status = si.status as string
      return asOf === null
        ? AP_LIVE.includes(status)
        : AP_HISTORICAL.includes(status) && String(si.invoice_date) <= asOf
    })
    .map((si) => {
      const registration = entries.find(
        (e) => ofCompany(e, companyId) && e.id === si.registration_journal_entry_id && postedOrReversed(e),
      )
      return {
        id: si.id,
        supplier_id: si.supplier_id,
        supplier_name: nameFrom(tables.suppliers, si.supplier_id, si.supplier),
        supplier_invoice_number: si.supplier_invoice_number ?? null,
        arrival_number: si.arrival_number ?? null,
        invoice_date: si.invoice_date,
        due_date: si.due_date,
        status: si.status,
        total: si.total ?? 0,
        paid_amount: si.paid_amount ?? 0,
        remaining_amount: si.remaining_amount ?? 0,
        currency: si.currency ?? 'SEK',
        exchange_rate: si.exchange_rate ?? null,
        paid_at: si.paid_at ?? null,
        registration_journal_entry_id: si.registration_journal_entry_id ?? null,
        ...paymentFacts(rowsOf(tables, 'supplier_invoice_payments'), 'supplier_invoice_id', si.id, companyId, asOf),
        ...(supplierId
          ? {
              registration_entry: registration
                ? {
                    voucher_number: registration.voucher_number,
                    voucher_series: registration.voucher_series ?? null,
                    description: registration.description ?? null,
                    entry_date: registration.entry_date,
                  }
                : null,
            }
          : {}),
      }
    })
}

/** get_invoice_register_coverage. */
export function portInvoiceRegisterCoverage(tables: ReskontraTables, args: Row): Row {
  const companyId = args.p_company_id
  const register = rowsOf(tables, 'invoices').filter(
    (i) =>
      ofCompany(i, companyId) &&
      i.status != null &&
      i.status !== 'draft' &&
      (i.document_type ?? 'invoice') === 'invoice',
  )
  // An empty register is probed like one of registrations only: from today (crm#1759).
  const items = rowsOf(tables, 'invoice_items')
  const complete = register
    .filter((i) => i.journal_entry_id == null || items.some((it) => it.invoice_id === i.id))
    .map((i) => String(i.invoice_date))
    .sort()
  const coversFrom = complete[0] ?? (args.p_today as string)
  const arAccounts = args.p_ar_accounts as string[]
  const engineTypes = args.p_engine_source_types as string[]
  const lines = rowsOf(tables, 'journal_entry_lines')
  const probe = (periodId: unknown) =>
    rowsOf(tables, 'journal_entries').some(
      (e) =>
        ofCompany(e, companyId) &&
        (periodId == null || e.fiscal_period_id === periodId) &&
        e.status === 'posted' &&
        String(e.entry_date) < coversFrom &&
        !engineTypes.includes(e.source_type as string) &&
        lines.some(
          (l) =>
            l.journal_entry_id === e.id &&
            arAccounts.includes(l.account_number as string) &&
            Number(l.debit_amount) > 0,
        ),
    )
  const hasPre = probe(null)
  return {
    covers_from: coversFrom,
    has_pre_register_invoices: hasPre,
    pre_register_in_period: hasPre && args.p_fiscal_period_id != null ? probe(args.p_fiscal_period_id) : false,
  }
}

/** get_paid_invoice_days. */
export function portPaidInvoiceDays(tables: ReskontraTables, args: Row): Row {
  const from = Date.parse(`${args.p_from}T00:00:00Z`)
  const before = Date.parse(`${args.p_paid_before}T00:00:00Z`)
  let count = 0
  let days = 0
  for (const i of rowsOf(tables, 'invoices')) {
    if (!ofCompany(i, args.p_company_id) || i.status !== 'paid' || i.paid_at == null) continue
    const paid = new Date(String(i.paid_at)).getTime()
    if (!(paid >= from && paid < before)) continue
    count += 1
    days += Math.max(0, Math.floor((paid - new Date(String(i.invoice_date)).getTime()) / 86400000))
  }
  return { invoice_count: count, total_days: days }
}

/** get_kpi_supplier_invoices, in table order. */
export function portKpiSupplierInvoices(tables: ReskontraTables, args: Row): Row[] {
  return rowsOf(tables, 'supplier_invoices')
    .filter(
      (si) =>
        ofCompany(si, args.p_company_id) &&
        String(si.invoice_date) >= String(args.p_from) &&
        String(si.invoice_date) <= String(args.p_to) &&
        si.status !== 'credited',
    )
    .map((si) => ({
      supplier_id: si.supplier_id ?? null,
      supplier_name: nameFrom(tables.suppliers, si.supplier_id, si.supplier),
      total: si.total ?? null,
      total_sek: si.total_sek ?? null,
      currency: si.currency ?? null,
      exchange_rate: si.exchange_rate ?? null,
    }))
}

/** The ports by RPC name, for a mock's `rpc(name, args)`. */
export function reskontraRpcPorts(tables: ReskontraTables): Record<string, (args: Row) => unknown> {
  return {
    get_ar_ledger_invoices: (args) => portArLedgerInvoices(tables, args),
    get_supplier_ledger_invoices: (args) => portSupplierLedgerInvoices(tables, args),
    get_invoice_register_coverage: (args) => portInvoiceRegisterCoverage(tables, args),
    get_paid_invoice_days: (args) => portPaidInvoiceDays(tables, args),
    get_kpi_supplier_invoices: (args) => portKpiSupplierInvoices(tables, args),
  }
}

/**
 * The one table read the ledger makes beside its RPCs: the invoice each
 * credit note credits (lib/reports/credited-pairs.ts), by company and ids.
 * A failure keyed 'invoices' answers that error instead.
 */
export function creditedInvoiceRead(rows: Row[], failure: { message: string; code?: string } | undefined) {
  const filters: { companyId?: unknown; ids?: unknown[] } = {}
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      if (column === 'company_id') filters.companyId = value
      return chain
    },
    in: (column: string, values: unknown[]) => {
      if (column === 'id') filters.ids = values
      return chain
    },
    then: (resolve: (value: unknown) => void) => {
      if (failure) return resolve({ data: null, error: failure })
      const companyId = String(filters.companyId)
      const data = rows
        .filter((row) => (row.company_id ?? companyId) === companyId && (filters.ids ?? []).includes(row.id))
        .map((row) => ({ id: row.id, credited_invoice_id: row.credited_invoice_id ?? null }))
      return resolve({ data, error: null })
    },
  }
  return chain
}

/** select().eq('id').eq('company_id').maybeSingle() over the fiscal_periods rows. */
function fiscalPeriodRead(rows: Row[], failure: { message: string; code?: string } | undefined) {
  const filters: Row = {}
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters[column] = value
      return chain
    },
    maybeSingle: async () => {
      if (failure) return { data: null, error: failure }
      const hit = rows.find((row) => Object.entries(filters).every(([column, value]) => (row[column] ?? value) === value))
      return { data: hit ?? null, error: null }
    },
  }
  return chain
}

/**
 * A supabase client whose rpc() answers through the ports from the tables
 * `tables()` returns at call time, so a test can assign its books after the
 * client is made. Every call is recorded; a name in `failures()` answers
 * that error instead. Table reads are not expected and throw, except the
 * credit notes' originals (creditedInvoiceRead) and the reconciliations' read
 * of a fiscal year's last day.
 */
export function createReskontraClient(
  tables: () => ReskontraTables,
  failures: () => Record<string, { message: string; code?: string }> = () => ({}),
) {
  const calls: Array<{ name: string; args: Row }> = []
  const supabase = {
    rpc: vi.fn(async (name: string, args: Row = {}) => {
      calls.push({ name, args })
      const failure = failures()[name]
      if (failure) return { data: null, error: failure }
      const port = reskontraRpcPorts(tables())[name]
      if (!port) throw new Error(`createReskontraClient: no port for rpc ${name}`)
      return { data: port(args), error: null }
    }),
    from: vi.fn((table: string) => {
      if (table === 'invoices') return creditedInvoiceRead(tables().invoices ?? [], failures().invoices)
      if (table === 'fiscal_periods') return fiscalPeriodRead(tables().fiscal_periods ?? [], failures().fiscal_periods)
      throw new Error(`createReskontraClient: unexpected read of ${table}`)
    }),
  }
  return { supabase: supabase as unknown as SupabaseClient, calls }
}
