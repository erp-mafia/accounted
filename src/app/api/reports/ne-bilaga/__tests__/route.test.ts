/**
 * Tests for GET /api/reports/ne-bilaga (cookie session, withRouteContext). The
 * declaration engine is mocked; the wrapper and the SRU generator are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}))
// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
const generateMock = vi.fn()
vi.mock('@/lib/reports/ne-bilaga/ne-engine', () => ({
  generateNEDeclaration: (...args: unknown[]) => generateMock(...args),
}))

import { GET } from '../route'

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const routeCtx = createMockRouteParams({})
const BLOCKER =
  'Konto 8470 Egen post (100,00 kr debet) hör inte till någon ruta i NE-bilagan. SRU-filen kan inte laddas ner förrän beloppen är bokförda på BAS-konton som hör till en ruta.'

/** A minimal declaration with one SRU blocker. */
function blockedDeclaration() {
  return {
    fiscalYear: { id: PERIOD_ID, name: 'Räkenskapsår 2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    rutor: { R1: 480_000, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0, R9: 0, R10: 0, R11: 480_000 },
    breakdown: {},
    companyInfo: { companyName: 'Testfirman', orgNumber: '198001011234', addressLine1: null, postalCode: null, city: null, email: null },
    warnings: [BLOCKER],
    bookedResult: 479_900,
    sruBlockers: [BLOCKER],
  }
}

describe('GET /api/reports/ne-bilaga', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    generateMock.mockResolvedValue(blockedDeclaration())
  })

  it('answers a blocked SRU download with 422 and the reason, not a generation failure', async () => {
    const res = await GET(
      createMockRequest(`http://localhost/api/reports/ne-bilaga?period_id=${PERIOD_ID}&format=sru`),
      routeCtx,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: { reason?: string } } }>(res)
    expect(status).toBe(422)
    expect(body.error.code).toBe('TAX_DECL_NE_SRU_BLOCKED')
    expect(body.error.details?.reason).toContain('Konto 8470')
  })

  it('still returns the blocked declaration as JSON, so the reason can be shown', async () => {
    const res = await GET(createMockRequest(`http://localhost/api/reports/ne-bilaga?period_id=${PERIOD_ID}`), routeCtx)
    const { status, body } = await parseJsonResponse<{ data: { sruBlockers: string[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.sruBlockers).toEqual([BLOCKER])
  })
})
