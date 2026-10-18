/**
 * An in-memory company for the measure parity tests: tables answered by a
 * small PostgREST-shaped query builder that really filters, and the ledger
 * RPCs the report generators call (trial balance and KPI aggregates, the VAT
 * totals and ruta lines) computed from the same journal entries.
 *
 * The point is that a measure and the report it equals run against ONE
 * database: neither generator is mocked, so a measure that read the ledger
 * with other options than its report (another closing mode, another range,
 * another account set) would answer a different number here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface FakeLine {
  account_number: string
  debit?: number
  credit?: number
}

export interface FakeEntry {
  id: string
  entry_date: string
  voucher_series?: string
  voucher_number: number
  description: string
  source_type: string
  status?: 'posted' | 'reversed' | 'draft'
  fiscal_period_id: string
  lines: FakeLine[]
}

export interface FakeLedgerData {
  companyId: string
  jurisdiction?: string
  fiscalPeriods: Row[]
  chart: Array<{ account_number: string; account_name: string; account_class: number }>
  entries: FakeEntry[]
  invoices?: Row[]
  supplierInvoices?: Row[]
  cashAccounts?: Row[]
  kpiOverrides?: Record<string, string[]>
  /** Any other table the caller reads (the v1 door's company_members). */
  extraTables?: Record<string, Row[]>
}

export interface FakeFailures {
  /** Table name -> the error every read of it answers. */
  tables?: Record<string, { message: string; code?: string }>
  /** RPC name -> the error it answers. */
  rpcs?: Record<string, { message: string; code?: string }>
}

const LEDGER_STATUSES = new Set(['posted', 'reversed'])

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  return String(a) < String(b) ? -1 : 1
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown; count?: number | null }> {
  private filters: Array<(r: Row) => boolean> = []
  private orders: Array<{ col: string; asc: boolean }> = []
  private limitN?: number
  private rangeFrom?: number
  private rangeTo?: number
  private head = false
  private wantCount = false

  constructor(
    private readonly rows: Row[],
    private readonly failure?: { message: string; code?: string },
  ) {}

  select(_cols?: string, options?: { count?: string; head?: boolean }) {
    this.head = options?.head === true
    this.wantCount = options?.count !== undefined
    return this
  }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this }
  neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this }
  in(col: string, values: unknown[]) { this.filters.push((r) => values.includes(r[col])); return this }
  lte(col: string, v: unknown) { this.filters.push((r) => r[col] != null && compare(r[col], v) <= 0); return this }
  gte(col: string, v: unknown) { this.filters.push((r) => r[col] != null && compare(r[col], v) >= 0); return this }
  lt(col: string, v: unknown) { this.filters.push((r) => r[col] != null && compare(r[col], v) < 0); return this }
  gt(col: string, v: unknown) { this.filters.push((r) => r[col] != null && compare(r[col], v) > 0); return this }
  is(col: string, v: unknown) { this.filters.push((r) => (r[col] ?? null) === v); return this }
  not(col: string, op: string, value: unknown) {
    if (op === 'in' && typeof value === 'string') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, '').trim())
      this.filters.push((r) => !list.includes(String(r[col])))
    } else if (op === 'is') {
      this.filters.push((r) => (r[col] ?? null) !== value)
    }
    return this
  }
  // Filters the fixtures do not need to honour: both sides of a parity test
  // see the same rows either way.
  or() { return this }
  contains() { return this }
  ilike() { return this }
  filter() { return this }
  match() { return this }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this }
  limit(n: number) { this.limitN = n; return this }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this }

  private result(): { data: Row[] | null; error: unknown; count: number | null } {
    if (this.failure) return { data: null, error: this.failure, count: null }
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)))
    for (const { col, asc } of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => (asc ? compare(a[col], b[col]) : compare(b[col], a[col])))
    }
    const count = out.length
    if (this.rangeFrom !== undefined) out = out.slice(this.rangeFrom, (this.rangeTo ?? out.length) + 1)
    if (this.limitN !== undefined) out = out.slice(0, this.limitN)
    return { data: this.head ? null : out, error: null, count: this.wantCount ? count : null }
  }

  async single() {
    const r = this.result()
    if (r.error) return { data: null, error: r.error }
    const first = r.data?.[0]
    return first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
  }
  async maybeSingle() {
    const r = this.result()
    if (r.error) return { data: null, error: r.error }
    return { data: r.data?.[0] ?? null, error: null }
  }
  then<T1 = { data: unknown; error: unknown; count?: number | null }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected)
  }
}

/** Unknown builder methods answer the builder itself, like an ignored filter. */
function permissive(query: FakeQuery): FakeQuery {
  return new Proxy(query, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              const out = value.apply(target, args)
              return out === target ? receiver : out
            }
          : value
      }
      return () => receiver
    },
  })
}

export interface FakeLedger {
  supabase: SupabaseClient
  data: FakeLedgerData
}

export function createFakeLedger(data: FakeLedgerData, failures: FakeFailures = {}): FakeLedger {
  const companyId = data.companyId
  const entries = data.entries.map((e) => ({
    company_id: companyId,
    voucher_series: 'A',
    status: 'posted',
    ...e,
  }))
  let lineSeq = 0
  const lines: Row[] = entries.flatMap((e) =>
    e.lines.map((l) => {
      lineSeq += 1
      return {
        id: `00000000-0000-4000-9000-${String(lineSeq).padStart(12, '0')}`,
        journal_entry_id: e.id,
        account_number: l.account_number,
        debit_amount: l.debit ?? 0,
        credit_amount: l.credit ?? 0,
        dimensions: null,
      }
    }),
  )
  const entryById = new Map(entries.map((e) => [e.id, e]))

  const tables: Record<string, Row[]> = {
    fiscal_periods: data.fiscalPeriods.map((p) => ({ company_id: companyId, ...p })),
    chart_of_accounts: data.chart.map((a) => ({ company_id: companyId, ...a })),
    companies: [{ id: companyId, jurisdiction: data.jurisdiction ?? 'SE', entity_type: 'aktiebolag', ledger_currency: 'SEK' }],
    company_settings: [{ company_id: companyId, accounting_method: 'accrual', bookkeeping_locked_through: null }],
    journal_entries: entries.map(({ lines: _lines, ...e }) => e),
    journal_entry_lines: lines,
    invoices: (data.invoices ?? []).map((r) => ({ company_id: companyId, ...r })),
    supplier_invoices: (data.supplierInvoices ?? []).map((r) => ({ company_id: companyId, ...r })),
    cash_accounts: (data.cashAccounts ?? []).map((r) => ({ company_id: companyId, ...r })),
    extension_data: data.kpiOverrides
      ? [{ company_id: companyId, extension_id: 'core/kpi', key: 'preferences', value: { accountOverrides: data.kpiOverrides } }]
      : [],
    ...(data.extraTables ?? {}),
  }

  const periodOf = (id: unknown) => tables.fiscal_periods.find((p) => p.id === id) as
    | { id: string; period_start: string; period_end: string; opening_balance_entry_id?: string | null }
    | undefined

  /** Lines of ledger entries (posted/reversed) with their entry. */
  const ledgerLines = () =>
    lines
      .map((l) => ({ line: l, entry: entryById.get(l.journal_entry_id as string)! }))
      .filter(({ entry }) => LEDGER_STATUSES.has(entry.status))

  function sum(rows: Array<{ line: Row }>, key: (row: { line: Row }) => string | null) {
    const out = new Map<string, { debit: number; credit: number }>()
    for (const row of rows) {
      const k = key(row)
      if (k === null) continue
      const acc = out.get(k) ?? { debit: 0, credit: 0 }
      acc.debit += Number(row.line.debit_amount) || 0
      acc.credit += Number(row.line.credit_amount) || 0
      out.set(k, acc)
    }
    return out
  }

  const rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {
    get_trial_balance_aggregates(args) {
      const period = periodOf(args.p_fiscal_period_id)!
      const from = (args.p_from_date as string | null) ?? null
      const to = (args.p_to_date as string | null) ?? null
      const rows = ledgerLines().filter(({ entry }) => {
        if (entry.fiscal_period_id !== period.id || entry.id === args.p_exclude_entry_id) return false
        if (args.p_closing_mode === 'exclude-all-year-end' && entry.source_type === 'year_end') return false
        return true
      })
      const bucketOf = ({ line }: { line: Row }) => {
        const date = entryById.get(line.journal_entry_id as string)!.entry_date
        if (from && date < from) return date >= period.period_start ? 'rollforward' : null
        return date >= (from ?? period.period_start) && date <= (to ?? period.period_end) ? 'period' : null
      }
      const totals = sum(rows, (row) => {
        const bucket = bucketOf(row)
        return bucket ? `${bucket}|${row.line.account_number}` : null
      })
      return [...totals].map(([key, t]) => {
        const [bucket, account_number] = key.split('|')
        return { bucket, account_number, debit: t.debit, credit: t.credit }
      })
    },
    // The continuation-import fallback, simplified: balance-sheet accounts
    // (class 1-2) summed over every ledger entry before the period. The real
    // RPC also floors at an earlier IB verifikat; no fixture needs that here.
    compute_prior_opening_balances(args) {
      const before = args.p_period_start as string
      const totals = sum(
        ledgerLines().filter(({ entry }) => entry.entry_date < before),
        ({ line }) => (/^[12]/.test(String(line.account_number)) ? (line.account_number as string) : null),
      )
      return [...totals].map(([account_number, t]) => ({ account_number, debit: t.debit, credit: t.credit }))
    },
    get_kpi_report_aggregates(args) {
      const period = periodOf(args.p_fiscal_period_id)!
      const inPeriod = ledgerLines().filter(
        ({ entry }) => entry.fiscal_period_id === period.id && entry.id !== args.p_ob_entry_id,
      )
      const toRows = (m: Map<string, { debit: number; credit: number }>) =>
        [...m].map(([account_number, t]) => ({ account_number, debit: t.debit, credit: t.credit }))
      return {
        tb: toRows(sum(inPeriod, ({ line }) => line.account_number as string)),
        tb_ex_year_end: toRows(
          sum(inPeriod.filter(({ entry }) => entry.source_type !== 'year_end'), ({ line }) => line.account_number as string),
        ),
        ob: toRows(
          sum(
            ledgerLines().filter(({ entry }) => entry.id === args.p_ob_entry_id),
            ({ line }) => line.account_number as string,
          ),
        ),
        monthly: [],
      }
    },
    get_vat_declaration_totals(args) {
      const accounts = new Set(args.p_accounts as string[])
      const rows = vatLines(args).filter(({ line }) => accounts.has(line.account_number as string))
      const totals = sum(rows, ({ line }) => line.account_number as string)
      return {
        totals: [...totals].map(([account_number, t]) => ({ account_number, debit: t.debit, credit: t.credit })),
        settlement_shaped_entries: [],
        source_type_counts: {},
      }
    },
    get_vat_ruta_source_lines(args) {
      const accounts = new Set(args.p_accounts as string[])
      return vatLines(args)
        .filter(({ line }) => accounts.has(line.account_number as string))
        .sort((a, b) => compare(a.entry.entry_date, b.entry.entry_date) || a.entry.voucher_number - b.entry.voucher_number)
        .slice(0, Number(args.p_limit) || 501)
        .map(({ line, entry }) => ({
          line_id: line.id,
          journal_entry_id: entry.id,
          voucher_number: entry.voucher_number,
          voucher_series: entry.voucher_series,
          entry_date: entry.entry_date,
          description: entry.description,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
        }))
    },
  }

  /** The lines a momsdeklaration reads: the range, momsredovisningar left out (tagged ones; the fixtures have no shaped ones). */
  function vatLines(args: Record<string, unknown>) {
    return ledgerLines().filter(
      ({ entry }) =>
        entry.entry_date >= (args.p_start as string) &&
        entry.entry_date <= (args.p_end as string) &&
        entry.source_type !== 'vat_settlement',
    )
  }

  const supabase = {
    from(table: string) {
      return permissive(new FakeQuery(tables[table] ?? [], failures.tables?.[table]))
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const failure = failures.rpcs?.[name]
      if (failure) return { data: null, error: failure }
      const fn = rpcs[name]
      return { data: fn ? fn(args) : null, error: null }
    },
  }

  return { supabase: supabase as unknown as SupabaseClient, data }
}
