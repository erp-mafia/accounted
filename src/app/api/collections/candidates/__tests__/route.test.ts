/**
 * GET /api/collections/candidates through the real withRouteContext over an
 * in-memory database: 401 without a session, 400 on a bad query, 503 while
 * collections is dark (a start path), and the overdue invoices with the
 * checks each passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCaseWorld, invoiceRow, INVOICE_ID, type CaseWorld } from '@/lib/collections/__tests__/case-fixtures'
import { ADMIN_ID, COMPANY_ID } from '@/lib/collections/__tests__/memory-supabase'

let world: CaseWorld

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => world.db.client, createClient: async () => world.db.client }))
const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const call = (query = '') => GET(new Request(`http://localhost/api/collections/candidates${query}`), { params: Promise.resolve({}) })

interface Body {
  data: { candidates: Array<{ invoice_id: string; eligible: boolean; blocks: string[]; needs_attestation: boolean; remaining_amount: number }> }
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of ['COLLECTIONS_ENABLED', 'COLLECTIONS_PILOT_COMPANIES']) vi.stubEnv(k, '')
  world = await createCaseWorld()
  world.db.seed('invoices', [
    invoiceRow({ id: 'not-due', invoice_number: '20261043', due_date: '2099-01-01' }),
    invoiceRow({ id: 'tiny', invoice_number: '20261044', total: 50, vat_amount: 10, remaining_amount: 50 }),
  ])
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: world.db.client,
    error: null,
  })
  hasCapabilityMock.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/collections/candidates', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call()).status).toBe(401)
  })

  it('answers 400 for a bad query', async () => {
    expect((await call('?all=yes')).status).toBe(400)
  })

  it('answers 503 while collections is dark: listing candidates begins new work', async () => {
    expect((await call()).status).toBe(503)
  })

  it('lists the overdue invoices that can go, and with all=1 the ones that cannot and why', async () => {
    vi.stubEnv('COLLECTIONS_ENABLED', '1')
    vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY_ID)
    const res = await call()
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(body.data.candidates).toEqual([
      expect.objectContaining({ invoice_id: INVOICE_ID, eligible: true, blocks: [], needs_attestation: false, remaining_amount: 1250 }),
    ])

    const all = (await (await call('?all=1')).json()) as Body
    expect(all.data.candidates.map((c) => [c.invoice_id, c.blocks])).toEqual(
      expect.arrayContaining([
        [INVOICE_ID, []],
        ['tiny', ['elig_below_minimum']],
      ]),
    )
    // Not overdue yet: never a candidate.
    expect(all.data.candidates.find((c) => c.invoice_id === 'not-due')).toBeUndefined()
  })
})
