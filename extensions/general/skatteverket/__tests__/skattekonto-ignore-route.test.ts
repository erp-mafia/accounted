import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * PATCH /skattekonto/transaktioner/:id/ignore
 *
 * Skattekonto rows are never deleted (external mirror); is_ignored is the
 * sanctioned way off the work list. The route must refuse to ignore a booked
 * row (409, mirroring the DB CHECK) and be fully reversible.
 */

const ROUTE_PATH = '/skattekonto/transaktioner/:id/ignore'
const ROW_ID = '11111111-1111-4111-8111-111111111111'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'PATCH' && r.path === ROUTE_PATH,
  )
  if (!route) throw new Error('ignore route not registered')
  return route
}

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeRequest(body: unknown, id: string | null = ROW_ID): Request {
  const url = new URL('http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner/x/ignore')
  // The catch-all dispatcher passes :id via the `_id` search param.
  if (id) url.searchParams.set('_id', id)
  return new Request(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('PATCH /skattekonto/transaktioner/:id/ignore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns 500 without an extension context', async () => {
    const res = await findRoute().handler(makeRequest({ is_ignored: true }))
    expect(res.status).toBe(500)
  })

  it('returns 400 without a transaction id', async () => {
    const res = await findRoute().handler(makeRequest({ is_ignored: true }, null), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await findRoute().handler(makeRequest('not json{'), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects a non-boolean is_ignored with 400', async () => {
    const res = await findRoute().handler(makeRequest({ is_ignored: 'yes' }), makeContext())
    expect(res.status).toBe(400)
  })

  it('returns 404 when the row does not exist for the company', async () => {
    enqueue({ data: null, error: { message: 'No rows' } }) // select .single()
    const res = await findRoute().handler(makeRequest({ is_ignored: true }), makeContext())
    expect(res.status).toBe(404)
  })

  it('refuses to ignore a booked row with 409', async () => {
    enqueue({ data: { id: ROW_ID, journal_entry_id: 'je-1', is_ignored: false } })
    const res = await findRoute().handler(makeRequest({ is_ignored: true }), makeContext())
    expect(res.status).toBe(409)
    // No write was attempted.
    expect(findCalls('skattekonto_transactions', 'update')).toHaveLength(0)
  })

  it('ignores an unbooked row and guards the write on journal_entry_id IS NULL', async () => {
    enqueue({ data: { id: ROW_ID, journal_entry_id: null, is_ignored: false } })
    enqueue({ data: [{ id: ROW_ID }] }) // conditional update claimed the row
    const res = await findRoute().handler(makeRequest({ is_ignored: true }), makeContext())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toEqual({ ok: true, is_ignored: true })

    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toEqual({ is_ignored: true })
    // The `.is('journal_entry_id', null)` race guard must be on the write.
    expect(findCalls('skattekonto_transactions', 'is')).toContainEqual([
      'journal_entry_id',
      null,
    ])
  })

  it('returns 409 when a concurrent booking wins the race (zero rows updated)', async () => {
    enqueue({ data: { id: ROW_ID, journal_entry_id: null, is_ignored: false } })
    enqueue({ data: [] }) // conditional update matched nothing
    const res = await findRoute().handler(makeRequest({ is_ignored: true }), makeContext())
    expect(res.status).toBe(409)
  })

  it('unignores a row without the journal_entry_id guard', async () => {
    enqueue({ data: { id: ROW_ID, journal_entry_id: null, is_ignored: true } })
    enqueue({ data: [{ id: ROW_ID }] })
    const res = await findRoute().handler(makeRequest({ is_ignored: false }), makeContext())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toEqual({ ok: true, is_ignored: false })
    expect(findCalls('skattekonto_transactions', 'is')).toHaveLength(0)
  })
})
