/**
 * The cron shell around the hunt: authorization, the allowlist kill-switch,
 * aggregation, and per-company isolation. The ranking itself is covered by
 * lib/receipt-hunt/__tests__/select.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({})),
}))

const mockHuntCompany = vi.fn()
vi.mock('@/lib/receipt-hunt/hunt', async () => {
  // resolveAllowlist is pure and part of what this route's behaviour depends
  // on, so it stays real; only the database-touching half is faked.
  const actual = await vi.importActual<typeof import('@/lib/receipt-hunt/hunt')>(
    '@/lib/receipt-hunt/hunt',
  )
  return { ...actual, huntCompany: (...args: unknown[]) => mockHuntCompany(...args) }
})

import { verifyCronSecret } from '@/lib/auth/cron'
import { createServiceClient } from '@/lib/supabase/server'
import { GET } from '../route'

const ORIGINAL_ALLOWLIST = process.env.RECEIPT_HUNT_COMPANY_IDS

function request(): Request {
  return new Request('https://app.accounted.se/api/receipt-hunt/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  mockHuntCompany.mockReset()
})

afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.RECEIPT_HUNT_COMPANY_IDS
  else process.env.RECEIPT_HUNT_COMPANY_IDS = ORIGINAL_ALLOWLIST
})

describe('GET /api/receipt-hunt/cron', () => {
  it('rejects an unauthorized caller without touching the database', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )
    process.env.RECEIPT_HUNT_COMPANY_IDS = 'co-1'

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('hunts nobody when the allowlist is unset', async () => {
    delete process.env.RECEIPT_HUNT_COMPANY_IDS

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, skipped: true, total: 0 })
    expect(mockHuntCompany).not.toHaveBeenCalled()
    // Fail-safe matters more than the response shape: an empty variable must
    // never be read as "every company".
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
  })

  it('hunts nobody when the allowlist is blank or comma-only', async () => {
    process.env.RECEIPT_HUNT_COMPANY_IDS = ' , ,, '

    const body = await (await GET(request())).json()

    expect(body.skipped).toBe(true)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('runs each allowlisted company and aggregates what was proposed', async () => {
    process.env.RECEIPT_HUNT_COMPANY_IDS = 'co-1, co-2'
    mockHuntCompany
      .mockResolvedValueOnce({ companyId: 'co-1', candidates: 9, poolSize: 4, proposed: 3 })
      .mockResolvedValueOnce({ companyId: 'co-2', candidates: 2, poolSize: 0, proposed: 0 })

    const body = await (await GET(request())).json()

    expect(mockHuntCompany).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ success: true, total: 2, succeeded: 2, failed: 0, proposed: 3 })
    expect(body.results).toHaveLength(2)
    // Every proposal from one night shares a run id so the run can be read back.
    expect(body.runId).toEqual(expect.any(String))
    const [, companyId, runId] = mockHuntCompany.mock.calls[0]
    expect(companyId).toBe('co-1')
    expect(runId).toBe(body.runId)
  })

  it('lets one company fail without stopping the rest', async () => {
    process.env.RECEIPT_HUNT_COMPANY_IDS = 'co-1,co-2'
    mockHuntCompany
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ companyId: 'co-2', candidates: 5, poolSize: 2, proposed: 1 })

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ success: true, total: 2, succeeded: 1, failed: 1, proposed: 1 })
    expect(body.failures).toHaveLength(1)
  })
})
