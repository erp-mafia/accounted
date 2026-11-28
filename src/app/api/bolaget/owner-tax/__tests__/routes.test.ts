import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner' }),
}))
vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/session')>()),
  companyForPdf: vi.fn().mockResolvedValue({ name: 'Exempel AB', org_number: '5560000000' }),
}))
vi.mock('@/lib/bolaget/owner-tax/k10', () => ({ loadK10Year: vi.fn(), saveK10Inputs: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/ku20', () => ({ loadKu20Status: vi.fn(), generateKu20File: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/loans', () => ({ createOwnerLoan: vi.fn(), updateOwnerLoan: vi.fn(), setLoanInterest: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/loans-view', () => ({ loadOwnerLoansView: vi.fn(), loadBoardLoansNote: vi.fn(), specialList: vi.fn().mockReturnValue([]) }))
vi.mock('@/lib/bolaget/owner-tax/pdf', () => ({
  renderK10UnderlagPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-k10')),
  renderSpecialListPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-list')),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { bolagetGate } from '@/lib/bolaget/gate'
import { loadK10Year, saveK10Inputs } from '@/lib/bolaget/owner-tax/k10'
import { generateKu20File, loadKu20Status } from '@/lib/bolaget/owner-tax/ku20'
import { createOwnerLoan, setLoanInterest, updateOwnerLoan } from '@/lib/bolaget/owner-tax/loans'
import { loadBoardLoansNote, loadOwnerLoansView } from '@/lib/bolaget/owner-tax/loans-view'
import { renderK10UnderlagPdf } from '@/lib/bolaget/owner-tax/pdf'
import { GET as getPage } from '../route'
import { PUT as putInputs } from '../k10/[year]/owners/[partyId]/route'
import { GET as getK10Pdf } from '../k10/[year]/owners/[partyId]/pdf/route'
import { POST as postLoan } from '../loans/route'
import { PATCH as patchLoan } from '../loans/[id]/route'
import { POST as postInterest } from '../loans/[id]/interest/route'
import { GET as getSpecialList } from '../special-list/[year]/route'
import { GET as getKu20File } from '../ku20/[year]/file/route'

const supabase = {
  from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ period_end: '2026-12-31' }], error: null }) }) }) }) }) }) }),
}
const noParams = { params: Promise.resolve({}) } as never
const LOAN = '22222222-2222-4222-8222-222222222222'
const ANNA = '33333333-3333-4333-8333-333333333333'
const idParams = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const yearParams = (year: string) => ({ params: Promise.resolve({ year }) }) as never
const ownerParams = (year: string, partyId: string) => ({ params: Promise.resolve({ year, partyId }) }) as never

function unauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
}

const req = (url: string, body?: unknown, method = 'POST') => createMockRequest(url, body === undefined ? { method } : { method, body })

const K10_VIEW = {
  income_year: 2026,
  supported: true,
  owners: [{ party_id: ANNA, name: 'Anna Ek', result: { lines: [] } }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('GET /api/bolaget/owner-tax', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getPage(req('/api/bolaget/owner-tax', undefined, 'GET'), noParams)).status).toBe(401)
    expect(loadK10Year).not.toHaveBeenCalled()
  })

  it('answers 404 outside the rollout or for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect((await getPage(req('/api/bolaget/owner-tax', undefined, 'GET'), noParams)).status).toBe(404)
  })

  it('refuses a malformed year', async () => {
    expect((await getPage(req('/api/bolaget/owner-tax?year=20x6', undefined, 'GET'), noParams)).status).toBe(400)
  })

  it('answers the K10 underlag, the loans, the special list, KU20, the note on the balance day, and whether KU20 may be downloaded', async () => {
    vi.mocked(loadK10Year).mockResolvedValue(K10_VIEW as never)
    vi.mocked(loadOwnerLoansView).mockResolvedValue({ as_of: '2026-10-29', loans: [], reconciliation: [], flagged: 0 })
    vi.mocked(loadKu20Status).mockResolvedValue({ income_year: 2026, recipients: [], blockers: [], ready: false } as never)
    vi.mocked(loadBoardLoansNote).mockResolvedValue({ balance_date: '2026-12-31', applicable: false } as never)
    const res = await getPage(req('/api/bolaget/owner-tax?year=2026', undefined, 'GET'), noParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ year: 2026, k10: { income_year: 2026 }, special_list: [], can_download_ku20: true })
    expect(vi.mocked(loadK10Year).mock.calls[0]![1]).toBe(2026)
    expect(vi.mocked(loadBoardLoansNote).mock.calls[0]![1]).toBe('2026-12-31')
  })

  it('without a year, reads the year the page opens on: last year in January', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-01-15T10:00:00Z'))
    try {
      vi.mocked(loadK10Year).mockResolvedValue(K10_VIEW as never)
      vi.mocked(loadOwnerLoansView).mockResolvedValue({ as_of: '2027-01-15', loans: [], reconciliation: [], flagged: 0 })
      vi.mocked(loadKu20Status).mockResolvedValue({ income_year: 2026, recipients: [], blockers: [], ready: false } as never)
      vi.mocked(loadBoardLoansNote).mockResolvedValue({ balance_date: '2026-12-31', applicable: false } as never)
      const res = await getPage(req('/api/bolaget/owner-tax', undefined, 'GET'), noParams)
      expect(res.status).toBe(200)
      expect((await res.json()).data.year).toBe(2026)
      expect(vi.mocked(loadK10Year).mock.calls[0]![1]).toBe(2026)
      expect(vi.mocked(loadKu20Status).mock.calls[0]![1]).toBe(2026)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PUT /api/bolaget/owner-tax/k10/{year}/owners/{partyId}', () => {
  const url = `/api/bolaget/owner-tax/k10/2026/owners/${ANNA}`

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await putInputs(req(url, { saved_dividend_space: 1 }, 'PUT'), ownerParams('2026', ANNA))).status).toBe(401)
  })

  it('refuses a bad party id, a negative figure or an unknown field', async () => {
    expect((await putInputs(req(url, { saved_dividend_space: 1 }, 'PUT'), ownerParams('2026', 'nope'))).status).toBe(400)
    expect((await putInputs(req(url, { saved_dividend_space: -5 }, 'PUT'), ownerParams('2026', ANNA))).status).toBe(400)
    expect((await putInputs(req(url, { personnummer: '19121212-1212' }, 'PUT'), ownerParams('2026', ANNA))).status).toBe(400)
    expect(saveK10Inputs).not.toHaveBeenCalled()
  })

  it('answers 404 for someone who is no owner that year', async () => {
    vi.mocked(saveK10Inputs).mockResolvedValueOnce({ ok: false, code: 'K10_OWNER_NOT_FOUND' })
    const res = await putInputs(req(url, { saved_dividend_space: 1000 }, 'PUT'), ownerParams('2026', ANNA))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('K10_OWNER_NOT_FOUND')
  })

  it('previews and saves the owner\'s figures with the path ids', async () => {
    vi.mocked(saveK10Inputs).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { income_year: 2026 } })
    expect((await putInputs(req(`${url}?dry_run=true`, { saved_dividend_space: 120000 }, 'PUT'), ownerParams('2026', ANNA))).status).toBe(200)
    expect(vi.mocked(saveK10Inputs).mock.calls[0]![1]).toMatchObject({ party_id: ANNA, income_year: 2026, saved_dividend_space: 120000 })
    expect(vi.mocked(saveK10Inputs).mock.calls[0]![2]).toEqual({ dryRun: true })
    vi.mocked(saveK10Inputs).mockResolvedValueOnce({ ok: true, data: { party_id: ANNA, income_year: 2026, inputs: {} as never, result: null } })
    const saved = await putInputs(req(url, { saved_dividend_space: 120000 }, 'PUT'), ownerParams('2026', ANNA))
    expect(saved.status).toBe(200)
  })
})

describe('GET /api/bolaget/owner-tax/k10/{year}/owners/{partyId}/pdf', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getK10Pdf(req('/x', undefined, 'GET'), ownerParams('2026', ANNA))).status).toBe(401)
  })

  it('answers 404 for a party that is no owner', async () => {
    vi.mocked(loadK10Year).mockResolvedValue({ ...K10_VIEW, owners: [] } as never)
    const res = await getK10Pdf(req('/x', undefined, 'GET'), ownerParams('2026', ANNA))
    expect(res.status).toBe(404)
  })

  it('renders the owner\'s underlag as a PDF', async () => {
    vi.mocked(loadK10Year).mockResolvedValue(K10_VIEW as never)
    const res = await getK10Pdf(req('/x', undefined, 'GET'), ownerParams('2026', ANNA))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(vi.mocked(renderK10UnderlagPdf).mock.calls[0]![0]).toMatchObject({ owner: { party_id: ANNA } })
  })
})

describe('POST /api/bolaget/owner-tax/loans', () => {
  const valid = { party_id: ANNA, direction: 'borrows', principal: 200000, start_date: '2026-03-01' }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postLoan(req('/api/bolaget/owner-tax/loans', valid), noParams)).status).toBe(401)
  })

  it('refuses a bad direction, an account outside the owner loan groups or an unknown field', async () => {
    expect((await postLoan(req('/api/bolaget/owner-tax/loans', { ...valid, direction: 'sideways' }), noParams)).status).toBe(400)
    expect((await postLoan(req('/api/bolaget/owner-tax/loans', { ...valid, account: '1930' }), noParams)).status).toBe(400)
    expect((await postLoan(req('/api/bolaget/owner-tax/loans', { ...valid, personnummer: '1' }), noParams)).status).toBe(400)
    expect(createOwnerLoan).not.toHaveBeenCalled()
  })

  it('previews and registers, carrying the warnings', async () => {
    vi.mocked(createOwnerLoan).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { loan_ban: { status: 'not_applicable' } } })
    expect((await postLoan(req('/api/bolaget/owner-tax/loans?dry_run=true', valid), noParams)).status).toBe(200)
    expect(vi.mocked(createOwnerLoan).mock.calls[0]![1]).toMatchObject({ party: { party_id: ANNA }, direction: 'borrows' })
    vi.mocked(createOwnerLoan).mockResolvedValueOnce({
      ok: true,
      data: { owner_loan_id: LOAN, party_id: ANNA, kind: 'loan', direction: 'lends', account: '1685', principal: 1, outstanding: 1, loan_ban: { status: 'prohibited', exception: null, special_list: false } },
      created: true,
      warnings: [{ code: 'LOAN_BAN_PROHIBITED', message_sv: 's', message_en: 'e' }],
    })
    const res = await postLoan(req('/api/bolaget/owner-tax/loans', { ...valid, direction: 'lends' }), noParams)
    expect(res.status).toBe(201)
    expect((await res.json()).warnings[0].code).toBe('LOAN_BAN_PROHIBITED')
  })
})

describe('PATCH /api/bolaget/owner-tax/loans/{id}', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await patchLoan(req(`/api/bolaget/owner-tax/loans/${LOAN}`, { outstanding: 1 }, 'PATCH'), idParams(LOAN))).status).toBe(401)
  })

  it('refuses a bad id or status', async () => {
    expect((await patchLoan(req('/x', { outstanding: 1 }, 'PATCH'), idParams('nope'))).status).toBe(400)
    expect((await patchLoan(req('/x', { status: 'forgiven' }, 'PATCH'), idParams(LOAN))).status).toBe(400)
  })

  it('answers 404 for a loan that is not in the register', async () => {
    vi.mocked(updateOwnerLoan).mockResolvedValueOnce({ ok: false, code: 'OWNER_LOAN_NOT_FOUND' })
    expect((await patchLoan(req('/x', { outstanding: 1 }, 'PATCH'), idParams(LOAN))).status).toBe(404)
  })

  it('marks a loan repaid', async () => {
    vi.mocked(updateOwnerLoan).mockResolvedValueOnce({ ok: true, data: { owner_loan_id: LOAN, status: 'repaid', outstanding: 0, loan_ban: { status: 'not_applicable', exception: null, special_list: false } } })
    const res = await patchLoan(req('/x', { status: 'repaid', repaid_on: '2026-11-30' }, 'PATCH'), idParams(LOAN))
    expect(res.status).toBe(200)
    expect(vi.mocked(updateOwnerLoan).mock.calls[0]![1]).toMatchObject({ owner_loan_id: LOAN, status: 'repaid' })
  })
})

describe('POST /api/bolaget/owner-tax/loans/{id}/interest', () => {
  const valid = { income_year: 2026, interest_amount: 8000, tax_withheld: 2400 }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postInterest(req('/x', valid), idParams(LOAN))).status).toBe(401)
  })

  it('refuses a missing amount', async () => {
    expect((await postInterest(req('/x', { income_year: 2026 }), idParams(LOAN))).status).toBe(400)
  })

  it('answers 404 for an unknown loan and saves a known one', async () => {
    vi.mocked(setLoanInterest).mockResolvedValueOnce({ ok: false, code: 'OWNER_LOAN_NOT_FOUND' })
    expect((await postInterest(req('/x', valid), idParams(LOAN))).status).toBe(404)
    vi.mocked(setLoanInterest).mockResolvedValueOnce({ ok: true, data: { owner_loan_id: LOAN, income_year: 2026, interest_amount: 8000, tax_withheld: 2400 } })
    expect((await postInterest(req('/x', valid), idParams(LOAN))).status).toBe(200)
  })
})

describe('GET /api/bolaget/owner-tax/special-list/{year}', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getSpecialList(req('/x', undefined, 'GET'), yearParams('2026'))).status).toBe(401)
  })

  it('refuses a malformed year and prints the list as a PDF', async () => {
    expect((await getSpecialList(req('/x', undefined, 'GET'), yearParams('26'))).status).toBe(400)
    vi.mocked(loadOwnerLoansView).mockResolvedValue({ as_of: '2026-10-29', loans: [], reconciliation: [], flagged: 0 })
    const res = await getSpecialList(req('/x', undefined, 'GET'), yearParams('2026'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })
})

describe('GET /api/bolaget/owner-tax/ku20/{year}/file', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getKu20File(req('/x', undefined, 'GET'), yearParams('2026'))).status).toBe(401)
  })

  it('maps a refusal (not ready, or not an owner or admin) to its code', async () => {
    vi.mocked(generateKu20File).mockResolvedValueOnce({ ok: false, code: 'KU20_NOT_READY', messageSv: 'Ange kontaktperson.' })
    const res = await getKu20File(req('/x', undefined, 'GET'), yearParams('2026'))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('KU20_NOT_READY')
  })

  it('downloads the XML', async () => {
    vi.mocked(generateKu20File).mockResolvedValueOnce({ ok: true, data: { filename: 'KU20_2026_5560000000.xml', xml: '<Skatteverket/>', recipients: 1, total_reported: 8000 } })
    const res = await getKu20File(req('/x', undefined, 'GET'), yearParams('2026'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xml')
    expect(await res.text()).toBe('<Skatteverket/>')
  })
})
