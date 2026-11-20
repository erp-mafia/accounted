/**
 * An in-memory ledger for report equivalence tests.
 *
 * The queue-based mocks answer reads in the order they are awaited, so two
 * implementations that read differently (a line walk and a trial balance)
 * cannot be run against the same books with them. This fake applies the
 * filters instead: it implements the slice of PostgREST the reports use over
 * plain arrays, plus JS ports of the ledger RPCs the reports call
 * (get_trial_balance_aggregates, result_closing_entry_ids,
 * year_end_chain_entry_ids, compute_prior_opening_balances,
 * get_entries_with_account_lines), so one set of
 * books can be read by any
 * implementation and the outputs compared byte for byte.
 *
 * Every awaited read is counted per table (`rpc:<name>` for RPCs), which is
 * how the tests measure the queries a report issues.
 *
 * Read-only: a write throws, so a report under test that starts writing
 * fails loudly instead of passing against stale data.
 */
import { vi } from 'vitest'

export type LedgerRow = Record<string, unknown>

/** PostgREST's max-rows: what one request returns without a smaller window. */
const MAX_ROWS = 1000

export interface LedgerFakeDbSeed {
  companyId: string
  /** Any table, keyed by name: fiscal_periods, chart_of_accounts, journal_entries, ... */
  tables: Record<string, LedgerRow[]>
}

type Filter = (row: LedgerRow) => boolean

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

/** One `or()` term: `col.is.null`, `col.not.in.(a,b)`, `col.eq.x`, `col.neq.x`. */
function orTerm(term: string): Filter {
  const [column, ...rest] = term.split('.')
  const op = rest.join('.')
  if (op === 'is.null') return (row) => row[column] === null || row[column] === undefined
  const notIn = op.match(/^not\.in\.\((.*)\)$/)
  if (notIn) {
    const values = notIn[1].split(',')
    return (row) => row[column] !== null && row[column] !== undefined && !values.includes(String(row[column]))
  }
  if (op.startsWith('eq.')) return (row) => String(row[column]) === op.slice(3)
  if (op.startsWith('neq.')) return (row) => row[column] != null && String(row[column]) !== op.slice(4)
  throw new Error(`ledger-fake-db: unsupported or() term ${term}`)
}

/** jsonb `@>` for the flat dimension maps the ledger stores. */
function contains(bag: unknown, filter: Record<string, unknown>): boolean {
  if (!bag || typeof bag !== 'object') return false
  return Object.entries(filter).every(([key, value]) => (bag as Record<string, unknown>)[key] === value)
}

const num = (value: unknown) => Number(value) || 0

export function createLedgerFakeDb(seed: LedgerFakeDbSeed) {
  const tables = seed.tables
  const rowsOf = (table: string) => (tables[table] ??= [])
  const counts = new Map<string, number>()
  const rowsRead = new Map<string, number>()
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  const read = <T extends { data: unknown }>(key: string, result: T): T => {
    const n = Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1
    rowsRead.set(key, (rowsRead.get(key) ?? 0) + n)
    return result
  }

  const from = (table: string) => {
    const filters: Filter[] = []
    const orders: Array<[string, boolean]> = []
    let window: [number, number] | null = null
    let limit: number | null = null
    let one: 'single' | 'maybeSingle' | null = null

    const execute = () => {
      count(table)
      const matched = rowsOf(table).filter((row) => filters.every((keep) => keep(row)))
      const ordered = [...matched].sort((a, b) => {
        for (const [column, ascending] of orders) {
          const c = compare(a[column], b[column])
          if (c !== 0) return ascending ? c : -c
        }
        return 0
      })
      const start = window ? window[0] : 0
      let end = window ? window[1] + 1 : start + MAX_ROWS
      if (limit !== null) end = Math.min(end, start + limit)
      end = Math.min(end, start + MAX_ROWS)
      const page = ordered.slice(start, end)
      if (one) {
        if (page.length === 0 && one === 'single') {
          return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
        }
        return read(table, { data: page[0] ?? null, error: null })
      }
      return read(table, { data: page, error: null })
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return builder
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] != null && row[column] !== value)
        return builder
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value)
        return builder
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]))
        return builder
      },
      not: (column: string, operator: string, value: string) => {
        const list = operator === 'in' ? value.match(/^\((.*)\)$/) : null
        if (!list) throw new Error(`ledger-fake-db: unsupported not() ${column} ${operator} ${value}`)
        const values = list[1].split(',')
        filters.push((row) => row[column] != null && !values.includes(String(row[column])))
        return builder
      },
      lt: (column: string, value: unknown) => {
        filters.push((row) => row[column] != null && compare(row[column], value) < 0)
        return builder
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => row[column] != null && compare(row[column], value) <= 0)
        return builder
      },
      gt: (column: string, value: unknown) => {
        filters.push((row) => row[column] != null && compare(row[column], value) > 0)
        return builder
      },
      gte: (column: string, value: unknown) => {
        filters.push((row) => row[column] != null && compare(row[column], value) >= 0)
        return builder
      },
      contains: (column: string, value: Record<string, unknown>) => {
        filters.push((row) => contains(row[column], value))
        return builder
      },
      or: (expression: string) => {
        const terms = expression.split(/,(?![^(]*\))/).map(orTerm)
        filters.push((row) => terms.some((keep) => keep(row)))
        return builder
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push([column, options?.ascending !== false])
        return builder
      },
      range: (start: number, end: number) => {
        window = [start, end]
        return builder
      },
      limit: (n: number) => {
        limit = n
        return builder
      },
      single: () => {
        one = 'single'
        return builder
      },
      maybeSingle: () => {
        one = 'maybeSingle'
        return builder
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve()
          .then(execute)
          .then(resolve, reject),
    }
    for (const write of ['insert', 'update', 'upsert', 'delete']) {
      builder[write] = () => {
        throw new Error(`ledger-fake-db is read-only: ${write} on ${table}`)
      }
    }
    return builder
  }

  // ── RPCs ────────────────────────────────────────────────────────────────

  const entriesOf = (companyId: unknown) =>
    rowsOf('journal_entries').filter((entry) => entry.company_id === companyId)
  const linesOf = (entryIds: Set<unknown>) =>
    rowsOf('journal_entry_lines').filter((line) => entryIds.has(line.journal_entry_id))
  const linesByEntry = () => {
    const byEntry = new Map<unknown, LedgerRow[]>()
    for (const line of rowsOf('journal_entry_lines')) {
      const list = byEntry.get(line.journal_entry_id)
      if (list) list.push(line)
      else byEntry.set(line.journal_entry_id, [line])
    }
    return byEntry
  }
  const periodOf = (companyId: unknown, periodId: unknown) =>
    rowsOf('fiscal_periods').find((p) => p.id === periodId && p.company_id === companyId)

  /** Port of result_closing_entry_ids (migration 20260924202408). */
  function resultClosingEntryIds(companyId: unknown, periodId: unknown): string[] {
    const period = periodOf(companyId, periodId)
    if (!period) return []
    const ids = new Set<string>()
    const linked = entriesOf(companyId).find((e) => e.id === period.closing_entry_id && e.status === 'posted')
    if (linked) ids.add(String(linked.id))
    const isResult = (account: string) => account >= '3' && account < '9'
    const isEquity = (account: string) => ['2099', '2019', '2069'].includes(account)
    const byEntry = linesByEntry()
    for (const entry of entriesOf(companyId)) {
      if (entry.fiscal_period_id !== periodId || entry.entry_date !== period.period_end) continue
      if (entry.status !== 'posted' || entry.reverses_id != null) continue
      const accounts = (byEntry.get(entry.id) ?? []).map((line) => String(line.account_number))
      if (accounts.length === 0) continue
      if (
        accounts.every((a) => isResult(a) || isEquity(a)) &&
        accounts.some(isEquity) &&
        accounts.some(isResult)
      ) {
        ids.add(String(entry.id))
      }
    }
    return [...ids].sort()
  }

  /**
   * Port of year_end_chain_entry_ids (migration 20261024140100): the year_end
   * entries of the period, the storno/correction of a reversed one, and a
   * resultatavslut by shape (resultClosingEntryIds) that books a result
   * account outside 8990-8999 and leaves every such account at zero.
   */
  function yearEndChainEntryIds(companyId: unknown, periodId: unknown): string[] {
    const entries = entriesOf(companyId)
    const yeReversed = new Set(
      entries.filter((e) => e.source_type === 'year_end' && e.status === 'reversed').map((e) => e.id),
    )
    const inPeriod = entries.filter(
      (e) => e.fiscal_period_id === periodId && (e.status === 'posted' || e.status === 'reversed'),
    )
    const ids = new Set(
      inPeriod
        .filter(
          (e) =>
            e.source_type === 'year_end' ||
            (e.reverses_id != null && yeReversed.has(e.reverses_id)) ||
            (e.correction_of_id != null && yeReversed.has(e.correction_of_id)),
        )
        .map((e) => String(e.id)),
    )
    const isRegularResult = (account: string) => account >= '3' && account < '8990'
    const byEntry = linesByEntry()
    const balanceOf = (account: string) => {
      let net = 0
      for (const entry of inPeriod) {
        for (const line of byEntry.get(entry.id) ?? []) {
          if (String(line.account_number) === account) net += num(line.credit_amount) - num(line.debit_amount)
        }
      }
      return net
    }
    for (const id of resultClosingEntryIds(companyId, periodId)) {
      if (ids.has(id)) continue
      const accounts = (byEntry.get(id) ?? []).map((line) => String(line.account_number)).filter(isRegularResult)
      if (accounts.length > 0 && accounts.every((account) => Math.abs(balanceOf(account)) < 0.005)) ids.add(id)
    }
    return [...ids].sort()
  }

  /** Port of get_trial_balance_aggregates (migration 20261024140100). */
  function trialBalanceAggregates(args: Record<string, unknown>) {
    const companyId = args.p_company_id
    const period = periodOf(companyId, args.p_fiscal_period_id)
    const mode = args.p_closing_mode
    const fromDate = (args.p_from_date as string | null) ?? null
    const toDate = (args.p_to_date as string | null) ?? null
    let excluded = new Set<string>()
    if (mode === 'exclude-final') {
      if (period?.is_closed === true && !period.closing_entry_id && period.closed_externally !== true) {
        return {
          data: null,
          error: {
            code: '23514',
            message:
              'Closed fiscal period is missing closing_entry_id; statutory pre-closing balances cannot be generated safely',
          },
        }
      }
      excluded = new Set(resultClosingEntryIds(companyId, args.p_fiscal_period_id))
    }
    if (mode === 'exclude-all-year-end') {
      for (const id of yearEndChainEntryIds(companyId, args.p_fiscal_period_id)) excluded.add(id)
    }
    const rollStart =
      fromDate && period && fromDate > String(period.period_start) ? String(period.period_start) : null
    const buckets = new Map<unknown, string>()
    for (const entry of entriesOf(companyId)) {
      if (entry.fiscal_period_id !== args.p_fiscal_period_id) continue
      if (entry.status !== 'posted' && entry.status !== 'reversed') continue
      if (args.p_exclude_entry_id && entry.id === args.p_exclude_entry_id) continue
      if (excluded.has(String(entry.id))) continue
      const date = String(entry.entry_date)
      let bucket: string | null = null
      if (rollStart && date >= rollStart && fromDate && date < fromDate) bucket = 'rollforward'
      else if ((!fromDate || date >= fromDate) && (!toDate || date <= toDate)) bucket = 'period'
      if (bucket) buckets.set(entry.id, bucket)
    }
    const sums = new Map<string, { bucket: string; account_number: string; debit: number; credit: number }>()
    for (const line of linesOf(new Set(buckets.keys()))) {
      if (args.p_dimensions && !contains(line.dimensions, args.p_dimensions as Record<string, unknown>)) continue
      const bucket = buckets.get(line.journal_entry_id)!
      const key = `${bucket}|${line.account_number}`
      const sum = sums.get(key) ?? { bucket, account_number: String(line.account_number), debit: 0, credit: 0 }
      // numeric sums are exact in SQL: add in öre so the port is exact too
      sum.debit = Math.round(sum.debit * 100 + num(line.debit_amount) * 100) / 100
      sum.credit = Math.round(sum.credit * 100 + num(line.credit_amount) * 100) / 100
      sums.set(key, sum)
    }
    const data = [...sums.values()].sort(
      (a, b) => compare(a.bucket, b.bucket) || compare(a.account_number, b.account_number),
    )
    return { data, error: null }
  }

  /**
   * compute_prior_opening_balances, simplified: the class 1-2 net of every
   * posted or reversed line dated before the period. The production rule for
   * picking the earliest IB entry only matters for books with several IB
   * entries per account; fixtures here have at most one.
   */
  function priorOpeningBalances(args: Record<string, unknown>) {
    const ids = new Set(
      entriesOf(args.p_company_id)
        .filter(
          (e) =>
            (e.status === 'posted' || e.status === 'reversed') &&
            String(e.entry_date) < String(args.p_period_start),
        )
        .map((e) => e.id),
    )
    const sums = new Map<string, { account_number: string; debit: number; credit: number }>()
    for (const line of linesOf(ids)) {
      const account = String(line.account_number)
      if (account[0] !== '1' && account[0] !== '2') continue
      const sum = sums.get(account) ?? { account_number: account, debit: 0, credit: 0 }
      sum.debit = Math.round(sum.debit * 100 + num(line.debit_amount) * 100) / 100
      sum.credit = Math.round(sum.credit * 100 + num(line.credit_amount) * 100) / 100
      sums.set(account, sum)
    }
    return { data: [...sums.values()].sort((a, b) => compare(a.account_number, b.account_number)), error: null }
  }

  /** Port of get_entries_with_account_lines (migration 20261023094040). */
  function entriesWithAccountLines(args: Record<string, unknown>) {
    const accounts = new Set((args.p_accounts as string[]) ?? [])
    const statuses = new Set((args.p_statuses as string[]) ?? [])
    const start = String(args.p_start)
    const end = String(args.p_end)
    const allLines = args.p_all_lines === true
    const lines = rowsOf('journal_entry_lines')
    const entries = rowsOf('journal_entries')
      .filter(
        (entry) =>
          entry.company_id === args.p_company_id &&
          (entry.status === 'posted' || entry.status === 'reversed') &&
          statuses.has(String(entry.status)) &&
          String(entry.entry_date) >= start &&
          String(entry.entry_date) <= end &&
          lines.some((line) => line.journal_entry_id === entry.id && accounts.has(String(line.account_number))),
      )
      .sort((a, b) => compare(a.id, b.id))
    return {
      data: entries.map((entry) => ({
        id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
        entry_date: entry.entry_date,
        description: entry.description ?? null,
        status: entry.status,
        source_type: entry.source_type ?? null,
        source_id: entry.source_id ?? null,
        reverses_id: entry.reverses_id ?? null,
        correction_of_id: entry.correction_of_id ?? null,
        lines: lines
          .filter((line) => line.journal_entry_id === entry.id && (allLines || accounts.has(String(line.account_number))))
          .sort((a, b) => compare(a.account_number, b.account_number) || compare(a.sort_order, b.sort_order) || compare(a.id, b.id))
          .map((line) => ({
            id: line.id,
            account_number: line.account_number,
            debit_amount: line.debit_amount,
            credit_amount: line.credit_amount,
          })),
      })),
      error: null,
    }
  }

  const rpc = (name: string, args: Record<string, unknown> = {}) => {
    count(`rpc:${name}`)
    return Promise.resolve(read(`rpc:${name}`, answer(name, args)))
  }

  const answer = (name: string, args: Record<string, unknown>): { data: unknown; error: unknown } => {
    switch (name) {
      case 'acquire_sie_period_read':
        return { data: 'read-lease', error: null }
      case 'finish_sie_period_read':
        return { data: true, error: null }
      case 'get_trial_balance_aggregates':
        return trialBalanceAggregates(args)
      case 'result_closing_entry_ids':
        return { data: resultClosingEntryIds(args.p_company_id, args.p_fiscal_period_id), error: null }
      case 'year_end_chain_entry_ids':
        return { data: yearEndChainEntryIds(args.p_company_id, args.p_fiscal_period_id), error: null }
      case 'compute_prior_opening_balances':
        return priorOpeningBalances(args)
      case 'get_entries_with_account_lines':
        return entriesWithAccountLines(args)
      default:
        throw new Error(`ledger-fake-db: unsupported rpc ${name}`)
    }
  }

  const supabase = {
    from: vi.fn(from),
    rpc: vi.fn(rpc),
  }

  return {
    supabase,
    tables,
    /** Reads per table (`rpc:<name>` for RPCs) since the last reset. */
    counts: () => Object.fromEntries([...counts.entries()].sort(([a], [b]) => compare(a, b))),
    /** Every read since the last reset. */
    total: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
    /** Rows returned per table (`rpc:<name>` for RPCs) since the last reset. */
    rowsRead: () => Object.fromEntries([...rowsRead.entries()].sort(([a], [b]) => compare(a, b))),
    resetCounts: () => {
      counts.clear()
      rowsRead.clear()
    },
  }
}

export type LedgerFakeDb = ReturnType<typeof createLedgerFakeDb>
