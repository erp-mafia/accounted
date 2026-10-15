/**
 * In-memory `idempotency_keys` table for tests of the idempotency layer
 * (src/lib/api/idempotency.ts). Covers what its helpers send: eq filters, gt
 * on expires_at, order by created_at (desc), limit, maybeSingle, and an
 * insert that answers 23505 on the (user_id, company_id, key) unique index,
 * as the real table does.
 */
export interface IdempotencyKeyRow {
  user_id: string
  company_id: string
  key: string
  request_hash: string
  scope: string
  response_status: 'success' | 'error'
  response_body: Record<string, unknown>
  created_at: string
  expires_at: string
}

export function createIdempotencyKeysFake() {
  const rows: IdempotencyKeyRow[] = []
  let sequence = 0

  function table() {
    const filters: Array<(row: IdempotencyKeyRow) => boolean> = []
    let descending = false
    const builder = {
      select: () => builder,
      eq: (column: keyof IdempotencyKeyRow, value: unknown) => {
        filters.push((row) => row[column] === value)
        return builder
      },
      gt: (column: keyof IdempotencyKeyRow, value: string) => {
        filters.push((row) => String(row[column]) > value)
        return builder
      },
      order: (_column: string, options?: { ascending?: boolean }) => {
        descending = options?.ascending === false
        return builder
      },
      limit: () => builder,
      maybeSingle: async () => {
        const hits = rows.filter((row) => filters.every((matches) => matches(row)))
        const ordered = descending ? [...hits].reverse() : hits
        return { data: ordered[0] ?? null, error: null }
      },
      insert: async (row: Omit<IdempotencyKeyRow, 'created_at' | 'expires_at'>) => {
        const taken = rows.some(
          (existing) =>
            existing.user_id === row.user_id && existing.company_id === row.company_id && existing.key === row.key,
        )
        if (taken) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        sequence += 1
        rows.push({
          ...row,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        return { error: null }
      },
    }
    return builder
  }

  return { rows, table }
}
