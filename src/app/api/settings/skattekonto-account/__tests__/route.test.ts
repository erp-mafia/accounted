import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const getStateMock = vi.fn()
const setAccountMock = vi.fn()
const transferMock = vi.fn()
vi.mock('@/lib/skatteverket/skattekonto-account-service', () => ({
  getSkattekontoAccountState: (...args: unknown[]) => getStateMock(...args),
  setSkattekontoAccount: (...args: unknown[]) => setAccountMock(...args),
  createSkattekontoTransferDraft: (...args: unknown[]) => transferMock(...args),
}))

import { GET, PUT } from '../route'
import { POST as TRANSFER } from '../transfer-draft/route'

const URL = 'http://localhost/api/settings/skattekonto-account'
const params = { params: Promise.resolve({}) }

function request(method: string, body?: unknown, url = URL): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const STATE = {
  entity_type: 'enskild_firma',
  account: '2012',
  chosen: '2012',
  choices: ['1630', '2012'],
  books_suggest: '2012',
  as_of: '2026-10-14',
  balances: [
    { account: '1630', balance: 500 },
    { account: '2012', balance: 0 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
})

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: mockSupabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

describe('GET /api/settings/skattekonto-account', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await GET(request('GET'), params)).status).toBe(401)
    expect(getStateMock).not.toHaveBeenCalled()
  })

  it('returns the account, the choice and what sits on each account', async () => {
    getStateMock.mockResolvedValue({ ok: true, data: STATE })
    const res = await GET(request('GET'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: STATE })
    expect(getStateMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }))
  })
})

describe('PUT /api/settings/skattekonto-account', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await PUT(request('PUT', { account: '2012' }), params)).status).toBe(401)
  })

  it('returns 403 for a member who is not owner or admin, before validating or writing', async () => {
    enqueue({ data: false }) // user_is_company_admin
    const res = await PUT(request('PUT', { account: '2012' }), params)
    expect(res.status).toBe(403)
    expect(setAccountMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an account that is neither 1630 nor 2012', async () => {
    enqueue({ data: true })
    const res = await PUT(request('PUT', { account: '1930' }), params)
    expect(res.status).toBe(400)
    expect(setAccountMock).not.toHaveBeenCalled()
  })

  it('stores the choice and answers with the new state and what is left on the old account', async () => {
    enqueue({ data: true })
    setAccountMock.mockResolvedValue({
      ok: true,
      data: { state: STATE, previous_account: '1630', left_on_previous: 500 },
    })
    const res = await PUT(request('PUT', { account: '2012' }), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { state: STATE, previous_account: '1630', left_on_previous: 500 } })
    expect(setAccountMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), '2012')
  })

  it("maps the service's refusal for an aktiebolag to 400 with its code", async () => {
    enqueue({ data: true })
    setAccountMock.mockResolvedValue({
      ok: false,
      code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED',
      details: { account: '2012', allowed: ['1630'], entity_type: 'aktiebolag' },
    })
    const res = await PUT(request('PUT', { account: '2012' }), params)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('SKATTEKONTO_ACCOUNT_NOT_ALLOWED')
  })
})

describe('POST /api/settings/skattekonto-account/transfer-draft', () => {
  const TRANSFER_URL = `${URL}/transfer-draft`

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await TRANSFER(request('POST', {}, TRANSFER_URL), params)).status).toBe(401)
  })

  it('returns 400 for a date that is no date', async () => {
    enqueue({ data: { role: 'owner' } }) // company_members role
    const res = await TRANSFER(request('POST', { entry_date: '2026-13-45' }, TRANSFER_URL), params)
    expect(res.status).toBe(400)
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('creates the draft and answers 201 with its id', async () => {
    enqueue({ data: { role: 'member' } })
    transferMock.mockResolvedValue({
      ok: true,
      created: true,
      data: { journal_entry_id: 'je-1', entry_date: '2026-10-14', from_account: '1630', to_account: '2012', amount: 500 },
    })
    const res = await TRANSFER(request('POST', {}, TRANSFER_URL), params)
    expect(res.status).toBe(201)
    expect((await res.json()).data.journal_entry_id).toBe('je-1')
  })

  it('answers 409 when nothing is left to move', async () => {
    enqueue({ data: { role: 'owner' } })
    transferMock.mockResolvedValue({ ok: false, code: 'SKATTEKONTO_TRANSFER_NOTHING_TO_MOVE', details: {} })
    const res = await TRANSFER(request('POST', {}, TRANSFER_URL), params)
    expect(res.status).toBe(409)
  })

  it('is refused for a viewer', async () => {
    enqueue({ data: { role: 'viewer' } })
    const res = await TRANSFER(request('POST', {}, TRANSFER_URL), params)
    expect(res.status).toBe(403)
    expect(transferMock).not.toHaveBeenCalled()
  })
})
