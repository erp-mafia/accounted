/**
 * A small in-memory stand-in for the PostgREST query builder, enough for the
 * POS sales sync and booking: select (column lists ignored), insert, update
 * with eq / neq / is / lt / lte / gte / in filters, maybeSingle / single,
 * order / range / limit as no-ops, and a unique key per table so a racing
 * insert answers 23505 like Postgres.
 */
type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeDb {
  tables: Record<string, Row[]>
  client: { from: (table: string) => unknown }
  inserts: Array<{ table: string; row: Row }>
  updates: Array<{ table: string; patch: Row; matched: number }>
}

const UNIQUE: Record<string, string[]> = {
  pos_sales_days: ['connection_id', 'business_date'],
}

function compare(a: unknown, b: unknown): number {
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]))
  const inserts: FakeDb['inserts'] = []
  const updates: FakeDb['updates'] = []
  let nextId = 1

  function builder(table: string) {
    const filters: Filter[] = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let patch: Row = {}
    let toInsert: Row[] = []
    let single = false
    let returning = false

    const run = (): { data: unknown; error: { code: string; message: string } | null; count?: number } => {
      const rows = (tables[table] ??= [])
      if (mode === 'insert') {
        const keys = UNIQUE[table]
        for (const row of toInsert) {
          if (keys && rows.some((r) => keys.every((k) => r[k] === row[k]))) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } }
          }
        }
        const created = toInsert.map((row) => ({ id: `row-${nextId++}`, ...row }))
        rows.push(...created)
        created.forEach((row) => inserts.push({ table, row }))
        return { data: single ? created[0] : created, error: null }
      }
      const matched = rows.filter((row) => filters.every((f) => f(row)))
      if (mode === 'update') {
        matched.forEach((row) => Object.assign(row, patch))
        updates.push({ table, patch, matched: matched.length })
        if (!returning) return { data: null, error: null }
      }
      const data = matched.map((row) => ({ ...row }))
      if (single) return { data: data[0] ?? null, error: null }
      return { data, error: null, count: data.length }
    }

    const chain: Record<string, unknown> = {
      select: () => {
        if (mode !== 'select') returning = true
        return chain
      },
      insert: (value: Row | Row[]) => {
        mode = 'insert'
        toInsert = Array.isArray(value) ? value : [value]
        return chain
      },
      update: (value: Row) => {
        mode = 'update'
        patch = value
        return chain
      },
      eq: (col: string, value: unknown) => {
        filters.push((row) => row[col] === value)
        return chain
      },
      neq: (col: string, value: unknown) => {
        filters.push((row) => row[col] !== value)
        return chain
      },
      is: (col: string, value: unknown) => {
        filters.push((row) => (row[col] ?? null) === value)
        return chain
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]))
        return chain
      },
      lt: (col: string, value: unknown) => {
        filters.push((row) => compare(row[col], value) < 0)
        return chain
      },
      lte: (col: string, value: unknown) => {
        filters.push((row) => compare(row[col], value) <= 0)
        return chain
      },
      gte: (col: string, value: unknown) => {
        filters.push((row) => compare(row[col], value) >= 0)
        return chain
      },
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        single = true
        return chain
      },
      single: () => {
        single = true
        return chain
      },
      then: (resolve: (value: unknown) => void, reject?: (err: unknown) => void) => {
        try {
          resolve(run())
        } catch (err) {
          reject?.(err)
        }
      },
    }
    return chain
  }

  return { tables, inserts, updates, client: { from: (table: string) => builder(table) } }
}
