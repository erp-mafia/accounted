/**
 * The cron shell around the arrival matcher: authorization, the extension
 * gate, one run per company with unconsumed documents, and isolation of a
 * failing company from the rest. The planning itself is covered by
 * lib/underlag/__tests__/arrival-match.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: vi.fn() },
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({})),
}))
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn(),
}))
vi.mock('@/lib/underlag/arrival-match', async () => {
  const actual = await vi.importActual<typeof import('@/lib/underlag/arrival-match')>('@/lib/underlag/arrival-match')
  return { ...actual, runArrivalMatch: vi.fn() }
})

import { GET } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { runArrivalMatch } from '@/lib/underlag/arrival-match'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerify = vi.mocked(verifyCronSecret)
const mockFetchAll = vi.mocked(fetchAllRows)
const mockRun = vi.mocked(runArrivalMatch)

function request(): Request {
  return new Request('https://app.accounted.se/api/extensions/invoice-inbox/arrival-match/cron')
}

describe('GET /api/extensions/invoice-inbox/arrival-match/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockReturnValue(null)
    mockRegistryGet.mockReturnValue({ id: 'invoice-inbox' } as never)
  })

  it('refuses without the cron secret', async () => {
    mockVerify.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('refuses with 503 when the extension is disabled', async () => {
    mockRegistryGet.mockReturnValue(undefined as never)
    const res = await GET(request())
    expect(res.status).toBe(503)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('runs once per company with unconsumed documents and sums the outcome', async () => {
    mockFetchAll.mockResolvedValue([
      { company_id: 'co-1' },
      { company_id: 'co-1' },
      { company_id: 'co-2' },
    ] as never)
    mockRun
      .mockResolvedValueOnce({ companyId: 'co-1', runId: 'r', mode: 'act', items: 2, transactions: 10, linked: 1, proposed: 1, skipped: 0, decisions: [] })
      .mockResolvedValueOnce({ companyId: 'co-2', runId: 'r', mode: 'act', items: 1, transactions: 4, linked: 0, proposed: 0, skipped: 1, decisions: [] })
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { companies: number; linked: number; proposed: number; skipped: number; failed: number } }
    expect(body.data).toMatchObject({ companies: 2, linked: 1, proposed: 1, skipped: 1, failed: 0 })
    expect(mockRun).toHaveBeenCalledTimes(2)
    expect(mockRun.mock.calls[0][2]).toMatchObject({ trigger: 'cron' })
  })

  it('keeps going when one company fails', async () => {
    mockFetchAll.mockResolvedValue([{ company_id: 'co-1' }, { company_id: 'co-2' }] as never)
    mockRun
      .mockRejectedValueOnce(new Error('rate service down'))
      .mockResolvedValueOnce({ companyId: 'co-2', runId: 'r', mode: 'act', items: 1, transactions: 4, linked: 0, proposed: 1, skipped: 0, decisions: [] })
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { failed: number; proposed: number } }
    expect(body.data.failed).toBe(1)
    expect(body.data.proposed).toBe(1)
  })
})
