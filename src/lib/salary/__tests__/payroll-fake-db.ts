/**
 * In-memory tables for the salary-run golden fixture.
 *
 * The queue-based mocks answer queries in the order they are awaited, so they
 * pin HOW a calculation talks to the database, not WHAT it leaves behind. A
 * fixture that must survive a change of query shape (per employee to once
 * per run) needs the opposite: this fake applies the filters, embeds and
 * writes the calculation uses to plain arrays, so the same scenario can be
 * run against any query plan and the stored rows compared.
 *
 * PostgREST behaviour it keeps, because a difference here would hide a real
 * bug:
 *   - a read returns at most 1000 rows unless `.range()` pages it;
 *   - SQL comparison semantics: NULL never matches eq/neq/gt/lt/in;
 *   - a multi-row insert or upsert sends the union of the rows' keys, and a
 *     row without one of them writes NULL (supabase-js `defaultToNull`);
 *     `undefined` values are dropped like JSON drops them;
 *   - an upsert checks NOT NULL on the proposed row before it resolves the
 *     conflict, so a partial upsert payload fails as it does in Postgres.
 *
 * Every executed statement is recorded in `queries`, which is what the
 * query-count measurements read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'not_is'

interface Condition {
  path: string
  op: Op
  value: unknown
}

type Filter = { kind: 'and'; condition: Condition } | { kind: 'or'; conditions: Condition[] }

interface Relation {
  table: string
  kind: 'one' | 'many'
  localKey: string
  foreignKey: string
}

/** The embeds the salary calculation reads, by parent table and target table. */
const RELATIONS: Record<string, Record<string, Relation>> = {
  salary_run_employees: {
    employees: { table: 'employees', kind: 'one', localKey: 'employee_id', foreignKey: 'id' },
    salary_line_items: {
      table: 'salary_line_items',
      kind: 'many',
      localKey: 'id',
      foreignKey: 'salary_run_employee_id',
    },
    salary_runs: { table: 'salary_runs', kind: 'one', localKey: 'salary_run_id', foreignKey: 'id' },
  },
}

/** NOT NULL columns without a default, checked on every proposed row. */
const NOT_NULL: Record<string, string[]> = {
  salary_run_employees: [
    'salary_run_id',
    'employee_id',
    'company_id',
    'employment_degree',
    'monthly_salary',
    'salary_type',
  ],
  salary_line_items: ['salary_run_employee_id', 'company_id', 'item_type', 'description', 'amount'],
}

const MAX_ROWS = 1000

interface SelectItem {
  kind: 'star' | 'column' | 'embed'
  name: string
  alias?: string
  inner?: boolean
  children?: SelectItem[]
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseSelect(input: string): SelectItem[] {
  return splitTopLevel(input).map((part) => {
    if (part === '*') return { kind: 'star', name: '*' }
    const open = part.indexOf('(')
    if (open === -1) return { kind: 'column', name: part }
    const head = part.slice(0, open)
    const body = part.slice(open + 1, part.lastIndexOf(')'))
    const [aliasOrTable, maybeTable] = head.includes(':') ? head.split(':') : [head, head]
    const tableSpec = maybeTable ?? aliasOrTable
    const [table, hint] = tableSpec.split('!')
    return {
      kind: 'embed',
      name: table,
      alias: head.includes(':') ? aliasOrTable : table,
      inner: hint === 'inner',
      children: parseSelect(body),
    }
  })
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function readPath(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || value === undefined) return undefined
    return (value as Row)[key]
  }, row)
}

function matches(row: Row, condition: Condition): boolean {
  const value = readPath(row, condition.path)
  switch (condition.op) {
    case 'is':
      return condition.value === null ? value === null || value === undefined : value === condition.value
    case 'not_is':
      return condition.value === null ? value !== null && value !== undefined : value !== condition.value
    case 'in':
      return (
        value !== null &&
        value !== undefined &&
        (condition.value as unknown[]).some((candidate) => compare(value, candidate) === 0)
      )
    default:
      break
  }
  if (value === null || value === undefined || condition.value === null) return false
  const order = compare(value, condition.value)
  switch (condition.op) {
    case 'eq':
      return order === 0
    case 'neq':
      return order !== 0
    case 'gt':
      return order > 0
    case 'gte':
      return order >= 0
    case 'lt':
      return order < 0
    case 'lte':
      return order <= 0
  }
}

/** `col.op.value` conditions of a PostgREST `or=(...)` filter (flat lists only). */
function parseOr(expression: string): Condition[] {
  return splitTopLevel(expression).map((part) => {
    const [path, op, ...rest] = part.split('.')
    const raw = rest.join('.')
    if (op === 'is') return { path, op: 'is', value: raw === 'null' ? null : raw === 'true' }
    if (op === 'in') return { path, op: 'in', value: raw.replace(/^\(|\)$/g, '').split(',') }
    return { path, op: op as Op, value: raw }
  })
}

/** JSON round trip: what actually reaches PostgREST. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface QueryRecord {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  rows: number
}

export interface PayrollFakeDbOptions {
  /** Answer this statement with a database error instead of running it. */
  failOn?: (query: { table: string; op: QueryRecord['op'] }) => boolean
  /** Called as each statement starts: a test can change rows in between. */
  beforeStatement?: (query: { table: string; op: QueryRecord['op'] }) => void
}

export function createPayrollFakeDb(seed: Record<string, Row[]>, options: PayrollFakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => wire(row))
  const queries: QueryRecord[] = []
  let sequence = 0
  const nextId = (table: string) => {
    sequence += 1
    return `${table}-new-${String(sequence).padStart(4, '0')}`
  }

  const notNullViolation = (table: string, row: Row) => {
    const column = (NOT_NULL[table] ?? []).find((c) => row[c] === null || row[c] === undefined)
    return column
      ? { code: '23502', message: `null value in column "${column}" of relation "${table}" violates not-null constraint` }
      : null
  }

  /** The rows a multi-row write proposes: union of keys, missing = NULL. */
  const proposedRows = (values: Row | Row[]): Row[] => {
    if (!Array.isArray(values)) return [wire(values)]
    const columns = [...new Set(values.flatMap((row) => Object.keys(row)))]
    return values.map((row) => {
      const sent = wire(row)
      return Object.fromEntries(columns.map((c) => [c, sent[c] === undefined ? null : sent[c]]))
    })
  }

  const project = (table: string, row: Row, items: SelectItem[]): Row | null => {
    const out: Row = {}
    for (const item of items) {
      if (item.kind === 'star') Object.assign(out, wire(row))
      else if (item.kind === 'column') out[item.name] = row[item.name] === undefined ? null : wire(row[item.name])
      else {
        const relation = RELATIONS[table]?.[item.name]
        if (!relation) throw new Error(`payroll-fake-db: no relation ${table} -> ${item.name}`)
        const targets = (tables[relation.table] ?? []).filter(
          (candidate) => candidate[relation.foreignKey] === row[relation.localKey],
        )
        const projected = targets.map((target) => project(relation.table, target, item.children ?? []) as Row)
        out[item.alias ?? item.name] = relation.kind === 'one' ? (projected[0] ?? null) : projected
      }
    }
    return out
  }

  const from = (table: string) => {
    const store = (tables[table] ??= [])
    let op: QueryRecord['op'] = 'select'
    let selectItems: SelectItem[] | null = null
    let payload: Row | Row[] | null = null
    let onConflict = 'id'
    const filters: Filter[] = []
    const orders: Array<{ column: string; ascending: boolean }> = []
    let range: [number, number] | null = null
    let limit: number | null = null
    let single: 'single' | 'maybeSingle' | null = null

    const rowMatches = (row: Row) =>
      filters.every((filter) =>
        filter.kind === 'and' ? matches(row, filter.condition) : filter.conditions.some((c) => matches(row, c)),
      )

    const shape = (rows: Row[]) => {
      if (single) {
        if (rows.length === 1) return { data: rows[0], error: null }
        if (rows.length === 0 && single === 'maybeSingle') return { data: null, error: null }
        return { data: null, error: { code: 'PGRST116', message: `expected one row, got ${rows.length}` } }
      }
      return { data: rows, error: null }
    }

    const execute = () => {
      options.beforeStatement?.({ table, op })
      if (options.failOn?.({ table, op })) {
        queries.push({ table, op, rows: 0 })
        return { data: null, error: { code: 'XX000', message: `injected failure: ${op} ${table}` } }
      }
      if (op === 'select') {
        const items = selectItems ?? [{ kind: 'star' as const, name: '*' }]
        const embeds = items.filter((item) => item.kind === 'embed')
        // Filters and orders see the whole row plus its embeds, whatever the
        // select list projects.
        let views = store
          .map((row) => ({ row, view: { ...wire(row), ...project(table, row, embeds) } as Row }))
          .filter(({ view }) => embeds.every((item) => !item.inner || view[item.alias ?? item.name] !== null))
          .filter(({ view }) => rowMatches(view))
        for (const order of [...orders].reverse()) {
          views = [...views].sort((a, b) => {
            const av = a.view[order.column]
            const bv = b.view[order.column]
            if (av === bv) return 0
            if (av === null || av === undefined) return 1
            if (bv === null || bv === undefined) return -1
            return order.ascending ? compare(av, bv) : compare(bv, av)
          })
        }
        const start = range ? range[0] : 0
        const end = Math.min(
          range ? range[1] + 1 : start + MAX_ROWS,
          start + MAX_ROWS,
          limit !== null ? start + limit : Infinity,
        )
        const rows = views.slice(start, end).map(({ row }) => project(table, row, items) as Row)
        queries.push({ table, op, rows: rows.length })
        return shape(rows)
      }

      if (op === 'insert' || op === 'upsert') {
        const proposed = proposedRows(payload as Row | Row[])
        for (const row of proposed) {
          const violation = notNullViolation(table, row)
          if (violation) {
            queries.push({ table, op, rows: 0 })
            return { data: null, error: violation }
          }
        }
        const written: Row[] = []
        const conflictColumns = onConflict.split(',').map((c) => c.trim())
        for (const row of proposed) {
          const existing =
            op === 'upsert'
              ? store.find((candidate) => conflictColumns.every((c) => row[c] !== undefined && candidate[c] === row[c]))
              : undefined
          if (existing) {
            Object.assign(existing, row)
            written.push(existing)
          } else {
            const inserted = { ...row, id: row.id ?? nextId(table) }
            store.push(inserted)
            written.push(inserted)
          }
        }
        queries.push({ table, op, rows: written.length })
        return selectItems ? shape(written.map((row) => wire(row))) : { data: null, error: null }
      }

      if (op === 'update') {
        const patch = wire(payload as Row)
        const updated = store.filter(rowMatches)
        for (const row of updated) Object.assign(row, patch)
        queries.push({ table, op, rows: updated.length })
        return selectItems ? shape(updated.map((row) => wire(row))) : { data: null, error: null }
      }

      // In place: several statements against one table may be in flight at
      // once, as against the real database.
      const removed = store.filter(rowMatches)
      for (let i = store.length - 1; i >= 0; i--) {
        if (removed.includes(store[i])) store.splice(i, 1)
      }
      queries.push({ table, op, rows: removed.length })
      return { data: null, error: null }
    }

    const builder: Record<string, unknown> = {
      select(columns?: string) {
        selectItems = parseSelect(columns ?? '*')
        return builder
      },
      insert(values: Row | Row[]) {
        op = 'insert'
        payload = values
        return builder
      },
      upsert(values: Row | Row[], options?: { onConflict?: string }) {
        op = 'upsert'
        payload = values
        if (options?.onConflict) onConflict = options.onConflict
        return builder
      },
      update(values: Row) {
        op = 'update'
        payload = values
        return builder
      },
      delete() {
        op = 'delete'
        return builder
      },
      eq: (path: string, value: unknown) => add({ path, op: 'eq', value }),
      neq: (path: string, value: unknown) => add({ path, op: 'neq', value }),
      gt: (path: string, value: unknown) => add({ path, op: 'gt', value }),
      gte: (path: string, value: unknown) => add({ path, op: 'gte', value }),
      lt: (path: string, value: unknown) => add({ path, op: 'lt', value }),
      lte: (path: string, value: unknown) => add({ path, op: 'lte', value }),
      in: (path: string, value: unknown[]) => add({ path, op: 'in', value }),
      is: (path: string, value: unknown) => add({ path, op: 'is', value }),
      not(path: string, operator: string, value: unknown) {
        if (operator !== 'is') throw new Error(`payroll-fake-db: unsupported not.${operator}`)
        return add({ path, op: 'not_is', value })
      },
      or(expression: string) {
        filters.push({ kind: 'or', conditions: parseOr(expression) })
        return builder
      },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push({ column, ascending: options?.ascending !== false })
        return builder
      },
      range(start: number, end: number) {
        range = [start, end]
        return builder
      },
      limit(count: number) {
        limit = count
        return builder
      },
      single() {
        single = 'single'
        return builder
      },
      maybeSingle() {
        single = 'maybeSingle'
        return builder
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve()
          .then(execute)
          .then(onFulfilled, onRejected)
      },
    }
    function add(condition: Condition) {
      filters.push({ kind: 'and', condition })
      return builder
    }
    return builder
  }

  const supabase = { from } as unknown as SupabaseClient

  /** Stored rows of one table, as a read would return them. */
  const rows = (table: string): Row[] => (tables[table] ?? []).map((row) => wire(row))

  /** Change one stored row, as another session's write would. */
  const edit = (table: string, id: string, patch: Row) => {
    const row = (tables[table] ?? []).find((candidate) => candidate.id === id)
    if (!row) throw new Error(`payroll-fake-db: no ${table} row ${id}`)
    Object.assign(row, wire(patch))
  }

  return { supabase, queries, rows, edit }
}
