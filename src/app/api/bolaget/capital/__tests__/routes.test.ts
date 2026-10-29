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
vi.mock('@/lib/bolaget/capital/view', () => ({ loadCapitalView: vi.fn() }))
vi.mock('@/lib/bolaget/capital/dividends', () => ({
  createDividend: vi.fn(),
  bookDividend: vi.fn(),
  payDividend: vi.fn(),
  cancelDividend: vi.fn(),
  listLedgerDividendPayouts: vi.fn(),
  recordLedgerDividend: vi.fn(),
}))
vi.mock('@/lib/bolaget/capital/ku31', () => ({ loadKu31Status: vi.fn(), saveKu31Settings: vi.fn(), generateKu31File: vi.fn() }))
vi.mock('@/lib/bolaget/capital/contributions', () => ({ createShareholderContribution: vi.fn() }))
vi.mock('@/lib/bolaget/capital/capital-changes', () => ({ createCapitalChange: vi.fn(), bookCapitalChange: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { bolagetGate } from '@/lib/bolaget/gate'
import { loadCapitalView } from '@/lib/bolaget/capital/view'
import { bookDividend, createDividend, payDividend, recordLedgerDividend } from '@/lib/bolaget/capital/dividends'
import { generateKu31File, loadKu31Status, saveKu31Settings } from '@/lib/bolaget/capital/ku31'
import { createShareholderContribution } from '@/lib/bolaget/capital/contributions'
import { bookCapitalChange, createCapitalChange } from '@/lib/bolaget/capital/capital-changes'
import { GET as getCapital } from '../route'
import { POST as postDividend } from '../dividends/route'
import { POST as postBook } from '../dividends/[id]/book/route'
import { POST as postPay } from '../dividends/[id]/pay/route'
import { POST as postLedger } from '../dividends/ledger/route'
import { GET as getKu31, PUT as putKu31 } from '../ku31/[year]/route'
import { GET as getKu31File } from '../ku31/[year]/file/route'
import { POST as postContribution } from '../contributions/route'
import { POST as postChange } from '../changes/route'
import { POST as postChangeBook } from '../changes/[id]/book/route'

const supabase = {}
const noParams = { params: Promise.resolve({}) } as never
const DIVIDEND = '22222222-2222-4222-8222-222222222222'
const CHANGE = '33333333-3333-4333-8333-333333333333'
const ENTRY = '44444444-4444-4444-8444-444444444444'
const idParams = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const yearParams = (year: string) => ({ params: Promise.resolve({ year }) }) as never

function unauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
}

const req = (url: string, body?: unknown, method = 'POST') => createMockRequest(url, body === undefined ? { method } : { method, body })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('GET /api/bolaget/capital', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getCapital(req('/api/bolaget/capital', undefined, 'GET'), noParams)).status).toBe(401)
    expect(loadCapitalView).not.toHaveBeenCalled()
  })

  it('answers 404 outside the rollout', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    const res = await getCapital(req('/api/bolaget/capital', undefined, 'GET'), noParams)
    expect(res.status).toBe(404)
  })

  it('answers the events, the dividend years and whether KU31 may be downloaded', async () => {
    vi.mocked(loadCapitalView).mockResolvedValue({
      dividends: [{ dividend_id: DIVIDEND, payment_date: '2026-05-15', status: 'paid', holders: [] }, { dividend_id: 'x', payment_date: '2025-05-15', status: 'cancelled', holders: [] }],
      contributions: [],
      capital_changes: [],
    } as never)
    const res = await getCapital(req('/api/bolaget/capital', undefined, 'GET'), noParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dividend_years).toEqual([2026])
    expect(body.data.can_download_ku31).toBe(true)
  })
})

describe('POST /api/bolaget/capital/dividends', () => {
  const valid = { decided_on: '2026-05-01', decided_by: 'arsstamma', amount_per_share: 100 }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postDividend(req('/api/bolaget/capital/dividends', valid), noParams)).status).toBe(401)
  })

  it('refuses an unknown body field or a styrelse decision (only a stämma decides a dividend)', async () => {
    expect((await postDividend(req('/api/bolaget/capital/dividends', { ...valid, extra: 1 }), noParams)).status).toBe(400)
    expect((await postDividend(req('/api/bolaget/capital/dividends', { ...valid, decided_by: 'styrelse' }), noParams)).status).toBe(400)
    expect(createDividend).not.toHaveBeenCalled()
  })

  it('previews with dry_run and records with 201', async () => {
    vi.mocked(createDividend).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { total_amount: 100000 } })
    const preview = await postDividend(req('/api/bolaget/capital/dividends?dry_run=true', valid), noParams)
    expect(preview.status).toBe(200)
    expect((await preview.json()).data.total_amount).toBe(100000)
    expect(vi.mocked(createDividend).mock.calls[0]![2]).toEqual({ dryRun: true })

    vi.mocked(createDividend).mockResolvedValueOnce({ ok: true, data: { dividend_id: DIVIDEND, status: 'decided', total_amount: 100000, record_date: '2026-05-01', payment_date: '2026-05-01', distributions: [] }, created: true })
    const created = await postDividend(req('/api/bolaget/capital/dividends', valid), noParams)
    expect(created.status).toBe(201)
  })

  it('maps a refusal to its code', async () => {
    vi.mocked(createDividend).mockResolvedValueOnce({ ok: false, code: 'DIVIDEND_NO_HOLDERS' })
    const res = await postDividend(req('/api/bolaget/capital/dividends', valid), noParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DIVIDEND_NO_HOLDERS')
  })
})

describe('POST /api/bolaget/capital/dividends/{id}/book and /pay', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postBook(req(`/api/bolaget/capital/dividends/${DIVIDEND}/book`, {}), idParams(DIVIDEND))).status).toBe(401)
    expect((await postPay(req(`/api/bolaget/capital/dividends/${DIVIDEND}/pay`, {}), idParams(DIVIDEND))).status).toBe(401)
  })

  it('answers 404 for a malformed id and for a dividend not found', async () => {
    expect((await postBook(req('/api/bolaget/capital/dividends/nope/book', {}), idParams('nope'))).status).toBe(404)
    vi.mocked(bookDividend).mockResolvedValueOnce({ ok: false, code: 'DIVIDEND_NOT_FOUND' })
    expect((await postBook(req(`/api/bolaget/capital/dividends/${DIVIDEND}/book`, {}), idParams(DIVIDEND))).status).toBe(404)
  })

  it('refuses a bad source account or bank account', async () => {
    expect((await postBook(req(`/api/bolaget/capital/dividends/${DIVIDEND}/book`, { source_account: '2099' }), idParams(DIVIDEND))).status).toBe(400)
    expect((await postPay(req(`/api/bolaget/capital/dividends/${DIVIDEND}/pay`, { bank_account: '2898' }), idParams(DIVIDEND))).status).toBe(400)
  })

  it('refuses a dividend above the fritt eget kapital with 409', async () => {
    vi.mocked(bookDividend).mockResolvedValueOnce({ ok: false, code: 'DIVIDEND_EXCEEDS_FREE_EQUITY', details: { available: 10 } })
    const res = await postBook(req(`/api/bolaget/capital/dividends/${DIVIDEND}/book`, {}), idParams(DIVIDEND))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DIVIDEND_EXCEEDS_FREE_EQUITY')
  })

  it('books and pays with the id from the path', async () => {
    vi.mocked(bookDividend).mockResolvedValueOnce({ ok: true, data: { dividend_id: DIVIDEND, status: 'booked', decision_entry_id: ENTRY, source_account: '2098', total_amount: 1 } })
    expect((await postBook(req(`/api/bolaget/capital/dividends/${DIVIDEND}/book`, { source_account: '2098' }), idParams(DIVIDEND))).status).toBe(200)
    expect(vi.mocked(bookDividend).mock.calls[0]![1]).toEqual({ source_account: '2098', dividend_id: DIVIDEND })
    vi.mocked(payDividend).mockResolvedValueOnce({ ok: true, data: { dividend_id: DIVIDEND, status: 'paid', payout_entry_id: ENTRY, paid_on: '2026-05-15', linked: true } })
    expect((await postPay(req(`/api/bolaget/capital/dividends/${DIVIDEND}/pay`, { journal_entry_id: ENTRY }), idParams(DIVIDEND))).status).toBe(200)
    expect(vi.mocked(payDividend).mock.calls[0]![1]).toEqual({ journal_entry_id: ENTRY, dividend_id: DIVIDEND })
  })
})

describe('/api/bolaget/capital/dividends/ledger', () => {
  const valid = { decided_on: '2026-04-20', decided_by: 'arsstamma', paid_on: '2026-04-30', payout_entry_id: ENTRY, recipients: [{ name: 'Anna Ek', amount: 100 }] }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postLedger(req('/api/bolaget/capital/dividends/ledger', valid), noParams)).status).toBe(401)
  })

  it('refuses a body without recipients', async () => {
    expect((await postLedger(req('/api/bolaget/capital/dividends/ledger', { ...valid, recipients: [] }), noParams)).status).toBe(400)
  })

  it('records the recipients', async () => {
    vi.mocked(recordLedgerDividend).mockResolvedValueOnce({ ok: true, data: { dividend_id: DIVIDEND, status: 'paid', total_amount: 100, record_date: '2026-04-20', payment_date: '2026-04-30', distributions: [] }, created: true })
    expect((await postLedger(req('/api/bolaget/capital/dividends/ledger', valid), noParams)).status).toBe(201)
  })
})

describe('/api/bolaget/capital/ku31/{year}', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await getKu31(req('/api/bolaget/capital/ku31/2026', undefined, 'GET'), yearParams('2026'))).status).toBe(401)
    expect((await getKu31File(req('/api/bolaget/capital/ku31/2026/file', undefined, 'GET'), yearParams('2026'))).status).toBe(401)
  })

  it('refuses a malformed year and a bad answer', async () => {
    expect((await getKu31(req('/api/bolaget/capital/ku31/26', undefined, 'GET'), yearParams('26'))).status).toBe(400)
    expect((await putKu31(req('/api/bolaget/capital/ku31/2026', { famansforetag: 'yes' }, 'PUT'), yearParams('2026'))).status).toBe(400)
  })

  it('answers the status, and saves the answers', async () => {
    vi.mocked(loadKu31Status).mockResolvedValue({ income_year: 2026, ready: false, blockers: [] } as never)
    expect((await getKu31(req('/api/bolaget/capital/ku31/2026', undefined, 'GET'), yearParams('2026'))).status).toBe(200)
    vi.mocked(saveKu31Settings).mockResolvedValueOnce({ ok: true, data: {} as never })
    const res = await putKu31(req('/api/bolaget/capital/ku31/2026', { famansforetag: true, contact_name: 'Anna Ek' }, 'PUT'), yearParams('2026'))
    expect(res.status).toBe(200)
    expect(vi.mocked(saveKu31Settings).mock.calls[0]![1]).toBe(2026)
  })

  it('downloads the file as XML, and refuses with the blockers when not ready', async () => {
    vi.mocked(generateKu31File).mockResolvedValueOnce({ ok: true, data: { filename: 'KU31_2026_5560000001.xml', xml: '<?xml version="1.0"?><Skatteverket/>', recipients: 1, total_reported: 1 } })
    const file = await getKu31File(req('/api/bolaget/capital/ku31/2026/file', undefined, 'GET'), yearParams('2026'))
    expect(file.status).toBe(200)
    expect(file.headers.get('Content-Type')).toContain('application/xml')
    expect(file.headers.get('Content-Disposition')).toContain('KU31_2026_5560000001.xml')
    expect(file.headers.get('Cache-Control')).toBe('private, no-store')

    vi.mocked(generateKu31File).mockResolvedValueOnce({ ok: false, code: 'KU31_NOT_READY', messageSv: 'Anna Ek saknar personnummer.' })
    const refused = await getKu31File(req('/api/bolaget/capital/ku31/2026/file', undefined, 'GET'), yearParams('2026'))
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('KU31_NOT_READY')
  })
})

describe('POST /api/bolaget/capital/contributions and /changes', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await postContribution(req('/api/bolaget/capital/contributions', {}), noParams)).status).toBe(401)
    expect((await postChange(req('/api/bolaget/capital/changes', {}), noParams)).status).toBe(401)
    expect((await postChangeBook(req(`/api/bolaget/capital/changes/${CHANGE}/book`, {}), idParams(CHANGE))).status).toBe(401)
  })

  it('refuses invalid bodies', async () => {
    expect((await postContribution(req('/api/bolaget/capital/contributions', { promised_on: '2026-01-01', amount: -5 }), noParams)).status).toBe(400)
    expect((await postChange(req('/api/bolaget/capital/changes', { kind: 'split', decided_on: '2026-01-01', decided_by: 'arsstamma', share_count: 1 }), noParams)).status).toBe(400)
    expect((await postChangeBook(req(`/api/bolaget/capital/changes/${CHANGE}/book`, { step: 'later', date: '2026-01-01' }), idParams(CHANGE))).status).toBe(400)
  })

  it('answers 404 for a capital change not found', async () => {
    expect((await postChangeBook(req('/api/bolaget/capital/changes/nope/book', { step: 'registration', date: '2026-01-01' }), idParams('nope'))).status).toBe(404)
    vi.mocked(bookCapitalChange).mockResolvedValueOnce({ ok: false, code: 'CAPITAL_CHANGE_NOT_FOUND' })
    expect((await postChangeBook(req(`/api/bolaget/capital/changes/${CHANGE}/book`, { step: 'registration', date: '2026-01-01' }), idParams(CHANGE))).status).toBe(404)
  })

  it('books a contribution with the holder named, and records a nyemission', async () => {
    vi.mocked(createShareholderContribution).mockResolvedValueOnce({ ok: true, data: { shareholder_contribution_id: 'c1', kind: 'contribution', party_id: 'p1', amount: 50000, journal_entry_id: ENTRY }, created: true })
    const res = await postContribution(req('/api/bolaget/capital/contributions', { holder_name: 'Anna Ek', promised_on: '2026-03-01', amount: 50000, conditional: true }), noParams)
    expect(res.status).toBe(201)
    expect(vi.mocked(createShareholderContribution).mock.calls[0]![1]).toMatchObject({ holder: { party_id: null, name: 'Anna Ek' }, amount: 50000, conditional: true })

    vi.mocked(createCapitalChange).mockResolvedValueOnce({ ok: true, data: { capital_change_id: CHANGE, kind: 'nyemission', share_capital_amount: 2500, premium_amount: 97500, share_register_event_ids: [] }, created: true })
    const change = await postChange(req('/api/bolaget/capital/changes', { kind: 'nyemission', decided_on: '2026-09-01', decided_by: 'extra_stamma', share_count: 100, price_per_share: 1000 }), noParams)
    expect(change.status).toBe(201)
  })

  it('refuses a registration before the payment (13:28)', async () => {
    vi.mocked(bookCapitalChange).mockResolvedValueOnce({ ok: false, code: 'CAPITAL_CHANGE_NOT_PAID' })
    const res = await postChangeBook(req(`/api/bolaget/capital/changes/${CHANGE}/book`, { step: 'registration', date: '2026-10-01' }), idParams(CHANGE))
    expect(res.status).toBe(409)
  })
})
