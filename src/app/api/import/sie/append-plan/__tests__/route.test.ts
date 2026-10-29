/**
 * POST /api/import/sie/append-plan: the wizard's "Lägg till nya verifikat"
 * preview (issue #108). Runs through the real withRouteContext wrapper; the
 * planner itself is covered by lib/import/__tests__/sie-append.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/import/sie-append', () => ({ planSIEAppend: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-jobs')>()),
  resolveSIEFiscalYear: vi.fn(async () => undefined),
}))

import { planSIEAppend } from '@/lib/import/sie-append'
import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const SIE = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" "3.0"', '#SIETYP 4', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Bank"', '#KONTO 3001 "Försäljning"',
  '#VER A 7 20261215 "Faktura 7"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')

const MAPPINGS = ['1930', '3001'].map((number) => ({
  sourceAccount: number, sourceName: 'Konto', targetAccount: number, targetName: 'Konto',
  confidence: 1, matchType: 'exact', isOverride: false,
}))

function request(fields: Record<string, string | File>): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return new Request('http://localhost:3000/api/import/sie/append-plan', { method: 'POST', body: form })
}

const PLAN = {
  fiscalPeriodId: 'period-2026', baseImportId: 'base-import', fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
  counts: { total: 1, present: 0, conflicts: 0, possibleDuplicates: 0, new: 1, toAdd: 1 },
  vouchers: [], vouchersTruncated: false, series: [], yearSeries: ['A'], warnings: [], refusal: null,
}

describe('POST /api/import/sie/append-plan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    vi.mocked(planSIEAppend).mockResolvedValue(PLAN as never)
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(request({ file: new File([SIE], 'append.se') }), emptyParams)
    expect(response.status).toBe(401)
    expect(planSIEAppend).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is attached', async () => {
    const response = await POST(request({}), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('SIE_PARSE_NO_FILE')
  })

  it('returns 400 for a series map that is not text to text', async () => {
    const response = await POST(request({ file: new File([SIE], 'append.se'), options: JSON.stringify({ seriesMap: { K: '' } }) }),
      emptyParams)
    expect(response.status).toBe(400)
    expect(planSIEAppend).not.toHaveBeenCalled()
  })

  it('returns 404 when the uploaded file is gone from storage', async () => {
    const missing = { ...supabase, storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'Object not found' } }) }) } }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: missing })
    const response = await POST(request({
      storagePath: 'company-1/sie-intake/0b6f2d4e-8a51-4c3e-9f1a-2a7d6c5b4e3f.se', filename: 'append.se',
    }), emptyParams)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  })

  it('returns the plan for the file, the given mappings and options', async () => {
    const response = await POST(request({
      file: new File([SIE], 'append.se'), mappings: JSON.stringify(MAPPINGS),
      options: JSON.stringify({ includePossibleDuplicates: true, seriesMap: { K: 'A' } }),
    }), emptyParams)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual(PLAN)
    const [, companyId, parsed, mappings, options] = vi.mocked(planSIEAppend).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(parsed.vouchers).toHaveLength(1)
    expect(mappings.map((m) => m.targetAccount)).toEqual(['1930', '3001'])
    expect(options).toEqual({ includePossibleDuplicates: true, seriesMap: { K: 'A' } })
  })

  it('suggests the mappings the import would use when none are sent', async () => {
    enqueue({ data: [] }) // stored mappings
    const response = await POST(request({ file: new File([SIE], 'append.se') }), emptyParams)
    expect(response.status).toBe(200)
    const [, , , mappings] = vi.mocked(planSIEAppend).mock.calls[0]
    expect(mappings.map((m) => [m.sourceAccount, m.targetAccount])).toEqual([['1930', '1930'], ['3001', '3001']])
  })
})
