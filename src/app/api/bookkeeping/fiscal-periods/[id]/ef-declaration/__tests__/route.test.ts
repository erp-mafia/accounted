import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/bokslut/enskild-firma/ef-declaration-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/enskild-firma/ef-declaration-preview')>()),
  computeEfDeclarationPreview: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  computeEfDeclarationPreview,
  EfDeclarationNotApplicableError,
  type EfDeclarationPreview,
} from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import { GET } from '../route'

const PREVIEW: EfDeclarationPreview = {
  fiscalPeriod: { id: 'period-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
  bookedSurplus: 130_000,
  items: [
    {
      kind: 'egenavgifter',
      label: 'Egenavgifter: schablonavdrag',
      description: '',
      amount: 32_500,
      ne_ruta: 'R43',
      computation: {},
      warnings: [],
    },
  ],
}

function mkReq(query = '') {
  return new Request(`http://localhost/api/bookkeeping/fiscal-periods/period-1/ef-declaration${query}`)
}

function mkParams(id = 'period-1') {
  return { params: Promise.resolve({ id }) }
}

function signedIn() {
  const mock = createQueuedMockSupabase()
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  vi.mocked(createClient).mockResolvedValue(mock.supabase as never)
  return mock
}

describe('GET /api/bookkeeping/fiscal-periods/[id]/ef-declaration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(401)
    expect(computeEfDeclarationPreview).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-numeric amount', '?kapitalunderlag=abc'],
    ['an unknown egenavgifter category', '?category=retired'],
    ['a negative prior-year amount', '?priorYearSchablonavdrag=-100'],
  ])('returns 400 for %s', async (_label, query) => {
    signedIn()

    const res = await GET(mkReq(query), mkParams())
    expect(res.status).toBe(400)
    expect(computeEfDeclarationPreview).not.toHaveBeenCalled()
  })

  it("returns 404 for a period that is not the active company's", async () => {
    const { enqueue, findCalls } = signedIn()
    enqueue({ data: null })

    const res = await GET(mkReq(), mkParams('other-company-period'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(findCalls('fiscal_periods', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'other-company-period'],
        ['company_id', 'company-1'],
      ]),
    )
    expect(computeEfDeclarationPreview).not.toHaveBeenCalled()
  })

  it('refuses an aktiebolag with EF_DECLARATION_WRONG_LEGAL_FORM (400)', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    vi.mocked(computeEfDeclarationPreview).mockRejectedValue(new EfDeclarationNotApplicableError('aktiebolag'))

    const res = await GET(mkReq('?category=full'), mkParams())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('EF_DECLARATION_WRONG_LEGAL_FORM')
  })

  it('returns the preview with the posted entry count and parsed inputs', async () => {
    const { enqueue, findCall } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    enqueue({ count: 4 })
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue(PREVIEW)

    const res = await GET(
      mkReq(
        '?category=pensioner&kapitalunderlag=-600000&expansionsfondKapitalunderlag=250000' +
          '&priorYearSchablonavdrag=12000' +
          '&priorYearActualCharged=9000&pfondDesiredAmount=20000' +
          '&expansionsfondExistingBalance=0&expansionsfondDesiredChange=-5000',
      ),
      mkParams(),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ ...PREVIEW, postedEntryCount: 4, inputWarnings: [] })
    expect(computeEfDeclarationPreview).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1', {
      category: 'pensioner',
      kapitalunderlag: -600_000,
      expansionsfondKapitalunderlag: 250_000,
      priorYearSchablonavdrag: 12_000,
      priorYearActualCharged: 9_000,
      pfondDesiredAmount: 20_000,
      expansionsfondExistingBalance: 0,
      expansionsfondDesiredChange: -5_000,
    })
    expect(findCall('journal_entries', 'in')).toEqual(['status', ['posted', 'reversed']])
  })

  it('warns when kapitalunderlag is not entered, and reports zero posted entries', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    enqueue({ count: 0 })
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue(PREVIEW)

    const res = await GET(mkReq('?category=full'), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.postedEntryCount).toBe(0)
    expect(body.data.inputWarnings).toHaveLength(1)
    expect(body.data.inputWarnings[0]).toMatch(/^Kapitalunderlag saknas/)
  })

  it('warns when an expansionsfond avsättning has no closing kapitalunderlag', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    enqueue({ count: 3 })
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue(PREVIEW)

    const res = await GET(mkReq('?kapitalunderlag=100000&expansionsfondDesiredChange=50000'), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.inputWarnings).toEqual([
      expect.stringMatching(/^Kapitalunderlag för expansionsfond saknas/),
    ])
  })

  it('does not ask for the closing kapitalunderlag for a återföring', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    enqueue({ count: 3 })
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue(PREVIEW)

    const res = await GET(mkReq('?kapitalunderlag=100000&expansionsfondDesiredChange=-50000'), mkParams())
    const body = await res.json()
    expect(body.data.inputWarnings).toEqual([])
  })
})
