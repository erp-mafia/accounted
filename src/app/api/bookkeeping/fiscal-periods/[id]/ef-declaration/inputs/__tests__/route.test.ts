import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))
vi.mock('@/lib/bokslut/enskild-firma/declaration-inputs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/enskild-firma/declaration-inputs')>()),
  loadNeDeclarationInputs: vi.fn(),
  saveNeDeclarationInputs: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { EfDeclarationNotApplicableError } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import { loadNeDeclarationInputs, saveNeDeclarationInputs } from '@/lib/bokslut/enskild-firma/declaration-inputs'
import { GET, PUT } from '../route'

const URL_BASE = 'http://localhost/api/bookkeeping/fiscal-periods/period-1/ef-declaration/inputs'

function mkParams(id = 'period-1') {
  return { params: Promise.resolve({ id }) }
}

function put(body: unknown) {
  return new Request(URL_BASE, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function signedIn() {
  const mock = createQueuedMockSupabase()
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  vi.mocked(createClient).mockResolvedValue(mock.supabase as never)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/ef-declaration/inputs', () => {
  it('returns 401 when unauthenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(new Request(URL_BASE), mkParams())
    expect(res.status).toBe(401)
    expect(loadNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it("returns 404 for a period that is not the active company's", async () => {
    const { enqueue } = signedIn()
    enqueue({ data: null })

    const res = await GET(new Request(URL_BASE), mkParams('other'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(loadNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it('returns the saved or carried inputs', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    vi.mocked(loadNeDeclarationInputs).mockResolvedValue({
      inputs: { priorYearSchablonavdrag: 61_250 },
      source: 'carried',
      carriedFrom: { fiscalPeriodId: 'period-0', name: '2024' },
    })

    const res = await GET(new Request(URL_BASE), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.source).toBe('carried')
    expect(body.data.inputs.priorYearSchablonavdrag).toBe(61_250)
    expect(loadNeDeclarationInputs).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1')
  })

  it('refuses an aktiebolag with EF_DECLARATION_WRONG_LEGAL_FORM (400)', async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    vi.mocked(loadNeDeclarationInputs).mockRejectedValue(new EfDeclarationNotApplicableError('aktiebolag'))

    const res = await GET(new Request(URL_BASE), mkParams())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('EF_DECLARATION_WRONG_LEGAL_FORM')
  })
})

describe('PUT /api/bookkeeping/fiscal-periods/[id]/ef-declaration/inputs', () => {
  it('returns 401 when unauthenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await PUT(put({ category: 'full' }), mkParams())
    expect(res.status).toBe(401)
    expect(saveNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    signedIn()
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    })

    const res = await PUT(put({ category: 'full' }), mkParams())
    expect(res.status).toBe(403)
    expect(saveNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown key', { kapital: 1 }],
    ['an unknown category', { category: 'retired' }],
    ['a negative prior-year amount', { priorYearSchablonavdrag: -1 }],
    ['the same avsättningsår twice', { pfondExistingFonder: [{ cohort_year: 2023, balance: 1 }, { cohort_year: 2023, balance: 2 }] }],
    ['a fund without a balance', { pfondExistingFonder: [{ cohort_year: 2023, balance: 0 }] }],
    ['a number as text', { kapitalunderlag: '100000' }],
  ])('returns 400 for %s', async (_label, body) => {
    signedIn()

    const res = await PUT(put(body), mkParams())
    expect(res.status).toBe(400)
    expect(saveNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it("returns 404 for a period that is not the active company's", async () => {
    const { enqueue } = signedIn()
    enqueue({ data: null })

    const res = await PUT(put({ category: 'full' }), mkParams('other'))
    expect(res.status).toBe(404)
    expect(saveNeDeclarationInputs).not.toHaveBeenCalled()
  })

  it("saves the inputs in the caller's name", async () => {
    const { enqueue } = signedIn()
    enqueue({ data: { id: 'period-1' } })
    const inputs = { category: 'full' as const, kapitalunderlag: 250_000, pfondExistingFonder: [{ cohort_year: 2023, balance: 40_000 }] }
    vi.mocked(saveNeDeclarationInputs).mockResolvedValue({ inputs, source: 'saved' })

    const res = await PUT(put(inputs), mkParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data.source).toBe('saved')
    expect(saveNeDeclarationInputs).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1', 'user-1', inputs)
  })
})
