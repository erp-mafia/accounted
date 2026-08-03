/**
 * Tests for POST /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner —
 * input-bound validation. The schablonintäkt rate feeds the avsättning cap
 * base (IL 30 kap 25 % limit), so an unbounded rate would let a caller
 * inflate the legal ceiling; these tests lock the bounds in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/bokslut/dispositions-proposal-builder', () => ({
  buildDispositionsProposal: vi.fn(),
  buildLatentTaxProposal: vi.fn(),
}))

vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  loadTaxAdjustmentSnapshot: vi.fn(),
  saveTaxAdjustments: vi.fn(),
}))

vi.mock('@/lib/bokslut/tax-provision/bolagsskatt-calculator', () => ({
  calculateBolagsskatt: vi.fn(),
  getBookedBolagsskatt: vi.fn(),
  sumPostedYearEndDispositions: vi.fn(),
}))

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

vi.mock('@/lib/bokslut/reserves/periodiseringsfond-service', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/bokslut/reserves/periodiseringsfond-service')
  >()
  return { ...actual, listExistingPeriodiseringsfonder: vi.fn() }
})

vi.mock('@/lib/bokslut/reserves/overavskrivningar-calculator', () => ({
  calculateOveravskrivningar: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { buildDispositionsProposal } from '@/lib/bokslut/dispositions-proposal-builder'
import {
  loadTaxAdjustmentSnapshot,
  saveTaxAdjustments,
} from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import {
  calculateBolagsskatt,
  getBookedBolagsskatt,
  sumPostedYearEndDispositions,
} from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { listExistingPeriodiseringsfonder } from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { calculateOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-calculator'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { POST, PUT } from '../route'

const idParams = { params: Promise.resolve({ id: 'period-1' }) }

function post(body: unknown) {
  return POST(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/bokslutsdispositioner', {
      method: 'POST',
      body,
    }),
    idParams,
  )
}

function put(body: unknown) {
  return PUT(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/bokslutsdispositioner', {
      method: 'PUT',
      body,
    }),
    idParams,
  )
}

function periodClient(period: unknown, error: unknown = null) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue({ data: period, error }),
  }
  builder.select.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  return { from: vi.fn().mockReturnValue(builder) }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(buildDispositionsProposal).mockResolvedValue({
    entityType: 'aktiebolag',
    fiscalPeriod: {
      id: 'period-1',
      name: '2025',
      period_start: '2024-10-07',
      period_end: '2025-12-31',
    },
    netResultBefore: 592_722.21,
    proposals: [],
  })
  vi.mocked(saveTaxAdjustments).mockResolvedValue()
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue({
    items: [],
    nonDeductibleExpenses: 5_244,
    nonTaxableIncome: 0,
  })
  vi.mocked(generateIncomeStatement).mockResolvedValue({
    net_result: 592_722.21,
  } as Awaited<ReturnType<typeof generateIncomeStatement>>)
  vi.mocked(sumPostedYearEndDispositions).mockResolvedValue({
    total: 0,
    slpPortion: 0,
    taxProvisionPortion: 0,
  })
  vi.mocked(getBookedBolagsskatt).mockResolvedValue(0)
  vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([])
  vi.mocked(calculateOveravskrivningar).mockResolvedValue({
    status: 'not_applicable',
    proposal: null,
    warning: null,
    currentReserve: 0,
    currentPeriodChange: 0,
    targetReserve: 0,
    maximumSignedChange: 0,
  })
  vi.mocked(calculateBolagsskatt).mockResolvedValue({
    kind: 'bolagsskatt',
    label: 'Bolagsskatt 20,6 %',
    description: 'Skatt på årets skattemässiga resultat.',
    amount: 123_180,
    lines: [
      { account_number: '8910', debit_amount: 123_180, credit_amount: 0 },
      { account_number: '2512', debit_amount: 0, credit_amount: 123_180 },
    ],
    warnings: [],
  })
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'entry-tax' } as Awaited<
    ReturnType<typeof createJournalEntry>
  >)
})

describe('PUT /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner', () => {
  const validBody = {
    manualAdjustments: { nonDeductibleExpenses: 0, nonTaxableIncome: 0 },
    detectedAccounts: { '6992': true, '8423': true },
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await put(validBody)).status).toBe(401)
  })

  it('returns 400 for a negative manual adjustment', async () => {
    const res = await put({
      ...validBody,
      manualAdjustments: { nonDeductibleExpenses: -1, nonTaxableIncome: 0 },
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the fiscal period is missing', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: periodClient(null, { message: 'not found' }),
      error: null,
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await put(validBody),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('returns PERIOD_LOCKED when the fiscal period is locked', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: periodClient({
        id: 'period-1',
        is_closed: false,
        locked_at: '2026-07-21T08:00:00Z',
        closing_entry_id: null,
      }),
      error: null,
    })
    const { body } = await parseJsonResponse<{ error: { code: string } }>(await put(validBody))
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('saves the adjustments and returns the recalculated proposal', async () => {
    const supabase = periodClient({
      id: 'period-1',
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ data: { netResultBefore: number } }>(
      await put(validBody),
    )

    expect(status).toBe(200)
    expect(saveTaxAdjustments).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      'user-1',
      validBody,
    )
    expect(body.data.netResultBefore).toBe(592_722.21)
  })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post({ items: [{ kind: 'bolagsskatt' }] })
    expect(res.status).toBe(401)
  })

  it('rejects an inflated schablonintäkt rate (cap-base attack) with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_avsattning', schablonintaktRate: 100 }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects a negative desiredAmount with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_avsattning', desiredAmount: -50000 }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects negative återföring amounts with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_ateforing', returns: { '2129': -10000 } }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects an empty items array with 400', async () => {
    const { status } = await parseJsonResponse(await post({ items: [] }))
    expect(status).toBe(400)
  })

  it('rejects legacy client-supplied tax adjustments with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{
          kind: 'bolagsskatt',
          manualAdjustments: { nonDeductibleExpenses: 999_999 },
        }],
      }),
    )
    expect(status).toBe(400)
  })

  it('posts the calculated tax through the bookkeeping engine', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2024-10-07',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })

    const { status, body } = await parseJsonResponse<{
      data: { created: Array<{ kind: string }> }
    }>(await post({ items: [{ kind: 'bolagsskatt' }] }))

    expect(status).toBe(200)
    expect(body.data.created).toHaveLength(1)
    expect(createJournalEntry).toHaveBeenCalledOnce()
    expect(createJournalEntry).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ source_id: 'period-1' }),
    )
  })

  it('does not post a duplicate when the same tax is already booked', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2024-10-07',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    vi.mocked(getBookedBolagsskatt).mockResolvedValue(123_180)

    const { status, body } = await parseJsonResponse<{
      data: { created: Array<{ kind: string }> }
    }>(await post({ items: [{ kind: 'bolagsskatt' }] }))

    expect(status).toBe(200)
    expect(body.data.created).toEqual([])
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('posts a validated excess depreciation increase through the bookkeeping engine', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'ready',
      proposal: {
        kind: 'overavskrivningar',
        label: 'Överavskrivningar',
        description: 'Skillnad mellan bokförd och skattemässig avskrivning.',
        amount: 10_000,
        signedAmount: 10_000,
        lines: [
          { account_number: '8853', debit_amount: 10_000, credit_amount: 0 },
          { account_number: '2153', debit_amount: 0, credit_amount: 10_000 },
        ],
        warnings: [],
        computation: {
          openingBookValue: 80_000,
          closingBookValue: 70_000,
          openingTaxValue: 80_000,
          closingTaxValue: 60_000,
          taxDepreciation: 20_000,
          bookedDepreciation: 10_000,
          maxAdditionalDepreciation: 10_000,
          targetReserve: 10_000,
          currentReserve: 0,
          method: '30-rule',
        },
      },
      warning: null,
      currentReserve: 0,
      currentPeriodChange: 0,
      targetReserve: 10_000,
      maximumSignedChange: 10_000,
    })

    const { status, body } = await parseJsonResponse<{
      data: { created: Array<{ kind: string }> }
    }>(
      await post({
        items: [{ kind: 'overavskrivningar', additionalAmount: 8_000 }],
      }),
    )

    expect(status).toBe(200)
    expect(body.data.created).toHaveLength(1)
    expect(createJournalEntry).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'period-1',
        entry_date: '2025-12-31',
        source_type: 'year_end',
        lines: [
          {
            account_number: '8853',
            debit_amount: 8_000,
            credit_amount: 0,
            line_description: 'Förändring av överavskrivningar',
          },
          {
            account_number: '2153',
            debit_amount: 0,
            credit_amount: 8_000,
            line_description: 'Ackumulerade överavskrivningar',
          },
        ],
      }),
    )
  })

  it('returns 409 when a stale excess depreciation amount exceeds the current maximum', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'ready',
      proposal: {
        kind: 'overavskrivningar',
        label: 'Överavskrivningar',
        description: 'Skillnad mellan bokförd och skattemässig avskrivning.',
        amount: 5_000,
        signedAmount: 5_000,
        lines: [
          { account_number: '8853', debit_amount: 5_000, credit_amount: 0 },
          { account_number: '2153', debit_amount: 0, credit_amount: 5_000 },
        ],
        warnings: [],
      },
      warning: null,
      currentReserve: 0,
      currentPeriodChange: 0,
      targetReserve: 5_000,
      maximumSignedChange: 5_000,
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({
        items: [{ kind: 'overavskrivningar', additionalAmount: 6_000 }],
      }),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('posts a required excess depreciation release with reversed lines', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'ready',
      proposal: {
        kind: 'overavskrivningar',
        label: 'Återföring av överavskrivningar',
        description: 'Den skattemässiga reserven måste minskas.',
        amount: 10_000,
        signedAmount: -10_000,
        lines: [
          {
            account_number: '2153',
            debit_amount: 10_000,
            credit_amount: 0,
            line_description: 'Upplösning ackumulerade överavskrivningar',
          },
          {
            account_number: '8853',
            debit_amount: 0,
            credit_amount: 10_000,
            line_description: 'Förändring av överavskrivningar',
          },
        ],
        warnings: [],
        required: true,
      },
      warning: null,
      currentReserve: 20_000,
      currentPeriodChange: 0,
      targetReserve: 10_000,
      maximumSignedChange: -10_000,
    })

    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'overavskrivningar', additionalAmount: -10_000 }],
      }),
    )

    expect(status).toBe(200)
    expect(createJournalEntry).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        lines: [
          {
            account_number: '2153',
            debit_amount: 10_000,
            credit_amount: 0,
            line_description: 'Upplösning ackumulerade överavskrivningar',
          },
          {
            account_number: '8853',
            debit_amount: 0,
            credit_amount: 10_000,
            line_description: 'Förändring av överavskrivningar',
          },
        ],
      }),
    )
  })

  it('does not post a duplicate excess depreciation decision', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })

    const { status, body } = await parseJsonResponse<{
      data: { created: Array<{ kind: string }> }
    }>(
      await post({
        items: [{ kind: 'overavskrivningar', additionalAmount: 8_000 }],
      }),
    )

    expect(status).toBe(200)
    expect(body.data.created).toEqual([])
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 409 instead of posting over a different booked tax amount', async () => {
    const supabase = periodClient({
      id: 'period-1',
      name: '2025',
      period_start: '2024-10-07',
      period_end: '2025-12-31',
      opening_balance_entry_id: null,
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    vi.mocked(getBookedBolagsskatt).mockResolvedValue(123_181)

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { bookedAmount: number; expectedAmount: number } }
    }>(await post({ items: [{ kind: 'bolagsskatt' }] }))

    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details).toEqual({ bookedAmount: 123_181, expectedAmount: 123_180 })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})
