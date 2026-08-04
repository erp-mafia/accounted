import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/bokslut/assets/depreciation-engine', () => ({
  proposeAnnualPostings: vi.fn(),
  commitAnnualPostings: vi.fn(),
}))

vi.mock('@/lib/bokslut/assets/tax-depreciation-service', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/bokslut/assets/tax-depreciation-service')
  >()
  return {
    ...actual,
    loadTaxDepreciationView: vi.fn(),
    previewTaxDepreciationElection: vi.fn(),
    saveTaxDepreciationElection: vi.fn(),
  }
})

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

import {
  commitAnnualPostings,
  proposeAnnualPostings,
} from '@/lib/bokslut/assets/depreciation-engine'
import {
  loadTaxDepreciationView,
  previewTaxDepreciationElection,
  saveTaxDepreciationElection,
  TaxDepreciationPeriodLockedError,
} from '@/lib/bokslut/assets/tax-depreciation-service'
import { GET, POST, PUT } from '../route'

const params = { params: Promise.resolve({ id: 'period-1' }) }
const periodBuilder = {
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
}
periodBuilder.select.mockReturnValue(periodBuilder)
periodBuilder.eq.mockReturnValue(periodBuilder)
const supabase = { from: vi.fn().mockReturnValue(periodBuilder) }
const ordinary = {
  fiscalPeriod: {
    id: 'period-1',
    name: '2025',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
  },
  items: [],
  totalAmount: 0,
}
const tax = {
  status: 'ready' as const,
  method: 'rakenskapsenlig' as const,
  selectedRule: 'huvudregel_30' as const,
  methodLocked: false,
  openingTaxValue: 100_000,
  openingSource: 'saved' as const,
  periodMonths: 12,
  eligibleAssetCount: 2,
  excludedAssetCount: 0,
  excludedCategories: [],
  cohortHistoryComplete: true,
  incompleteCohortCount: 0,
  result: null,
  snapshot: null,
  isStale: false,
}

function get() {
  return GET(createMockRequest('/api/bookkeeping/fiscal-periods/period-1/depreciation'), params)
}

function put(body: unknown) {
  return PUT(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/depreciation', {
      method: 'PUT',
      body,
    }),
    params,
  )
}

function post(body: unknown) {
  return POST(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/depreciation', {
      method: 'POST',
      body,
    }),
    params,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase,
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(proposeAnnualPostings).mockResolvedValue(ordinary)
  vi.mocked(loadTaxDepreciationView).mockResolvedValue(tax)
  vi.mocked(previewTaxDepreciationElection).mockResolvedValue(tax)
  vi.mocked(saveTaxDepreciationElection).mockResolvedValue(tax)
  vi.mocked(commitAnnualPostings).mockResolvedValue({ posted: [], skipped: [] })
  periodBuilder.single.mockResolvedValue({
    data: { is_closed: false, locked_at: null, closing_entry_id: null },
    error: null,
  })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/depreciation', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await get()).status).toBe(401)
  })

  it('returns ordinary and tax depreciation for the active company', async () => {
    const { status, body } = await parseJsonResponse<{ data: ProposalWithTax }>(
      await get(),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ ...ordinary, tax })
    expect(loadTaxDepreciationView).toHaveBeenCalledWith(supabase, 'company-1', 'period-1')
  })

  it('returns a read-only tax preview for validated query inputs', async () => {
    const request = createMockRequest(
      '/api/bookkeeping/fiscal-periods/period-1/depreciation?tax_method=rakenskapsenlig&tax_rule=huvudregel_30&opening_tax_value=100000',
    )
    expect((await GET(request, params)).status).toBe(200)
    expect(previewTaxDepreciationElection).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      {
        method: 'rakenskapsenlig',
        selectedRule: 'huvudregel_30',
        openingTaxValue: 100_000,
      },
    )
  })

  it('returns 404 when the fiscal period is missing', async () => {
    vi.mocked(loadTaxDepreciationView).mockRejectedValue(new Error('Fiscal period not found'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })
})

describe('PUT /api/bookkeeping/fiscal-periods/[id]/depreciation', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await put({
      method: 'restvarde',
      opening_tax_value: 100_000,
      elected_deduction: 25_000,
    })).status).toBe(401)
  })

  it('returns 400 for an incoherent method and annual rule', async () => {
    expect((await put({
      method: 'restvarde',
      selected_rule: 'huvudregel_30',
      elected_deduction: 25_000,
    })).status).toBe(400)
    expect(saveTaxDepreciationElection).not.toHaveBeenCalled()
  })

  it('returns 404 when the fiscal period is missing', async () => {
    vi.mocked(saveTaxDepreciationElection).mockRejectedValue(new Error('Fiscal period not found'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await put({
        method: 'restvarde',
        opening_tax_value: 100_000,
        elected_deduction: 25_000,
      }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('returns PERIOD_LOCKED when the snapshot cannot be saved', async () => {
    vi.mocked(saveTaxDepreciationElection).mockRejectedValue(
      new TaxDepreciationPeriodLockedError('Fiscal period is locked'),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(
      await put({
        method: 'restvarde',
        opening_tax_value: 100_000,
        elected_deduction: 25_000,
      }),
    )
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('saves a validated annual election for the active company', async () => {
    const { status } = await parseJsonResponse(
      await put({
        method: 'rakenskapsenlig',
        selected_rule: 'kompletteringsregel_20',
        opening_tax_value: 100_000,
        elected_deduction: 20_000,
        book_conformity_confirmed: true,
      }),
    )
    expect(status).toBe(200)
    expect(saveTaxDepreciationElection).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      {
        method: 'rakenskapsenlig',
        selectedRule: 'kompletteringsregel_20',
        openingTaxValue: 100_000,
        electedDeduction: 20_000,
        bookConformityConfirmed: true,
      },
    )
  })
})

type ProposalWithTax = typeof ordinary & { tax: typeof tax }

describe('POST /api/bookkeeping/fiscal-periods/[id]/depreciation', () => {
  it('continues to post ordinary depreciation only', async () => {
    expect((await post({})).status).toBe(200)
    expect(commitAnnualPostings).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'period-1', {
      assetIds: undefined,
    })
  })
})
