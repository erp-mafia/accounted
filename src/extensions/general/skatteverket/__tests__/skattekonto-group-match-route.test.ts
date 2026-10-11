import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The ledger cover (rows a summarised verifikat already holds, crm#1043) is
// the reconciliation bridge's arithmetic, covered in its own tests: stubbed
// here. Default: the bridge has nothing (no cover), as before.
const bridgeMock = vi.fn()
vi.mock('@/lib/reconciliation/skattekonto-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/skattekonto-reconciliation')>()
  return { ...actual, getSkattekontoReconciliationStatus: (...args: unknown[]) => bridgeMock(...args) }
})

import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * POST /skattekonto/transaktioner/group-match-candidates
 *
 * The bulk bar's "Matcha mot verifikat": candidate verifikat for several
 * ticked rows together. A read; linking goes through POST /:id/match.
 */

const ROUTE_PATH = '/skattekonto/transaktioner/group-match-candidates'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === ROUTE_PATH,
  )
  if (!route) throw new Error('group-match-candidates route not registered')
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

function makeRequest(body: unknown): Request {
  return new Request(
    'http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner/group-match-candidates',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  )
}

function skvRow(id: string, belopp: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    transaktionsdatum: '2026-04-04',
    transaktionstext: 'Intäktsränta',
    belopp_skatteverket: belopp,
    journal_entry_id: null,
    is_ignored: false,
    status: 'booked',
    ...extra,
  }
}

/** The bridge's answer: these open rows are already inside an unlinked verifikat on 1630. */
function coverFor(...ids: string[]) {
  return {
    ledger_read_failed: false,
    cover: {
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_ids: ids,
      event_count: ids.length,
      event_total: 600,
      entries: [
        {
          journal_entry_id: 'je-year-end',
          voucher_number: 1,
          voucher_series: 'B',
          entry_date: '2026-12-31',
          description: 'Skattekonto 2026',
          status: 'posted',
          open_amount: 37887.25,
        },
      ],
      entry_total: 37887.25,
    },
  }
}

describe('POST /skattekonto/transaktioner/group-match-candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    bridgeMock.mockResolvedValue(null)
  })

  it('returns 500 without an extension context', async () => {
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }))
    expect(res.status).toBe(500)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await findRoute().handler(makeRequest('not json{'), makeContext())
    expect(res.status).toBe(400)
  })

  it.each([
    { label: 'missing transaction_ids', body: {} },
    { label: 'one id', body: { transaction_ids: [ID_A] } },
    {
      label: 'more than 50 ids',
      body: {
        transaction_ids: Array.from(
          { length: 51 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    },
    { label: 'non-string ids', body: { transaction_ids: [1, 2] } },
    { label: 'ids that are not uuids', body: { transaction_ids: ['a', 'b'] } },
  ])('rejects $label with 400', async ({ body }) => {
    const res = await findRoute().handler(makeRequest(body), makeContext())
    expect(res.status).toBe(400)
  })

  it('returns 404 when a row does not exist for the company', async () => {
    enqueue({ data: [skvRow(ID_A, 1000)] })
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('TRANSACTION_NOT_FOUND')
  })

  it('returns 409 when a row is already linked', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400, { journal_entry_id: 'je-1' })] })
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ALREADY_BOOKED')
  })

  it('returns 409 when a row is ignored', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400, { is_ignored: true })] })
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ROW_IGNORED')
  })

  it('returns 422 when a row is still kommande', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400, { status: 'upcoming' })] })
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('INVALID_CANDIDATE')
  })

  it('returns 500 when the ledger read fails', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400)] })
    enqueue({ data: null, error: { message: 'timeout' } })
    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(res.status).toBe(500)
  })

  it('lists the voucher the selected rows settle together', async () => {
    const netInterest = {
      id: 'net-interest',
      voucher_number: 40,
      voucher_series: 'A',
      entry_date: '2026-04-04',
      description: 'Intäktsränta',
      status: 'posted',
      company_id: 'company-1',
      reverses_id: null,
      reversed_by_id: null,
    }
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400, { transaktionstext: 'Korrigerad intäktsränta' })] })
    enqueue({ data: [netInterest] }) // 1630 entries in the window
    enqueue({ data: [{ id: 'l-1', journal_entry_id: 'net-interest', debit_amount: 600, credit_amount: 0 }] })
    enqueue({ data: [] }) // no rows linked to them yet
    enqueue({ data: [netInterest] }) // storno check: entries
    enqueue({ data: [{ id: 'l-1', journal_entry_id: 'net-interest', debit_amount: 600, credit_amount: 0 }] })
    enqueue({
      data: [
        { id: 'a-1', journal_entry_id: 'net-interest', account_number: '1630', debit_amount: 600, credit_amount: 0 },
        { id: 'a-2', journal_entry_id: 'net-interest', account_number: '8314', debit_amount: 0, credit_amount: 600 },
      ],
    })

    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.candidates).toHaveLength(1)
    expect(json.data.candidates[0]).toMatchObject({
      journal_entry_id: 'net-interest',
      voucher_number: 40,
      matched_amount: 600,
      matched_side: 'debit',
    })
  })

  it('says when a summarised verifikat already holds every ticked row, so the dialog points at Matcha manuellt (crm#1043)', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400)] })
    // No 1630 entry settles the two rows: the window read finds nothing.
    bridgeMock.mockResolvedValue(coverFor(ID_A, ID_B, 'another-row'))

    const res = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.candidates).toEqual([])
    expect(json.data.ledger_cover).toMatchObject({
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_count: 3,
      entry_count: 1,
      entries: [{ journal_entry_id: 'je-year-end', open_amount: 37887.25 }],
    })
  })

  it('says nothing when the cover does not hold ALL the ticked rows, or when the bridge cannot be read', async () => {
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400)] })
    bridgeMock.mockResolvedValue(coverFor(ID_A))
    const partial = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(partial.status).toBe(200)
    expect((await partial.json()).data).toEqual({ candidates: [] })

    reset()
    enqueue({ data: [skvRow(ID_A, 1000), skvRow(ID_B, -400)] })
    bridgeMock.mockRejectedValue(new Error('timeout'))
    const failed = await findRoute().handler(makeRequest({ transaction_ids: [ID_A, ID_B] }), makeContext())
    expect(failed.status).toBe(200)
    expect((await failed.json()).data).toEqual({ candidates: [] })
  })
})

describe('GET /skattekonto/transaktioner/:id/match-candidates', () => {
  const route = () => {
    const found = skatteverketExtension.apiRoutes?.find(
      (r) => r.method === 'GET' && r.path === '/skattekonto/transaktioner/:id/match-candidates',
    )
    if (!found) throw new Error('match-candidates route not registered')
    return found
  }
  const request = (id: string) =>
    new Request(
      `http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner/${id}/match-candidates?_id=${id}`,
    )

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    bridgeMock.mockResolvedValue(null)
  })

  it('a row with no candidate and no cover answers as before: an empty list', async () => {
    enqueue({ data: skvRow(ID_A, -8000) }) // the row; every later read finds nothing
    const res = await route().handler(request(ID_A), makeContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ candidates: [] })
  })

  it('a row a summarised verifikat already holds carries ledger_cover, the answer "Skapa manuellt" and Koppla show (crm#1043)', async () => {
    enqueue({ data: skvRow(ID_A, -8000) })
    bridgeMock.mockResolvedValue(coverFor(ID_A, ID_B))
    const res = await route().handler(request(ID_A), makeContext())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.candidates).toEqual([])
    expect(json.data.ledger_cover).toMatchObject({ through_date: '2026-12-31', event_count: 2, entry_count: 1 })
  })
})
