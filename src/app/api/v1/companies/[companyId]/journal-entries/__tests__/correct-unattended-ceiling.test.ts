/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct on a key
 * with an unattended ceiling (#125): a correction posts two verifikat, the
 * storno and the corrected one, and the door refuses before the storno
 * service runs when either is above the ceiling, on a dry run too. A refusal
 * after the storno had posted would leave it to be cancelled again.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const state = vi.hoisted(() => ({ client: null as unknown }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn(() => state.client) }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }) }))
// Where the storno lands (storno-target.test.ts): the original's own date here.
vi.mock('@/lib/core/bookkeeping/storno-target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-target')>()),
  assertStornoTarget: vi.fn(async (_s: unknown, _c: unknown, original: { entry_date: string; fiscal_period_id: string }) => ({
    date: original.entry_date,
    fiscal_period_id: original.fiscal_period_id,
    moved: false,
  })),
}))
vi.mock('@/lib/core/bookkeeping/correction-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/correction-chain')>()),
  correctionChainDepth: vi.fn().mockResolvedValue({ depth: 0, rootVoucher: null }),
}))
vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
}))

const { validateApiKey } = await import('@/lib/auth/api-keys')
const { correctEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { POST } = await import('../[id]/correct/route')

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const ENTRY = '00000000-0000-4000-8000-0000000e0001'

let idempotency = 0

function call(body: unknown, query = ''): Promise<Response> {
  const request = new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries/${ENTRY}/correct${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `correct-ceiling-${++idempotency}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  })
  return POST(request, { params: Promise.resolve({ companyId: COMPANY, id: ENTRY }) } as never)
}

const lines = (amount: number) => [
  { account_number: '6590', debit_amount: amount, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: amount },
]

describe('v1 correct: unattended ceiling (#125)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'Bokföringsrobot',
      scopes: ['bookkeeping:read', 'bookkeeping:write'],
      mode: 'live',
      unattendedCommitLimit: 10000,
    } as never)
    vi.mocked(correctEntry).mockResolvedValue({
      reversal: { id: 'storno-1', voucher_series: 'A', voucher_number: 48 },
      corrected: { id: 'correction-1', voucher_series: 'A', voucher_number: 49 },
    } as never)
    const mock = createTableMockSupabase({
      business_events: { data: null },
      company_members: { data: { company_id: COMPANY, role: 'owner' } },
      journal_entries: {
        data: {
          id: ENTRY,
          status: 'posted',
          entry_date: '2026-10-27',
          voucher_series: 'A',
          correction_of_id: null,
          reverses_id: null,
          lines: [
            { account_number: '6570', debit_amount: '100.00', credit_amount: '0' },
            { account_number: '1930', debit_amount: '0', credit_amount: '100.00' },
          ],
        },
      },
    })
    state.client = mock.supabase
  })

  it('refuses a correction to 15 000 kr on a key capped at 10 000 before the storno is posted', async () => {
    const response = await call({ lines: lines(15000) })
    const body = (await response.json()) as { error: { code: string; details?: Record<string, unknown> } }

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    expect(body.error.details).toMatchObject({ attempted: 15000, limit: 10000 })
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('gives a dry run the same verdict', async () => {
    expect((await call({ lines: lines(15000) }, '?dry_run=true')).status).toBe(403)
  })

  it('corrects within the ceiling', async () => {
    const response = await call({ lines: lines(100) })

    expect(response.status).toBe(200)
    expect(correctEntry).toHaveBeenCalledTimes(1)
  })
})
