/**
 * Tests for GET /api/settings/booking-templates.
 *
 * Focused on the is_hidden decoration: every row carries the per-company flag,
 * a failed hidden lookup falls back to "nothing hidden" (showing extra
 * templates is the safe direction), and hidden rows are still RETURNED so the
 * settings panel can offer restore; filtering is the pickers' job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
  requireCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const resolveSkattekontoMock = vi.fn()
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: (...args: unknown[]) => resolveSkattekontoMock(...args),
}))

import { GET, POST } from '../route'

/** Chainable builder resolving queued {data,error} per from() in call order. */
function createQueuedSupabase(results: { data?: unknown; error?: unknown }[]) {
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'or', 'order', 'maybeSingle']) {
      b[m] = () => b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { from: () => makeBuilder() }
}

const TEMPLATES = [
  { id: 'tpl-1', name: 'Bankavgift', is_system: true },
  { id: 'tpl-2', name: 'Eget uttag', is_system: true },
]

beforeEach(() => {
  vi.clearAllMocks()
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

const req = () => createMockRequest('/api/settings/booking-templates', { method: 'GET' })

describe('GET /api/settings/booking-templates', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(req(), { params: Promise.resolve({}) })).status).toBe(401)
  })

  it('marks hidden templates but still returns them', async () => {
    // from() order: companies, then library / usage / hidden.
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      { data: TEMPLATES },
      { data: [] },
      { data: [{ template_id: 'tpl-2' }] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; is_hidden: boolean }[]
    }>(await GET(req(), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data.find((t) => t.id === 'tpl-1')?.is_hidden).toBe(false)
    expect(body.data.find((t) => t.id === 'tpl-2')?.is_hidden).toBe(true)
  })

  it('hands a 2012 firm the system skattekonto templates on 2012, its own templates as written (PH 175)', async () => {
    resolveSkattekontoMock.mockResolvedValue('2012')
    const skvLines = [
      { account: '1630', label: 'Skattekonto', side: 'debit', type: 'business', ratio: 1 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1 },
    ]
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      {
        data: [
          { id: 'sys-skv', name: 'Insättning skattekonto', is_system: true, lines: skvLines },
          { id: 'own-skv', name: 'Egen', is_system: false, company_id: 'c', lines: skvLines },
        ],
      },
      { data: [] },
      { data: [] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; lines: { account: string }[] }[]
    }>(await GET(req(), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data.find((t) => t.id === 'sys-skv')?.lines.map((l) => l.account)).toEqual(['2012', '1930'])
    expect(body.data.find((t) => t.id === 'own-skv')?.lines.map((l) => l.account)).toEqual(['1630', '1930'])
  })

  it('reads the skattekonto account only when a system template names 1630', async () => {
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      { data: TEMPLATES },
      { data: [] },
      { data: [] },
    ])
    auth(supabase)
    expect((await GET(req(), { params: Promise.resolve({}) })).status).toBe(200)
    expect(resolveSkattekontoMock).not.toHaveBeenCalled()
  })

  it('falls back to nothing hidden when the hidden lookup fails', async () => {
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      { data: TEMPLATES },
      { data: [] },
      { error: { message: 'boom' } },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{
      data: { is_hidden: boolean }[]
    }>(await GET(req(), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data.every((t) => t.is_hidden === false)).toBe(true)
  })
})

describe('POST /api/settings/booking-templates', () => {
  const lines = [
    { account: '5010', label: 'Hyra', side: 'debit', type: 'business', ratio: 1 },
    { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
  ]
  const tagged = [{ ...lines[0], dimensions: { '1': 'KS01', '6': 'P001' } }, lines[1]]
  const TEAM = '22222222-2222-4222-8222-222222222222'

  /** A supabase whose insert records its row and answers it back. */
  function createInsertingSupabase() {
    const inserted: Record<string, unknown>[] = []
    const supabase = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    }
    return { supabase, inserted }
  }

  const post = (body: unknown) =>
    POST(createMockRequest('/api/settings/booking-templates', { method: 'POST', body }), { params: Promise.resolve({}) })

  beforeEach(() => {
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await post({ name: 'Hyra', lines })).status).toBe(401)
  })

  it('returns 400 for a template with fewer than two lines', async () => {
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    expect((await post({ name: 'Hyra', lines: [lines[0]] })).status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it("keeps a company template's dimensions", async () => {
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    expect((await post({ name: 'Hyra', lines: tagged })).status).toBe(201)
    expect(inserted[0]).toMatchObject({
      company_id: '11111111-1111-4111-8111-111111111111',
      team_id: null,
      lines: tagged,
    })
  })

  it('stores a team template without the dimensions its lines were sent with', async () => {
    // A tag is one company's own code; a team template is booked by every
    // company of the team.
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    expect((await post({ name: 'Hyra', lines: tagged, team_id: TEAM })).status).toBe(201)
    expect(inserted[0]).toMatchObject({ company_id: null, team_id: TEAM })
    expect(inserted[0].lines).toEqual(lines)
  })
})
