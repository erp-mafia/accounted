/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct of a
 * verifikat a booked salary run names, in an open year: refused with 409
 * SALARY_RUN_CORRECTION_OWN_FLOW before the storno service runs, on a dry run
 * too, so the run is corrected with Korrigera lönekörning. A salary_payment
 * verifikat the run does not name goes through (own-correction-flow.test.ts
 * has the rule per register).
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
// Where the storno lands (storno-target.test.ts): the original's own date, in an open year.
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
const RUN = '00000000-0000-4000-8000-0000000a0001'

const LINES = [
  { account_number: '7210', debit_amount: 30000, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 30000 },
]

let idempotency = 0

function call(query = ''): Promise<Response> {
  const request = new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries/${ENTRY}/correct${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `own-flow-${++idempotency}-${Date.now()}`,
    },
    body: JSON.stringify({ lines: LINES }),
  })
  return POST(request, { params: Promise.resolve({ companyId: COMPANY, id: ENTRY }) } as never)
}

/** The client, with the run naming `salaryEntryId` as its salary verifikat. */
function client(salaryEntryId: string) {
  const original = {
    id: ENTRY,
    status: 'posted',
    entry_date: '2026-03-25',
    fiscal_period_id: 'fp-2026',
    voucher_series: 'A',
    correction_of_id: null,
    reverses_id: null,
    source_type: 'salary_payment',
    source_id: RUN,
    lines: [
      { account_number: '7210', debit_amount: '28000.00', credit_amount: '0' },
      { account_number: '1930', debit_amount: '0', credit_amount: '28000.00' },
    ],
  }
  return createTableMockSupabase({
    business_events: { data: null },
    company_members: { data: { company_id: COMPANY, role: 'owner' } },
    // The original by id, and the run's verifikat by .in(): the same row.
    journal_entries: (chain) => (chain.some(({ method }) => method === 'in') ? { data: [original] } : { data: original }),
    salary_runs: {
      data: {
        id: RUN,
        status: 'booked',
        period_year: 2026,
        period_month: 3,
        salary_entry_id: salaryEntryId,
        avgifter_entry_id: null,
        vacation_entry_id: null,
        pension_entry_id: null,
      },
    },
  }).supabase
}

describe('v1 correct: a verifikat a booked salary run names', () => {
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
      corrected: { id: 'correction-1', voucher_series: 'A', voucher_number: 49, entry_date: '2026-03-25' },
    } as never)
  })

  it('refuses it in an open year with 409 SALARY_RUN_CORRECTION_OWN_FLOW, naming the run, and posts nothing', async () => {
    state.client = client(ENTRY)
    const response = await call()
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: { salaryRunId?: string }; recovery_hint?: string }
    }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_CORRECTION_OWN_FLOW')
    expect(body.error.details?.salaryRunId).toBe(RUN)
    expect(body.error.message).toMatch(/Korrigera lönekörning/)
    expect(body.error.recovery_hint).toMatch(/gnubok_correct_salary_run/)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('gives a dry run the same verdict', async () => {
    state.client = client(ENTRY)
    const response = await call('?dry_run=true')
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_CORRECTION_OWN_FLOW')
  })

  it('lets a salary_payment verifikat the run does not name through', async () => {
    state.client = client('00000000-0000-4000-8000-0000000e0099')
    const response = await call()

    expect(response.status).toBe(200)
    expect(correctEntry).toHaveBeenCalledTimes(1)
  })
})
