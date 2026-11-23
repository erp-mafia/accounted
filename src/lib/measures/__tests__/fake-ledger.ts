/**
 * An in-memory company for the measure parity tests: tables answered by a
 * small PostgREST-shaped query builder that really filters, and the ledger
 * RPCs the report generators call (trial balance and KPI aggregates, the VAT
 * totals and ruta lines) computed from the same journal entries. The
 * reskontra reads (get_ar_ledger_invoices and its kin) are the JS ports in
 * tests/reskontra-rpc-port.ts over the same tables.
 *
 * The point is that a measure and the report it equals run against ONE
 * database: neither generator is mocked, so a measure that read the ledger
 * with other options than its report (another closing mode, another range,
 * another account set) would answer a different number here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { reskontraRpcPorts } from '@/tests/reskontra-rpc-port'
import { roundOre } from '@/lib/money'

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
  /** The entry a storno reverses. */
  reverses_id?: string | null
  /** The entry a rättelse corrects. */
  correction_of_id?: string | null
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
  /**
   * Entries get_vat_declaration_totals classifies as a momsredovisning by
   * shape. The classification is the SQL's (pg-tested in
   * tests/pg/vat-skattekonto-counter-entries.pg.test.ts); a fixture states it.
   */
  vatShapedEntryIds?: string[]
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
  const shapedIds = new Set(data.vatShapedEntryIds ?? [])
  // The IB chain as get_vat_declaration_totals reads it (crm#1333): every
  // opening balance that is a balance (no resultatkonto line, class 3-8), and
  // every storno or rättelse of a member down the chain, each with the IB at
  // its root.
  const isResultAccount = (account: string) => ['3', '4', '5', '6', '7', '8'].includes(account.charAt(0))
  const ibRoot = new Map(
    entries
      .filter((e) => e.source_type === 'opening_balance' && !e.lines.some((l) => isResultAccount(l.account_number)))
      .map((e) => [e.id, e.id] as const),
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const e of entries) {
      if (ibRoot.has(e.id)) continue
      const root = [e.reverses_id, e.correction_of_id]
        .map((id) => (id ? ibRoot.get(id) : undefined))
        .find((r) => r !== undefined)
      if (root !== undefined) {
        ibRoot.set(e.id, root)
        grew = true
      }
    }
  }
  /**
   * An IB counts in a declaration when it is dated inside the range after its
   * first day and no other verifikat of the range is dated before it.
   */
  const ibCounts = (rootId: string, args: Record<string, unknown>) => {
    const root = entryById.get(rootId)!
    const start = args.p_start as string
    if (root.entry_date <= start || root.entry_date > (args.p_end as string)) return false
    return !entries.some(
      (e) =>
        LEDGER_STATUSES.has(e.status) &&
        !ibRoot.has(e.id) &&
        e.entry_date >= start &&
        e.entry_date < root.entry_date,
    )
  }
  /** Carried for the range: a chain member whose root IB does not count. */
  const carried = (id: string, args: Record<string, unknown>) => {
    const root = ibRoot.get(id)
    return root !== undefined && !ibCounts(root, args)
  }
  /** A fixture's shape is the SQL's decision, except that the IB chain is kept out of the shapes. */
  const shaped = (id: string) => shapedIds.has(id) && !ibRoot.has(id)

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
    ...reskontraRpcPorts({
      invoices: tables.invoices,
      customers: tables.customers,
      invoice_items: tables.invoice_items,
      invoice_payments: tables.invoice_payments,
      invoice_write_offs: tables.invoice_write_offs,
      rot_rut_payout_requests: tables.rot_rut_payout_requests,
      rot_rut_payout_request_items: tables.rot_rut_payout_request_items,
      journal_entries: tables.journal_entries,
      journal_entry_lines: tables.journal_entry_lines,
      supplier_invoices: tables.supplier_invoices,
      suppliers: tables.suppliers,
      supplier_invoice_payments: tables.supplier_invoice_payments,
    }),
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
    // The huvudbok's lines in report order: the period's posted and
    // reversed lines in the window and account range, the IB entry left out,
    // under the jsonb containment filter.
    get_general_ledger_lines(args) {
      const from = (args.p_from_date as string | null) ?? null
      const to = (args.p_to_date as string | null) ?? null
      const accountFrom = (args.p_account_from as string | null) ?? null
      const accountTo = (args.p_account_to as string | null) ?? null
      const dims = (args.p_dimensions as Record<string, unknown> | null) ?? null
      return ledgerLines()
        .filter(({ line, entry }) => {
          if (entry.fiscal_period_id !== args.p_fiscal_period_id || entry.id === args.p_exclude_entry_id) return false
          if ((from && entry.entry_date < from) || (to && entry.entry_date > to)) return false
          const account = line.account_number as string
          if ((accountFrom && account < accountFrom) || (accountTo && account > accountTo)) return false
          const tags = (line.dimensions as Record<string, unknown> | null) ?? {}
          return !dims || Object.entries(dims).every(([key, value]) => tags[key] === value)
        })
        .sort((a, b) =>
          compare(a.line.account_number, b.line.account_number) ||
          compare(a.entry.entry_date, b.entry.entry_date) ||
          a.entry.voucher_number - b.entry.voucher_number ||
          compare(a.line.id, b.line.id))
        .map(({ line, entry }) => ({
          line_id: line.id,
          account_number: line.account_number,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          dimensions: line.dimensions,
          journal_entry_id: entry.id,
          entry_date: entry.entry_date,
          voucher_series: entry.voucher_series,
          voucher_number: entry.voucher_number,
          description: entry.description,
          source_type: entry.source_type,
        }))
    },
    // The 'exclude-all-year-end' set, simplified like the trial balance
    // above: the period's year_end entries (no fixture undoes a bokslut or
    // books a resultatavslut outside the year-end run).
    year_end_chain_entry_ids(args) {
      return entries
        .filter((e) => e.fiscal_period_id === args.p_fiscal_period_id && e.source_type === 'year_end'
          && LEDGER_STATUSES.has(e.status))
        .map((e) => e.id)
        .sort()
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
        settlement_shaped_entries: entries
          .filter((e) => shaped(e.id) && LEDGER_STATUSES.has(e.status) && inRange(e, args))
          .map((e) => ({
            id: e.id,
            status: e.status,
            entry_date: e.entry_date,
            source_type: e.source_type,
            voucher_series: e.voucher_series,
            voucher_number: e.voucher_number,
          })),
        source_type_counts: {},
        counted_opening_balances: entries
          .filter((e) => ibRoot.get(e.id) === e.id && LEDGER_STATUSES.has(e.status) && inRange(e, args) && !carried(e.id, args))
          .map((e) => ({ id: e.id, status: e.status, entry_date: e.entry_date })),
      }
    },
    // public.account_ib_floor: the latest posted opening_balance verifikat on
    // a fiscal year's first day with a line on the account, through a date,
    // skipping a date whose two or more IB verifikat cancel on the account.
    account_ib_floor(args) {
      const through = (args.p_through as string | null) ?? null
      const yearStarts = new Set(data.fiscalPeriods.map((p) => p.period_start as string))
      const byDate = new Map<string, { amount: number; ids: Set<string> }>()
      for (const e of entries) {
        if (e.source_type !== 'opening_balance' || e.status !== 'posted') continue
        if ((through && e.entry_date > through) || !yearStarts.has(e.entry_date)) continue
        for (const l of e.lines) {
          if (l.account_number !== args.p_account_number) continue
          const group = byDate.get(e.entry_date) ?? { amount: 0, ids: new Set<string>() }
          group.amount += (l.debit ?? 0) - (l.credit ?? 0)
          group.ids.add(e.id)
          byDate.set(e.entry_date, group)
        }
      }
      const floors = [...byDate]
        .map(([date, g]) => ({ floor_date: date, amount: roundOre(g.amount), entry_ids: [...g.ids] }))
        .filter((g) => !(g.entry_ids.length >= 2 && g.amount === 0))
        .sort((a, b) => compare(b.floor_date, a.floor_date))
      return floors.slice(0, 1)
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

  function inRange(entry: { entry_date: string }, args: Record<string, unknown>) {
    return entry.entry_date >= (args.p_start as string) && entry.entry_date <= (args.p_end as string)
  }

  /**
   * The lines a momsdeklaration reads: the range, momsredovisningar left out
   * (tagged ones, and those the fixture names shaped), and the IB chains
   * whose root IB the declaration does not count.
   */
  function vatLines(args: Record<string, unknown>) {
    return ledgerLines().filter(
      ({ entry }) =>
        inRange(entry, args) &&
        entry.source_type !== 'vat_settlement' &&
        !shaped(entry.id) &&
        !carried(entry.id, args),
    )
  }

  const supabase = {
    from(table: string) {
      return permissive(new FakeQuery(tables[table] ?? [], failures.tables?.[table]))
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      const failure = failures.rpcs?.[name]
      const result = Promise.resolve(failure ? { data: null, error: failure } : { data: rpcs[name] ? rpcs[name](args) : null, error: null })
      // PostgREST's .maybeSingle() on a set-returning RPC: its one row, or null.
      return Object.assign(result, {
        maybeSingle: async () => {
          const { data: rows, error } = await result
          return { data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error }
        },
      })
    },
  }

  return { supabase: supabase as unknown as SupabaseClient, data }
}
