import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route delegates to the booking function: stub it so these tests cover
// the route's parsing, override flag and error-to-status mapping only (the
// guard itself is covered in skattekonto-booking-batch.test.ts and the search
// in skattekonto-match-twins.test.ts).
vi.mock('../lib/skattekonto-booking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-booking')>()
  return {
    ...actual,
    bokforSkattekontoTransaction: vi.fn(),
  }
})

import { skatteverketExtension } from '../index'
import {
  bokforSkattekontoTransaction,
  SkattekontoBookingError,
} from '../lib/skattekonto-booking'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { SkattekontoLedgerTwin } from '@/types/skatteverket'

const ROUTE_PATH = '/skattekonto/transaktioner/:id/bokfor'
const ROW_ID = '11111111-1111-4111-8111-111111111111'

const TWIN: SkattekontoLedgerTwin = {
  journal_entry_id: 'je-185',
  voucher_series: 'A',
  voucher_number: 185,
  entry_date: '2026-01-15',
  description: 'Kostnadsränta',
  status: 'posted',
}

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === ROUTE_PATH,
  )
  if (!route) throw new Error('bokfor route not registered')
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

/** The dispatcher hands the :id path param over as `_id`. */
function makeRequest(body?: unknown, id: string | null = ROW_ID): Request {
  const url = new URL('http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner/x/bokfor')
  if (id) url.searchParams.set('_id', id)
  return new Request(url.toString(), {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
  })
}

describe('POST /skattekonto/transaktioner/:id/bokfor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 500 without an extension context (the dispatcher authenticates first)', async () => {
    const res = await findRoute().handler(makeRequest())
    expect(res.status).toBe(500)
    expect(vi.mocked(bokforSkattekontoTransaction)).not.toHaveBeenCalled()
  })

  it('rejects a missing id with 400', async () => {
    const res = await findRoute().handler(makeRequest(undefined, null), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await findRoute().handler(makeRequest('not json{'), makeContext())
    expect(res.status).toBe(400)
    expect(vi.mocked(bokforSkattekontoTransaction)).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean allow_duplicate with 400', async () => {
    const res = await findRoute().handler(makeRequest({ allow_duplicate: 'yes' }), makeContext())
    expect(res.status).toBe(400)
    expect(vi.mocked(bokforSkattekontoTransaction)).not.toHaveBeenCalled()
  })

  it('maps TRANSACTION_NOT_FOUND to 404', async () => {
    vi.mocked(bokforSkattekontoTransaction).mockRejectedValue(
      new SkattekontoBookingError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND'),
    )
    const res = await findRoute().handler(makeRequest(), makeContext())
    expect(res.status).toBe(404)
  })

  it('creates the draft with the guard on when there is no body (the historical call)', async () => {
    vi.mocked(bokforSkattekontoTransaction).mockResolvedValue({ id: 'je-draft-1' } as never)
    const ctx = makeContext()
    const res = await findRoute().handler(makeRequest(), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).data.entry.id).toBe('je-draft-1')
    expect(vi.mocked(bokforSkattekontoTransaction)).toHaveBeenCalledWith(
      ctx.supabase,
      'company-1',
      'user-1',
      ROW_ID,
      undefined,
      { allowDuplicate: false },
    )
  })

  it('answers LEDGER_TWIN_EXISTS with 409, the Swedish reason and the twins', async () => {
    vi.mocked(bokforSkattekontoTransaction).mockRejectedValue(
      new SkattekontoBookingError('Händelsen finns redan i bokföringen.', 'LEDGER_TWIN_EXISTS', [TWIN]),
    )
    const res = await findRoute().handler(makeRequest(), makeContext())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Händelsen finns redan i bokföringen.',
      code: 'LEDGER_TWIN_EXISTS',
      ledger_twins: [TWIN],
    })
  })

  it('passes allow_duplicate: true through as the override', async () => {
    vi.mocked(bokforSkattekontoTransaction).mockResolvedValue({ id: 'je-draft-2' } as never)
    const res = await findRoute().handler(makeRequest({ allow_duplicate: true }), makeContext())
    expect(res.status).toBe(200)
    expect(vi.mocked(bokforSkattekontoTransaction).mock.calls[0][5]).toEqual({ allowDuplicate: true })
  })
})
