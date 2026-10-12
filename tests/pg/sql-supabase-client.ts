/**
 * A supabase-js stand-in over the pg-real pool, for driving production code
 * (routes, services, event handlers) against real tables, RLS, triggers and
 * RPC bodies. Only the HTTP transport is replaced. Each call runs in its own
 * committed transaction under the role PostgREST would present: the signed-in
 * user (RLS applies) or service_role. It covers the builder surface the
 * first-use event tests reach and throws on anything else, so a path that
 * grows a new query shape fails loudly instead of silently passing.
 */
import type { PoolClient } from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getClient } from './setup'

export type SqlClientRole = 'service_role' | 'authenticated'

/** Runs one statement in its own committed transaction, as PostgREST would. */
async function run(role: SqlClientRole, userId: string | null, sql: string, params: unknown[]) {
  const client: PoolClient = await getClient()
  try {
    await client.query('BEGIN')
    const claims = role === 'service_role' ? { role } : { role, sub: userId }
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
    if (userId) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await client.query(sql, params)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new Error(`unsupported identifier in test client: ${name}`)
  return `"${name}"`
}
const columnList = (columns: string) =>
  columns.trim() === '*' ? '*' : columns.split(',').map((c) => ident(c.trim())).join(', ')
const toParam = (value: unknown) =>
  value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value

/** The supabase-js surface these paths use, over SQL. Anything else throws. */
export function sqlClient(role: SqlClientRole, userId: string | null): SupabaseClient {
  const from = (table: string) => {
    let mode: 'select' | 'update' | 'insert' = 'select'
    let columns = '*'
    let returning: string | null = null
    let countOnly = false
    let single: 'one' | 'maybe' | null = null
    let rows: Record<string, unknown>[] = []
    const params: unknown[] = []
    const where: string[] = []
    const order: string[] = []
    let limit: number | null = null
    let offset = 0
    const filter = (column: string, op: string, value: unknown) => {
      params.push(value)
      where.push(`${ident(column)} ${op} $${params.length}`)
      return builder
    }
    const execute = async () => {
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
      if (mode === 'select') {
        if (countOnly) {
          const r = await run(role, userId, `SELECT count(*)::int AS n FROM public.${ident(table)}${whereSql}`, params)
          return { data: null, count: r.rows[0].n, error: null }
        }
        const orderSql = order.length ? ` ORDER BY ${order.join(', ')}` : ''
        const limitSql = limit === null ? '' : ` LIMIT ${limit}`
        const r = await run(role, userId, `SELECT ${columnList(columns)} FROM public.${ident(table)}${whereSql}${orderSql}${limitSql} OFFSET ${offset}`, params)
        return { data: r.rows, error: null }
      }
      const returningSql = returning === null ? '' : ` RETURNING ${columnList(returning)}`
      if (mode === 'update') {
        const set = Object.keys(rows[0]).map((key) => {
          params.push(toParam(rows[0][key]))
          return `${ident(key)} = $${params.length}`
        })
        const r = await run(role, userId, `UPDATE public.${ident(table)} SET ${set.join(', ')}${whereSql}${returningSql}`, params)
        return { data: returning === null ? null : r.rows, error: null }
      }
      const keys = Object.keys(rows[0])
      const values = rows.map(
        (row) =>
          `(${keys
            .map((key) => {
              params.push(toParam(row[key]))
              return `$${params.length}`
            })
            .join(', ')})`,
      )
      const r = await run(role, userId, `INSERT INTO public.${ident(table)} (${keys.map(ident).join(', ')}) VALUES ${values.join(', ')}${returningSql}`, params)
      return { data: returning === null ? null : r.rows, error: null }
    }
    const builder = {
      select(cols = '*', options?: { count?: 'exact'; head?: boolean }) {
        if (mode === 'select') {
          columns = cols
          countOnly = options?.count === 'exact' && options.head === true
        } else {
          returning = cols
        }
        return builder
      },
      update(values: Record<string, unknown>) {
        mode = 'update'
        rows = [values]
        return builder
      },
      insert(values: Record<string, unknown> | Record<string, unknown>[]) {
        mode = 'insert'
        rows = Array.isArray(values) ? values : [values]
        return builder
      },
      eq: (column: string, value: unknown) => filter(column, '=', value),
      neq: (column: string, value: unknown) => filter(column, '<>', value),
      gte: (column: string, value: unknown) => filter(column, '>=', value),
      lte: (column: string, value: unknown) => filter(column, '<=', value),
      in(column: string, values: unknown[]) {
        params.push(values)
        where.push(`${ident(column)} = ANY($${params.length})`)
        return builder
      },
      is(column: string, value: null) {
        if (value !== null) throw new Error('test client supports is(column, null) only')
        where.push(`${ident(column)} IS NULL`)
        return builder
      },
      order(column: string, options?: { ascending?: boolean }) {
        order.push(`${ident(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}`)
        return builder
      },
      range(start: number, end: number) {
        offset = start
        limit = end - start + 1
        return builder
      },
      limit(value: number) {
        limit = value
        return builder
      },
      single() {
        single = 'one'
        return builder
      },
      maybeSingle() {
        single = 'maybe'
        return builder
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return execute()
          .then((result) => {
            if (!single || !Array.isArray(result.data)) return result
            const [first, ...rest] = result.data
            if (rest.length > 0 || (single === 'one' && !first)) {
              return { data: null, error: { code: 'PGRST116', message: `expected one row, got ${result.data.length}` } }
            }
            return { ...result, data: first ?? null }
          })
          .catch((err: { message?: string; code?: string }) => ({
            data: null,
            error: { message: err.message ?? String(err), code: err.code },
          }))
          .then(resolve, reject)
      },
    }
    return builder
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    const entries = Object.entries(args)
    try {
      const r = await run(
        role,
        userId,
        `SELECT to_jsonb(public.${ident(name)}(${entries.map(([key], i) => `${ident(key)} => $${i + 1}`).join(', ')})) AS data`,
        entries.map(([, value]) => toParam(value)),
      )
      return { data: r.rows[0]?.data ?? null, error: null }
    } catch (err) {
      const e = err as { message?: string; code?: string }
      return { data: null, error: { message: e.message ?? String(err), code: e.code } }
    }
  }

  return { from, rpc } as unknown as SupabaseClient
}
