/**
 * In-memory `idempotency_keys` table for tests of the idempotency layer
 * (src/lib/api/idempotency.ts). Covers what its helpers send: eq filters, gt
 * on expires_at, order by created_at (desc), limit, maybeSingle, an insert
 * that answers 23505 on the (user_id, company_id, key) unique index, as the
 * real table does, update and delete filtered by eq, and the
 * claim_idempotency_key RPC (`rpc`), which mirrors the SQL function in
 * supabase/migrations/20261016004000_idempotency_inflight_claims.sql. The
 * real function's locking and its concurrency are proven against Postgres in
 * tests/pg/idempotency-claims.pg.test.ts; this fake is for the callers.
 */
export interface IdempotencyKeyRow {
  id: string
  user_id: string
  company_id: string | null
  key: string
  request_hash: string
  scope: string
  state: 'in_progress' | 'completed'
  response_status: 'success' | 'error' | null
  response_body: Record<string, unknown>
  created_at: string
  expires_at: string
}

interface ClaimParams {
  p_user_id: string
  p_company_id: string | null
  p_scope: string
  p_key: string
  p_request_hash: string
  p_claim_ttl_seconds: number
}

export function createIdempotencyKeysFake() {
  const rows: IdempotencyKeyRow[] = []
  let sequence = 0

  const nextId = () => {
    sequence += 1
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  }
  const createdAt = () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString()
  const isLive = (row: IdempotencyKeyRow) => new Date(row.expires_at).getTime() > Date.now()
  const remove = (predicate: (row: IdempotencyKeyRow) => boolean) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (predicate(rows[i])) rows.splice(i, 1)
  }

  function table() {
    const filters: Array<(row: IdempotencyKeyRow) => boolean> = []
    let descending = false
    let mutation: { kind: 'update'; values: Partial<IdempotencyKeyRow> } | { kind: 'delete' } | null = null
    const matching = () => rows.filter((row) => filters.every((matches) => matches(row)))
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
        const hits = matching()
        const ordered = descending ? [...hits].reverse() : hits
        return { data: ordered[0] ?? null, error: null }
      },
      insert: async (row: Omit<IdempotencyKeyRow, 'id' | 'state' | 'created_at' | 'expires_at'>) => {
        const taken = rows.some(
          (existing) =>
            existing.user_id === row.user_id && existing.company_id === row.company_id && existing.key === row.key,
        )
        if (taken) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        rows.push({
          ...row,
          id: nextId(),
          state: 'completed',
          created_at: createdAt(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        return { error: null }
      },
      update: (values: Partial<IdempotencyKeyRow>) => {
        // supabase-js serializes the body as JSON, which drops undefined
        // properties: an undefined field leaves the column as it is.
        mutation = {
          kind: 'update',
          values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<IdempotencyKeyRow>,
        }
        return builder
      },
      delete: () => {
        mutation = { kind: 'delete' }
        return builder
      },
      // Awaiting an update or delete chain applies it, as supabase-js does.
      then: (resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) => {
        const hits = matching()
        if (mutation?.kind === 'update') {
          for (const row of hits) Object.assign(row, mutation.values)
        } else if (mutation?.kind === 'delete') {
          remove((row) => hits.includes(row))
        }
        return Promise.resolve({ error: null }).then(resolve, reject)
      },
    }
    return builder
  }

  /** claim_idempotency_key, decided as the SQL function decides it. */
  function claim(params: ClaimParams) {
    const { p_user_id: userId, p_company_id: companyId, p_scope: scope, p_key: key, p_request_hash: hash } = params
    const sameKey = (row: IdempotencyKeyRow) =>
      row.user_id === userId && row.key === key && (companyId !== null ? row.company_id === companyId : row.scope === scope)
    const live = rows
      .filter((row) => sameKey(row) && isLive(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

    if (live) {
      if (live.request_hash !== hash) return { outcome: 'reuse' }
      if (live.state === 'completed') {
        return { outcome: 'replay', response_status: live.response_status, response_body: live.response_body }
      }
      return { outcome: 'in_progress' }
    }

    // No live row: a dead one for the key gives way.
    remove((row) => sameKey(row) && !isLive(row) && (companyId !== null || row.company_id === null))
    const id = nextId()
    rows.push({
      id,
      user_id: userId,
      company_id: companyId,
      key,
      request_hash: hash,
      scope,
      state: 'in_progress',
      response_status: null,
      response_body: {},
      created_at: createdAt(),
      expires_at: new Date(Date.now() + params.p_claim_ttl_seconds * 1000).toISOString(),
    })
    return { outcome: 'claimed', claim_id: id }
  }

  /** Answers claim_idempotency_key; any other function name is an error, as an unknown RPC is. */
  async function rpc(name: string, params: Record<string, unknown>) {
    if (name !== 'claim_idempotency_key') {
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }
    }
    return { data: claim(params as unknown as ClaimParams), error: null }
  }

  /** Age every row past its expiry: an abandoned claim, a response older than 24 h. */
  function expireAll() {
    for (const row of rows) row.expires_at = new Date(Date.now() - 1000).toISOString()
  }

  return { rows, table, rpc, expireAll }
}
