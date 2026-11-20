/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct with lines
 * that are the original with debit and credit swapped (crm#1397): the storno
 * already reverses the original, so the door refuses before the storno
 * service runs, on a dry run too, unless sides_swapped says the original
 * itself was booked the wrong way round.
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

const SWAPPED = [
  { account_number: '6570', debit_amount: 0, credit_amount: 100 },
  { account_number: '1930', debit_amount: 100, credit_amount: 0 },
]

let idempotency = 0

function call(body: unknown, query = ''): Promise<Response> {
  const request = new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries/${ENTRY}/correct${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `second-reversal-${++idempotency}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  })
  return POST(request, { params: Promise.resolve({ companyId: COMPANY, id: ENTRY }) } as never)
}

describe('v1 correct: a second reversal (crm#1397)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['bookkeeping:read', 'bookkeeping:write'],
      mode: 'live',
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

  it('refuses the swapped lines with 400 MEANINGLESS_CORRECTION negates_original and posts nothing', async () => {
    const response = await call({ lines: SWAPPED })
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('MEANINGLESS_CORRECTION')
    expect(body.error.details?.reason).toBe('negates_original')
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('gives a dry run the same verdict', async () => {
    const response = await call({ lines: SWAPPED }, '?dry_run=true')
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }

    expect(response.status).toBe(400)
    expect(body.error.details?.reason).toBe('negates_original')
  })

  it('posts them when sides_swapped says the original had debit and credit swapped', async () => {
    const response = await call({ lines: SWAPPED, sides_swapped: true })

    expect(response.status).toBe(200)
    expect(correctEntry).toHaveBeenCalledTimes(1)
    expect(vi.mocked(correctEntry).mock.calls[0][5]).toMatchObject({ sidesSwapped: true })
  })

  it('lets a real correction through without the flag', async () => {
    const response = await call({
      lines: [
        { account_number: '6590', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ],
    })

    expect(response.status).toBe(200)
    expect(vi.mocked(correctEntry).mock.calls[0][5]).not.toHaveProperty('sidesSwapped')
  })
})
