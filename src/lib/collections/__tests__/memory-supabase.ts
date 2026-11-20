import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A small in-memory stand-in for the PostgREST builder, enough for the
 * collections connection service and its routes: select / insert / update
 * with eq, neq, is, in, order, limit, single and maybeSingle, plus the RPCs
 * those paths call. Unlike the queued mocks it keeps state, so a test can
 * walk an activation through every step against the fake adapter and assert
 * on the rows.
 *
 * The database's own rules (one live connection per company, defaults,
 * updated_at) are mirrored only as far as the service relies on them; the
 * triggers and constraints themselves are covered by
 * tests/pg/collection-connections.pg.test.ts.
 */

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

/** What goes on the wire: JSON drops a key whose value is undefined, so the column keeps its default. */
const onTheWire = (value: Row): Row => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

const CONNECTION_DEFAULTS: Row = {
  user_id: null,
  capability: 'collections',
  connection_handle: null,
  provider_status: null,
  provider_terms: null,
  state: 'connecting',
  sub_status: null,
  health: null,
  health_cause: null,
  health_action: null,
  last_success_at: null,
  last_error_code: null,
  last_error_at: null,
  failures_in_row: 0,
  dpa_version: null,
  terms_version: null,
  terms_accepted_by: null,
  terms_accepted_at: null,
  submitted_at: null,
  activated_at: null,
  ended_by: null,
  ended_at: null,
  minimum_amount: 100,
  default_start_step: 'reminder',
  reminder_fee_terms_since: null,
  late_interest_percent: null,
  late_interest_agreed_since: null,
  distribution_enabled: false,
  ladder_mode: null,
  ladder_days_after_due: 10,
  ladder_enabled_by: null,
  ladder_enabled_at: null,
  clearing_account: '1689',
  payout_account: '1930',
  auto_book_collected_payments: false,
  auto_book_settlements: false,
}

/** collection_cases column defaults (20261012030200_collection_cases.sql). */
const CASE_DEFAULTS: Row = {
  submission_status: 'preparing',
  submission_request: null,
  submission_attempts: 0,
  provider_case_ref: null,
  provider_case_number: null,
  parent_case_ref: null,
  stage: 'registered',
  decision_kind: null,
  is_open: true,
  close_reason: null,
  provider_state: null,
  provider_state_label: null,
  next_action_date: null,
  next_action_label: null,
  actions: [],
  currency: 'SEK',
  outstanding_principal: null,
  outstanding_total: null,
  last_bank_checked_at: null,
  paused_by_sweep: false,
  pause_reason: null,
  opened_by: null,
  closed_at: null,
  last_synced_at: null,
  sync_error: null,
  pending_operation_id: null,
}

export interface MemorySupabase {
  client: SupabaseClient
  tables: Map<string, Row[]>
  rows(table: string): Row[]
  seed(table: string, rows: Row[]): void
  /** Answers for RPCs, by name. */
  rpcs: Map<string, (args: Record<string, unknown>) => unknown>
  /** Every write, in order: [table, operation, payload]. */
  writes: [string, 'insert' | 'update' | 'delete', Row][]
  /** Make every `${table}:${operation}` call answer this error (tests of failure paths). */
  failures: Map<string, { message: string; code?: string }>
}

export function createMemorySupabase(): MemorySupabase {
  const tables = new Map<string, Row[]>()
  const writes: MemorySupabase['writes'] = []
  const failures: MemorySupabase['failures'] = new Map()
  const rpcs = new Map<string, (args: Record<string, unknown>) => unknown>([
    ['collection_obligation_counts', () => [{ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 }]],
    ['user_is_company_admin', () => true],
    // Payment forwarding (forwarding.ts): nothing waits in the outbox unless a test says so.
    ['claim_collection_forwards', () => []],
    ['seed_collection_forwards', () => 0],
    // The forward reconcile (reconcile.ts): nothing missing unless a test says so.
    ['reconcile_collection_forwards', () => ({ created_payments: 0, created_credits: 0, reverted: 0, skipped: 0 })],
  ])
  const rows = (table: string): Row[] => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)!
  }

  function builder(table: string) {
    const filters: Filter[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row | Row[] | null = null
    let order: { column: string; ascending: boolean } | null = null
    let limit: number | null = null
    let range: { from: number; to: number } | null = null
    let mode: 'many' | 'single' | 'maybeSingle' = 'many'
    let countHead = false
    let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}

    function execute(): { data: unknown; error: { message: string; code?: string } | null; count?: number } {
      const all = rows(table)
      const failure = failures.get(`${table}:${op}`)
      if (failure) return { data: null, error: failure }
      if (op === 'upsert') {
        const keys = (upsertOptions.onConflict ?? 'id').split(',').map((k) => k.trim())
        const written: Row[] = []
        for (const input of Array.isArray(payload) ? payload : [payload!]) {
          const existing = all.find((r) => keys.every((k) => r[k] !== null && r[k] !== undefined && r[k] === input[k]))
          if (existing) {
            if (!upsertOptions.ignoreDuplicates) {
              Object.assign(existing, input, { updated_at: new Date().toISOString() })
              written.push(existing)
            }
            continue
          }
          const now = new Date().toISOString()
          const row: Row = { id: randomUUID(), created_at: now, updated_at: now, ...input }
          all.push(row)
          written.push(row)
          writes.push([table, 'insert', input])
        }
        return shape(written)
      }
      if (op === 'delete') {
        const removed = all.filter((r) => filters.every((f) => f(r)))
        tables.set(
          table,
          all.filter((r) => !removed.includes(r)),
        )
        for (const r of removed) writes.push([table, 'delete', { id: r.id }])
        return shape(removed)
      }
      if (op === 'insert') {
        const inserted: Row[] = []
        for (const input of Array.isArray(payload) ? payload : [payload!]) {
          const now = new Date().toISOString()
          const row: Row = {
            ...(table === 'collection_connections' ? CONNECTION_DEFAULTS : {}),
            id: randomUUID(),
            created_at: now,
            updated_at: now,
            ...input,
          }
          if (
            table === 'collection_connections' &&
            all.some((r) => r.company_id === row.company_id && r.state !== 'disconnected')
          ) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "collection_connections_one_live"', code: '23505' } }
          }
          if (table === 'collection_cases') {
            Object.assign(row, { ...CASE_DEFAULTS, ...row })
            if (all.some((r) => r.invoice_id === row.invoice_id && r.is_open === true)) {
              return { data: null, error: { message: 'duplicate key value violates unique constraint "collection_cases_one_open_per_invoice"', code: '23505' } }
            }
          }
          all.push(row)
          inserted.push(row)
          writes.push([table, 'insert', input])
        }
        return shape(inserted)
      }
      const matched = all.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const row of matched) {
          Object.assign(row, payload, { updated_at: new Date().toISOString() })
          writes.push([table, 'update', { ...(payload as Row) }])
        }
        return shape(matched)
      }
      let result = [...matched]
      if (order) {
        const { column, ascending } = order
        result.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1))
      }
      if (countHead) return { data: null, error: null, count: result.length }
      if (range) result = result.slice(range.from, range.to + 1)
      if (limit !== null) result = result.slice(0, limit)
      return shape(result)
    }

    /** `a.is.null,a.eq.true`-style or-filters, as the services write them. */
    function orFilter(expression: string): Filter {
      const parts = expression.split(',').map((part) => {
        const [column, operator, ...rest] = part.split('.')
        const raw = rest.join('.')
        const value: unknown = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw
        return (r: Row) => {
          const v = r[column] ?? null
          switch (operator) {
            case 'is':
              return v === value
            case 'eq':
              return v === value
            case 'lt':
              return v !== null && String(v) < String(value)
            case 'gt':
              return v !== null && String(v) > String(value)
            default:
              throw new Error(`memory supabase: unsupported or-operator ${operator}`)
          }
        }
      })
      return (r) => parts.some((f) => f(r))
    }

    const compare = (column: string, value: unknown, test: (a: number) => boolean): Filter => (r) => {
      const v = r[column]
      if (v === null || v === undefined) return false
      const both = typeof v === 'number' || typeof value === 'number'
      const diff = both ? Number(v) - Number(value) : String(v) < String(value) ? -1 : String(v) > String(value) ? 1 : 0
      return test(diff)
    }

    function shape(result: Row[]) {
      const copy = result.map((r) => JSON.parse(JSON.stringify(r)) as Row)
      if (mode === 'many') return { data: copy, error: null }
      if (copy.length > 1) return { data: null, error: { message: 'more than one row', code: 'PGRST116' } }
      if (copy.length === 0 && mode === 'single') return { data: null, error: { message: 'no rows', code: 'PGRST116' } }
      return { data: copy[0] ?? null, error: null }
    }

    const chain = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        if (options?.head) countHead = true
        return chain
      },
      delete() {
        op = 'delete'
        return chain
      },
      upsert(value: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
        op = 'upsert'
        payload = Array.isArray(value) ? value.map(onTheWire) : onTheWire(value)
        upsertOptions = options
        return chain
      },
      gt(column: string, value: unknown) {
        filters.push(compare(column, value, (d) => d > 0))
        return chain
      },
      gte(column: string, value: unknown) {
        filters.push(compare(column, value, (d) => d >= 0))
        return chain
      },
      lt(column: string, value: unknown) {
        filters.push(compare(column, value, (d) => d < 0))
        return chain
      },
      lte(column: string, value: unknown) {
        filters.push(compare(column, value, (d) => d <= 0))
        return chain
      },
      or(expression: string) {
        filters.push(orFilter(expression))
        return chain
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== 'is') throw new Error(`memory supabase: unsupported not-operator ${operator}`)
        filters.push((r) => (r[column] ?? null) !== value)
        return chain
      },
      range(from: number, to: number) {
        range = { from, to }
        return chain
      },
      insert(value: Row | Row[]) {
        op = 'insert'
        payload = Array.isArray(value) ? value.map(onTheWire) : onTheWire(value)
        return chain
      },
      update(value: Row) {
        op = 'update'
        payload = onTheWire(value)
        return chain
      },
      eq(column: string, value: unknown) {
        filters.push((r) => r[column] === value)
        return chain
      },
      neq(column: string, value: unknown) {
        filters.push((r) => r[column] !== value)
        return chain
      },
      is(column: string, value: unknown) {
        filters.push((r) => (r[column] ?? null) === value)
        return chain
      },
      in(column: string, values: unknown[]) {
        filters.push((r) => values.includes(r[column]))
        return chain
      },
      order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
        order ??= { column, ascending: options?.ascending !== false }
        return chain
      },
      limit(n: number) {
        limit = n
        return chain
      },
      single() {
        mode = 'single'
        return Promise.resolve(execute())
      },
      maybeSingle() {
        mode = 'maybeSingle'
        return Promise.resolve(execute())
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject)
      },
    }
    return chain
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      const handler = rpcs.get(name)
      return Promise.resolve(handler ? { data: handler(args), error: null } : { data: null, error: { message: `no rpc ${name}` } })
    },
  } as unknown as SupabaseClient

  return {
    client,
    tables,
    rows,
    seed(table, seeded) {
      rows(table).push(...seeded.map((r) => ({ ...r })))
    },
    rpcs,
    writes,
    failures,
  }
}

export const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
export const ADMIN_ID = '22222222-2222-4222-8222-222222222222'
export const CASH_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

/** An aktiebolag with an address, a VAT number and a bank account with a bankgiro. */
export function seedCompany(db: MemorySupabase, options: { entityType?: string; orgNumber?: string } = {}): void {
  db.seed('companies', [{ id: COMPANY_ID, name: 'Test AB', org_number: options.orgNumber ?? '5560125790', entity_type: options.entityType ?? 'aktiebolag' }])
  db.seed('company_settings', [
    {
      company_id: COMPANY_ID,
      entity_type: options.entityType ?? 'aktiebolag',
      company_name: 'Test AB',
      org_number: options.orgNumber ?? '5560125790',
      address_line1: 'Storgatan 1',
      address_line2: null,
      postal_code: '111 22',
      city: 'Stockholm',
      email: 'faktura@test.se',
      phone: null,
      vat_registered: true,
      vat_number: 'SE556012579001',
      is_sandbox: false,
    },
  ])
  db.seed('cash_accounts', [
    {
      id: CASH_ACCOUNT_ID,
      company_id: COMPANY_ID,
      name: 'Företagskonto',
      ledger_account: '1930',
      enabled: true,
      is_primary: true,
      bankgiro: '123-4567',
      plusgiro: null,
      clearing_number: '8327',
      account_number: '9 123 456 789',
    },
  ])
  db.seed('invoice_payee_defaults', [{ company_id: COMPANY_ID, currency: 'SEK', cash_account_id: CASH_ACCOUNT_ID }])
  db.seed('profiles', [{ id: ADMIN_ID, full_name: 'Ada Admin', email: 'ada@test.se' }])
}
