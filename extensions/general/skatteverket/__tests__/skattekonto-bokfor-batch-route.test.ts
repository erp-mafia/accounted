import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route delegates to the batch function: stub it so these tests cover
// the route's validation/envelope behaviour only (the batch logic itself is
// covered in skattekonto-booking-batch.test.ts).
vi.mock('../lib/skattekonto-booking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-booking')>()
  return {
    ...actual,
    bokforSkattekontoTransactionsBatch: vi.fn(),
  }
})

import { skatteverketExtension } from '../index'
import { bokforSkattekontoTransactionsBatch } from '../lib/skattekonto-booking'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { SkattekontoBatchResult } from '@/types/skatteverket'

const ROUTE_PATH = '/skattekonto/transaktioner/bokfor-batch'
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === ROUTE_PATH,
  )
  if (!route) throw new Error('bokfor-batch route not registered')
  return route
}

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: vi.fn() } as any,
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

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/extensions/ext/skatteverket' + ROUTE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /skattekonto/transaktioner/bokfor-batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 500 without an extension context', async () => {
    const res = await findRoute().handler(makeRequest({ ids: [UUID_A] }))
    expect(res.status).toBe(500)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await findRoute().handler(makeRequest('not json{'), makeContext())
    expect(res.status).toBe(400)
    expect(vi.mocked(bokforSkattekontoTransactionsBatch)).not.toHaveBeenCalled()
  })

  it('rejects an empty ids list with 400', async () => {
    const res = await findRoute().handler(makeRequest({ ids: [] }), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects non-uuid ids with 400', async () => {
    const res = await findRoute().handler(
      makeRequest({ ids: ['abc; drop table'] }),
      makeContext(),
    )
    expect(res.status).toBe(400)
  })

  it('rejects more than 200 ids with 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) =>
      `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    )
    const res = await findRoute().handler(makeRequest({ ids }), makeContext())
    expect(res.status).toBe(400)
    expect(vi.mocked(bokforSkattekontoTransactionsBatch)).not.toHaveBeenCalled()
  })

  it('runs the batch and returns its results in the data envelope', async () => {
    const payload: SkattekontoBatchResult = {
      results: [
        { id: UUID_A, ok: true, journal_entry_id: 'je-1', voucher_number: 7, voucher_series: 'A' },
        { id: UUID_B, ok: false, error_code: 'PERIOD_LOCKED', error_message: 'Låst period' },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    }
    vi.mocked(bokforSkattekontoTransactionsBatch).mockResolvedValue(payload)

    const ctx = makeContext()
    const res = await findRoute().handler(makeRequest({ ids: [UUID_A, UUID_B] }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual(payload)
    expect(vi.mocked(bokforSkattekontoTransactionsBatch)).toHaveBeenCalledWith(
      ctx.supabase,
      'company-1',
      'user-1',
      [UUID_A, UUID_B],
    )
  })

  it('dedupes repeated ids before running the batch', async () => {
    vi.mocked(bokforSkattekontoTransactionsBatch).mockResolvedValue({
      results: [{ id: UUID_A, ok: true }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    })

    await findRoute().handler(makeRequest({ ids: [UUID_A, UUID_A] }), makeContext())
    expect(vi.mocked(bokforSkattekontoTransactionsBatch)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      [UUID_A],
    )
  })
})
