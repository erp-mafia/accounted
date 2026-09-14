import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/bokslut/ixbrl/build-input', () => ({
  buildIxbrlInput: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { makeInput } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import { GET } from '../route'
import { GET as GET_VALIDATE } from '../validate/route'

function mkReq(query = '') {
  return new Request(
    `http://localhost/api/bookkeeping/fiscal-periods/period-1/arsredovisning/ixbrl${query}`,
  )
}

function mkParams(id = 'period-1') {
  return { params: Promise.resolve({ id }) }
}

function authedSupabase() {
  const { supabase } = createQueuedMockSupabase()
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  supabase.rpc.mockImplementation(async (name: string) => ({
    data: name === 'acquire_sie_period_read' ? 'lease-1' : null, error: null,
  }))
  vi.mocked(createClient).mockResolvedValue(supabase as never)
  return supabase
}

describe('GET /api/bookkeeping/fiscal-periods/[id]/arsredovisning/ixbrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the period is missing', async () => {
    authedSupabase()
    vi.mocked(buildIxbrlInput).mockRejectedValue(new Error('Fiscal period not found'))

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(404)
  })

  it('returns the generated XHTML inline for iframe preview', async () => {
    authedSupabase()
    vi.mocked(buildIxbrlInput).mockResolvedValue(makeInput())

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/xhtml+xml')
    expect(res.headers.get('Content-Disposition')).toContain('inline')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    const body = await res.text()
    expect(body).toContain('<?xml version="1.0" encoding="utf-8"?>')
    expect(body).toContain('se-k2-ab-risbs-2024-09-12.xsd')
    expect(body).toContain('ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG')
  })

  it('serves as attachment with ?download=1 and forwards utdelning', async () => {
    authedSupabase()
    vi.mocked(buildIxbrlInput).mockResolvedValue(makeInput())

    const res = await GET(mkReq('?download=1&utdelning=50000'), mkParams())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain('arsredovisning-2025-12-31.xhtml')
    expect(vi.mocked(buildIxbrlInput)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      { proposedDividend: 50000 },
    )
  })

  it('returns 500 envelope when generation explodes', async () => {
    authedSupabase()
    const broken = makeInput()
    broken.entryPointId = 'okant-entry-point'
    vi.mocked(buildIxbrlInput).mockResolvedValue(broken)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(500)
  })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/arsredovisning/ixbrl/validate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok with no errors for the happy-path fixture', async () => {
    authedSupabase()
    const input = makeInput()
    // Keep date rules deterministic: the fixture period ends 2025-12-31 and
    // AGM is 2026-03-15, both in the past relative to the suite's clock.
    vi.mocked(buildIxbrlInput).mockResolvedValue(input)

    const res = await GET_VALIDATE(mkReq('/validate'), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ok).toBe(true)
    expect(body.data.error_count).toBe(0)
    expect(body.data.generated_bytes).toBeGreaterThan(10_000)
    expect(body.data.entry_point).toBe('k2-ab-risbs-2024-09-12')
  })

  it('reports rule violations as issues without failing the request', async () => {
    authedSupabase()
    const input = makeInput()
    input.underskrifter.signers = []
    input.totals.tillgangar = { current: 1, previous: 1 }
    vi.mocked(buildIxbrlInput).mockResolvedValue(input)

    const res = await GET_VALIDATE(mkReq('/validate'), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ok).toBe(false)
    const issueCodes = body.data.issues.map((issue: { code: string }) => issue.code)
    expect(issueCodes).toContain('1107')
    expect(issueCodes).toContain('3005')
  })

  it('surfaces generation failures as ACC-GEN issues', async () => {
    authedSupabase()
    const broken = makeInput()
    broken.rr = {} as never
    broken.totals = { ...broken.totals }
    // Force a generation error by pointing at a non-existent entry point.
    broken.entryPointId = 'okant-entry-point'
    vi.mocked(buildIxbrlInput).mockResolvedValue(broken)

    const res = await GET_VALIDATE(mkReq('/validate'), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    const issueCodes = body.data.issues.map((issue: { code: string }) => issue.code)
    expect(issueCodes).toContain('ACC-GEN')
    expect(body.data.ok).toBe(false)
  })

  it('returns 404 when the period is missing', async () => {
    authedSupabase()
    vi.mocked(buildIxbrlInput).mockRejectedValue(new Error('Fiscal period not found'))

    const res = await GET_VALIDATE(mkReq('/validate'), mkParams())
    expect(res.status).toBe(404)
  })
})
