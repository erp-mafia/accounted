import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { pushNotificationsApiRoutes } from '../api-routes'

/**
 * The subscribe path, asserted against the columns it actually names.
 *
 * `createMockSupabase()` cannot be used here: it is a permissive proxy, so
 * `.eq('company_id', userId)` on a table with no company_id resolves happily and
 * an `onConflict` naming a non-existent unique constraint never surfaces. Both
 * shipped bugs would pass under it. This recorder captures the payload, the
 * upsert options and every filter so the test can assert on them; the companion
 * check that those column names exist in the schema at all lives in
 * `tests/schema/no-phantom-columns.test.ts`.
 */

interface Call {
  table: string
  op: string
  payload?: Record<string, unknown>
  options?: Record<string, unknown>
  filters: [string, unknown][]
}

const calls: Call[] = []

function recorder() {
  const from = (table: string) => {
    const make = (op: string, payload?: Record<string, unknown>, options?: Record<string, unknown>) => {
      const call: Call = { table, op, payload, options, filters: [] }
      calls.push(call)
      const chain: Record<string, unknown> = {
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value])
          return chain
        },
        select: () => chain,
        single: async () => ({ data: { id: 'sub-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      return chain
    }
    return {
      upsert: (payload: Record<string, unknown>, options?: Record<string, unknown>) =>
        make('upsert', payload, options),
      delete: () => make('delete'),
      insert: (payload: Record<string, unknown>) => make('insert', payload),
    }
  }
  return { from }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => recorder(),
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ENDPOINT = 'https://push.example.test/v1/synthetic-endpoint'
const ctx = { userId: USER_ID } as unknown as ExtensionContext

const route = (method: string, path: string) =>
  pushNotificationsApiRoutes.find((r) => r.method === method && r.path === path)!.handler

const jsonRequest = (body: unknown) =>
  new Request('http://localhost/api/extensions/ext/push-notifications/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'SyntheticAgent/1.0' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
})

describe('POST /subscribe', () => {
  const validBody = {
    endpoint: ENDPOINT,
    keys: { p256dh: 'synthetic-p256dh', auth: 'synthetic-auth' },
  }

  it('upserts onto the endpoint unique constraint', async () => {
    // push_subscriptions is unique on `endpoint` alone. Naming `user_id,endpoint`
    // is not a unique set, so Postgres raised 42P10 on every subscribe call.
    const response = await route('POST', '/subscribe')(jsonRequest(validBody), ctx)
    expect(response.status).toBe(200)

    const upsert = calls.find((c) => c.table === 'push_subscriptions' && c.op === 'upsert')
    expect(upsert).toBeDefined()
    expect(upsert!.options?.onConflict).toBe('endpoint')
  })

  it('keys the subscription by user, never by company', async () => {
    // A push endpoint belongs to a browser profile, and a user can belong to
    // several companies: the table is user-scoped and has no company_id.
    await route('POST', '/subscribe')(jsonRequest(validBody), ctx)

    const upsert = calls.find((c) => c.table === 'push_subscriptions' && c.op === 'upsert')!
    expect(upsert.payload!.user_id).toBe(USER_ID)
    expect(upsert.payload).not.toHaveProperty('company_id')

    const settings = calls.find((c) => c.table === 'notification_settings')!
    expect(settings.payload!.user_id).toBe(USER_ID)
    expect(settings.payload).not.toHaveProperty('company_id')
    expect(settings.options?.onConflict).toBe('user_id')
  })

  it('rejects a subscription with no keys', async () => {
    const response = await route('POST', '/subscribe')(
      jsonRequest({ endpoint: ENDPOINT, keys: {} }),
      ctx
    )
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe('DELETE /subscribe', () => {
  it('scopes the delete to the calling user, not to a company', async () => {
    // The shipped code filtered `.eq('company_id', userId)`: a user id compared
    // against a column that does not exist, so unsubscribing removed nothing and
    // the device kept receiving pushes.
    const response = await route('DELETE', '/subscribe')(jsonRequest({ endpoint: ENDPOINT }), ctx)
    expect(response.status).toBe(200)

    const del = calls.find((c) => c.table === 'push_subscriptions' && c.op === 'delete')!
    expect(del.filters).toEqual([
      ['user_id', USER_ID],
      ['endpoint', ENDPOINT],
    ])
  })

  it('rejects a delete with no endpoint', async () => {
    const response = await route('DELETE', '/subscribe')(jsonRequest({}), ctx)
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })
})
