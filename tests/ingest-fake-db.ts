/**
 * In-memory tables for tests of the transaction ingest pipeline.
 *
 * The queue-based mocks answer queries in the order they are awaited, which
 * pins the order of reads but cannot say whether two callers that read in a
 * different order (the commit and its preview) see the same stored rows. This
 * fake applies the filters instead: it implements the slice of PostgREST the
 * pipeline uses over plain arrays, so a scenario can be told the way it
 * happens (ingest, book, ingest again) and the commit and the preview can be
 * run against the very same state.
 *
 * Filters follow SQL: `neq` never matches NULL. The unique index on
 * (company_id, external_id) refuses a second insert with the error the real
 * index raises.
 */
import { vi } from 'vitest'

export type FakeRow = Record<string, unknown>

export const FAKE_COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export function createIngestFakeDb() {
  const tables: Record<string, FakeRow[]> = {
    transactions: [],
    cash_accounts: [],
    companies: [{ id: FAKE_COMPANY_ID, entity_type: 'aktiebolag' }],
  }
  /** Every insert and update, as `<verb>:<table>`: a preview must leave it empty. */
  const writes: string[] = []
  let sequence = 0
  const nextId = () => {
    sequence += 1
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  }

  const from = (table: string) => {
    const rows = (tables[table] ??= [])
    const filters: Array<(row: FakeRow) => boolean> = []
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: FakeRow = {}
    let window: [number, number] | null = null
    let one = false

    const execute = () => {
      if (mode === 'insert') {
        writes.push(`insert:${table}`)
        const clash =
          table === 'transactions' &&
          payload.external_id != null &&
          rows.some((row) => row.company_id === payload.company_id && row.external_id === payload.external_id)
        if (clash) {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "idx_transactions_company_external_id"',
            },
          }
        }
        const inserted: FakeRow = { journal_entry_id: null, ...payload, id: nextId() }
        rows.push(inserted)
        return { data: one ? inserted : [inserted], error: null }
      }
      const matched = rows.filter((row) => filters.every((keep) => keep(row)))
      if (mode === 'update') {
        writes.push(`update:${table}`)
        for (const row of matched) Object.assign(row, payload)
        return { data: matched, error: null }
      }
      const ordered = [...matched].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const page = window ? ordered.slice(window[0], window[1] + 1) : ordered
      return { data: one ? (page[0] ?? null) : page, error: null }
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      insert: (values: FakeRow) => {
        mode = 'insert'
        payload = values
        return builder
      },
      update: (values: FakeRow) => {
        mode = 'update'
        payload = values
        return builder
      },
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
      // The pipeline only ever asks `.not(column, 'is', null)`.
      not: (column: string, _operator: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) !== value)
        return builder
      },
      gte: (column: string, value: string) => {
        filters.push((row) => String(row[column]) >= value)
        return builder
      },
      lte: (column: string, value: string) => {
        filters.push((row) => String(row[column]) <= value)
        return builder
      },
      gt: (column: string, value: number) => {
        filters.push((row) => Number(row[column]) > value)
        return builder
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]))
        return builder
      },
      range: (start: number, end: number) => {
        window = [start, end]
        return builder
      },
      single: () => {
        one = true
        return builder
      },
      maybeSingle: () => {
        one = true
        return builder
      },
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    }
    return builder
  }

  const stored = () => tables.transactions
  return {
    from,
    /** A client that knows only these tables. */
    supabase: { from: vi.fn(from), rpc: vi.fn() },
    tables,
    writes,
    /** The stored transactions, in insertion order. */
    stored,
    /** The stored row carrying this external_id. */
    byExternalId: (externalId: string) => stored().find((row) => row.external_id === externalId),
    /** Book rows into a verifikat, as categorising them does. */
    book: (...externalIds: string[]) => {
      for (const row of stored()) {
        if (externalIds.includes(String(row.external_id))) row.journal_entry_id = `je-${String(row.id)}`
      }
    },
    /** Put a row in the table as an earlier import or a hand entry left it. */
    seed: (row: FakeRow) => {
      stored().push({
        id: nextId(),
        company_id: FAKE_COMPANY_ID,
        journal_entry_id: null,
        cash_account_id: null,
        bank_connection_id: null,
        currency: 'SEK',
        original_description: row.description ?? null,
        ...row,
      })
    },
  }
}

export type IngestFakeDb = ReturnType<typeof createIngestFakeDb>
