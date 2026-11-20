import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const queued = createQueuedMockSupabase()
const { supabase } = queued
const auth = vi.fn(), isAdmin = vi.fn(), readFile = vi.fn(), previousBooked = vi.fn(), setBalances = vi.fn()
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => auth(...args) }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: (...args: unknown[]) => isAdmin(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/import/opening-balance/sie-file', () => ({
  readSIEFileOpeningBalance: (...args: unknown[]) => readFile(...args),
  previousYearHasBookkeeping: (...args: unknown[]) => previousBooked(...args),
}))
vi.mock('@/lib/import/opening-balance/service', () => ({ setOpeningBalances: (...args: unknown[]) => setBalances(...args) }))
import { GET, POST } from '../route'

const id = '11111111-1111-4111-8111-111111111111'
const token = '22222222-2222-4222-8222-222222222222'
const entry = '33333333-3333-4333-8333-333333333333'
const params = { params: Promise.resolve({ id }) }
const file = {
  importId: 'import-1', filename: '2019.SE', totalDebit: 100, totalCredit: 100,
  lines: [
    { account_number: '1930', debit_amount: 100, credit_amount: 0 },
    { account_number: '2099', debit_amount: 0, credit_amount: 100 },
  ],
}
const get = () => GET(new Request('https://example.test/sie-file'), params)
const post = (body: unknown = { reviewToken: token }, routeParams = params) => POST(new Request('https://example.test/sie-file', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), routeParams)
const openReview = () => queued.enqueue({ data: { id, period_start: '2019-01-01', opening_balance_entry_id: null, opening_balance_review_token: token } })
const year = () => queued.enqueue({ data: { period_start: '2019-01-01' } })

beforeEach(() => {
  vi.clearAllMocks(); queued.reset()
  auth.mockResolvedValue({ user: { id: 'actor-1' }, supabase })
  isAdmin.mockResolvedValue(true)
  readFile.mockResolvedValue(file)
  previousBooked.mockResolvedValue(false)
  setBalances.mockResolvedValue({ ok: true, created: true, data: {
    journal_entry_id: entry, voucher_series: 'A', voucher_number: 1, fiscal_period_id: id,
    entry_date: '2019-01-01', lines_created: 2, total_debit: 100, total_credit: 100,
  } })
})

describe('GET the IB stored from the year\'s SIE file', () => {
  it('requires authentication', async () => {
    auth.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(readFile).not.toHaveBeenCalled()
  })
  it('rejects a malformed year id', async () => {
    expect((await GET(new Request('https://example.test/sie-file'), { params: Promise.resolve({ id: 'bad' }) })).status).toBe(400)
    expect(readFile).not.toHaveBeenCalled()
  })
  it('previews the stored lines of the active company only', async () => {
    year()
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: {
      import_id: 'import-1', filename: '2019.SE', lines: file.lines, total_debit: 100, total_credit: 100,
      previous_year_booked: false,
    } })
    expect(readFile).toHaveBeenCalledWith(supabase, 'company-1', id)
    expect(previousBooked).toHaveBeenCalledWith(supabase, 'company-1', '2019-01-01')
    expect(queued.findCalls('fiscal_periods', 'eq')).toEqual([['id', id], ['company_id', 'company-1']])
  })
  it('answers null when no import stored an IB for the year', async () => {
    year()
    readFile.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ data: null })
  })
  it('answers null for a year outside the company without reading the file', async () => {
    queued.enqueue({ data: null })
    expect(await (await get()).json()).toEqual({ data: null })
    expect(readFile).not.toHaveBeenCalled()
  })
  it('says when the year before is booked again, with or without a stored IB (PH 193)', async () => {
    year()
    previousBooked.mockResolvedValue(true)
    expect((await (await get()).json()).data.previous_year_booked).toBe(true)
    year()
    readFile.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ data: {
      import_id: null, filename: null, lines: [], total_debit: 0, total_credit: 0, previous_year_booked: true,
    } })
  })
})

describe('POST books the stored IB and signs off the review (crm#1099)', () => {
  it('requires authentication', async () => {
    auth.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post()).status).toBe(401)
    expect(setBalances).not.toHaveBeenCalled()
  })
  it('refuses members who cannot sign off the review', async () => {
    isAdmin.mockResolvedValue(false)
    expect((await post()).status).toBe(403)
    expect(setBalances).not.toHaveBeenCalled()
  })
  it('rejects malformed input before reading anything', async () => {
    expect((await post({ reviewToken: 'bad' })).status).toBe(400)
    expect((await post({ reviewToken: token, lines: [] })).status).toBe(400)
    expect((await post({ reviewToken: token }, { params: Promise.resolve({ id: 'bad' }) })).status).toBe(400)
    expect(setBalances).not.toHaveBeenCalled()
  })
  it('answers 404 for a year outside the company', async () => {
    queued.enqueue({ data: null })
    const response = await post()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('OB_PERIOD_NOT_FOUND')
    expect(queued.findCalls('fiscal_periods', 'eq')).toEqual([['id', id], ['company_id', 'company-1']])
  })
  it.each([
    ['a renewed review', { opening_balance_entry_id: null, opening_balance_review_token: '44444444-4444-4444-8444-444444444444' }],
    ['a year that has an IB by now', { opening_balance_entry_id: entry, opening_balance_review_token: token }],
  ])('refuses %s with 409', async (_name, row) => {
    queued.enqueue({ data: { id, ...row } })
    const response = await post()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('OB_REVIEW_CHANGED')
    expect(setBalances).not.toHaveBeenCalled()
  })
  it('refuses with 409 once the year before is imported again, booking nothing (PH 193)', async () => {
    openReview()
    previousBooked.mockResolvedValue(true)
    const response = await post()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('OB_PREVIOUS_YEAR_BOOKED')
    expect(previousBooked).toHaveBeenCalledWith(supabase, 'company-1', '2019-01-01')
    expect(setBalances).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('answers 404 when no import stored an IB for the year', async () => {
    openReview()
    readFile.mockResolvedValue(null)
    const response = await post()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('OB_SIE_FILE_MISSING')
    expect(setBalances).not.toHaveBeenCalled()
  })
  it('passes a refusal from the opening balance service through, without signing off', async () => {
    openReview()
    setBalances.mockResolvedValue({ ok: false, code: 'OB_UNBALANCED', details: { diff: 75 } })
    const response = await post()
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('OB_UNBALANCED')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('books the stored lines through the service and signs off with the new verifikat', async () => {
    openReview()
    queued.enqueue({ data: null })
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { journal_entry_id: entry, voucher_series: 'A', voucher_number: 1, reviewed: true } })
    expect(setBalances).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'actor-1' }),
      { fiscal_period_id: id, lines: file.lines, description: 'Ingående balanser från SIE-filen 2019.SE' },
    )
    expect(supabase.rpc).toHaveBeenCalledWith('acknowledge_sie_opening_balance_review', {
      p_company_id: 'company-1', p_period_id: id, p_actor: 'actor-1', p_review_token: token, p_expected_entry_id: entry,
    })
  })
  it('keeps the booked IB when the sign-off is refused and says so', async () => {
    openReview()
    queued.enqueue({ error: { code: '40001', message: 'Opening balance review changed' } })
    const response = await post()
    expect(response.status).toBe(200)
    expect((await response.json()).data.reviewed).toBe(false)
  })
})
