/**
 * Tests for GET/POST /api/bookkeeping/fiscal-periods/[id]/arsredovisning/narrative.
 *
 * Regression focus: the narrative must stay editable after the fiscal period
 * is closed/locked (Verkställ bokslut). The normal flow closes the books
 * BEFORE the årsredovisning text is written, so gating the save on the
 * period lock made every legitimate save fail. Edits are refused only once
 * a Bolagsverket submission for the period is registrerad.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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

import { GET, POST } from '../route'

const idParams = { params: Promise.resolve({ id: 'period-1' }) }

const narrativeRow = {
  id: 'narrative-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  description: 'Bolaget bedriver konsultverksamhet.',
  important_events: null,
  resultatdisposition: null,
  agm_date: null,
  long_term_debt_over_five_years: null,
  securities_pledged: null,
  contingent_liabilities: null,
  parent_company_name: null,
  parent_company_org_number: null,
  parent_company_city: null,
  updated_at: '2026-01-15T10:00:00Z',
}

function setupSupabase() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/arsredovisning/narrative', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/x'), idParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the period does not belong to the company', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: null }) // fiscal_periods ownership check
    const res = await GET(createMockRequest('/x'), idParams)
    expect(res.status).toBe(404)
  })

  it('returns the persisted narrative', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: narrativeRow }) // getNarrative
    const { status, body } = await parseJsonResponse<{ data: typeof narrativeRow }>(
      await GET(createMockRequest('/x'), idParams),
    )
    expect(status).toBe(200)
    expect(body.data.description).toBe('Bolaget bedriver konsultverksamhet.')
  })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/arsredovisning/narrative', () => {
  const postReq = (body: unknown) => createMockRequest('/x', { method: 'POST', body })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(postReq({ description: 'x' }), idParams)
    expect(res.status).toBe(401)
  })

  it('returns 403 when the caller lacks write permission', async () => {
    setupSupabase()
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(postReq({ description: 'x' }), idParams)
    expect(res.status).toBe(403)
  })

  it('returns 400 on invalid payload', async () => {
    setupSupabase()
    const res = await POST(postReq({ agm_date: '2026-13-99' }), idParams)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a personnummer-shaped parent company org number', async () => {
    setupSupabase()
    const res = await POST(postReq({ parent_company_org_number: '19850101-1234' }), idParams)
    expect(res.status).toBe(400)
  })

  it('accepts a foreign parent company registration identifier', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: null }) // no registrerad submission
    enqueue({ data: { ...narrativeRow, parent_company_org_number: 'CHE-123.456.789' } }) // upsert
    enqueue({ data: null }) // clear narrative confirmation
    const { status, body } = await parseJsonResponse<{ data: typeof narrativeRow }>(
      await POST(postReq({ parent_company_org_number: 'CHE-123.456.789' }), idParams),
    )
    expect(status).toBe(200)
    expect(body.data.parent_company_org_number).toBe('CHE-123.456.789')
  })

  it('saves the ÅRL 6 kap. 3 § member disclosures and rejects a negative amount', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: null }) // no registrerad submission
    enqueue({
      data: {
        ...narrativeRow,
        member_count_change: 'Medlemsantalet ökade från 40 till 52.',
        insatser_repayable_next_year: 25_000,
      },
    }) // upsert
    enqueue({ data: null }) // clear narrative confirmation
    const { status, body } = await parseJsonResponse<{
      data: typeof narrativeRow & { member_count_change: string | null; insatser_repayable_next_year: number | null }
    }>(
      await POST(
        postReq({ member_count_change: 'Medlemsantalet ökade från 40 till 52.', insatser_repayable_next_year: 25_000 }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.member_count_change).toBe('Medlemsantalet ökade från 40 till 52.')
    expect(body.data.insatser_repayable_next_year).toBe(25_000)

    setupSupabase()
    expect((await POST(postReq({ forlagsinsatser_redeemable_two_years: -1 }), idParams)).status).toBe(400)
  })

  it('returns 400 for a fractional or negative medelantal anställda override', async () => {
    setupSupabase()
    expect((await POST(postReq({ medelantal_anstallda_override: 1.5 }), idParams)).status).toBe(400)
    setupSupabase()
    expect((await POST(postReq({ medelantal_anstallda_override: -1 }), idParams)).status).toBe(400)
  })

  it('saves a whole-number medelantal anställda override and lets null clear it', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: null }) // no registrerad submission
    enqueue({ data: { ...narrativeRow, medelantal_anstallda_override: 1 } }) // upsert
    enqueue({ data: null }) // clear narrative confirmation
    const { status, body } = await parseJsonResponse<{
      data: typeof narrativeRow & { medelantal_anstallda_override: number | null }
    }>(await POST(postReq({ medelantal_anstallda_override: 1 }), idParams))
    expect(status).toBe(200)
    expect(body.data.medelantal_anstallda_override).toBe(1)

    const cleared = setupSupabase()
    cleared.enqueue({ data: { id: 'period-1' } })
    cleared.enqueue({ data: null })
    cleared.enqueue({ data: { ...narrativeRow, medelantal_anstallda_override: null } })
    cleared.enqueue({ data: null })
    const res = await POST(postReq({ medelantal_anstallda_override: null }), idParams)
    expect(res.status).toBe(200)
  })

  it('returns 400 for a note override on a note that is not editable', async () => {
    setupSupabase()
    const res = await POST(
      postReq({ note_overrides: { medelantal_anstallda: 'Tio anställda.' } }),
      idParams,
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for a note override longer than the cap', async () => {
    setupSupabase()
    const res = await POST(
      postReq({ note_overrides: { redovisningsprinciper: 'x'.repeat(8001) } }),
      idParams,
    )
    expect(res.status).toBe(400)
  })

  it('saves note overrides with blank or null entries dropped, plus the cash-flow choice', async () => {
    const { enqueue, findCall } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: null }) // no registrerad submission
    enqueue({
      data: {
        ...narrativeRow,
        note_overrides: { redovisningsprinciper: 'Egen text.' },
        omit_kassaflodesanalys: true,
        kassaflodesanalys_omission_confirmed: true,
      },
    }) // upsert
    enqueue({ data: null }) // clear narrative confirmation
    const res = await POST(
      postReq({
        note_overrides: {
          redovisningsprinciper: 'Egen text.',
          vasentliga_handelser_efter_balansdagen: '   ',
        },
        omit_kassaflodesanalys: true,
        kassaflodesanalys_omission_confirmed: true,
      }),
      idParams,
    )
    expect(res.status).toBe(200)
    const upsertArgs = findCall('arsredovisning_narratives', 'upsert')
    expect(upsertArgs?.[0]).toMatchObject({
      note_overrides: { redovisningsprinciper: 'Egen text.' },
      omit_kassaflodesanalys: true,
      kassaflodesanalys_omission_confirmed: true,
    })
    expect(
      (upsertArgs?.[0] as { note_overrides: Record<string, string> }).note_overrides,
    ).not.toHaveProperty('vasentliga_handelser_efter_balansdagen')
  })

  it('returns 400 when the payload contains an unknown field', async () => {
    setupSupabase()
    const res = await POST(
      postReq({ description: 'x', annual_report_version_id: 'forged-version' }),
      idParams,
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the period does not belong to the company', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: null }) // fiscal_periods ownership check
    const res = await POST(postReq({ description: 'x' }), idParams)
    expect(res.status).toBe(404)
  })

  it('saves the narrative for a closed/locked period (regression)', async () => {
    const { enqueue } = setupSupabase()
    // The ownership check no longer selects lock columns: a closed period
    // (Verkställ bokslut done) must still accept narrative saves.
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: null }) // no registrerad submission
    enqueue({ data: narrativeRow }) // upsert
    enqueue({ data: null }) // clear narrative confirmation
    const { status, body } = await parseJsonResponse<{ data: typeof narrativeRow }>(
      await POST(postReq({ description: 'Bolaget bedriver konsultverksamhet.' }), idParams),
    )
    expect(status).toBe(200)
    expect(body.data.description).toBe('Bolaget bedriver konsultverksamhet.')
  })

  it('refuses the save once the årsredovisning is registered at Bolagsverket', async () => {
    const { enqueue } = setupSupabase()
    enqueue({ data: { id: 'period-1' } }) // fiscal_periods ownership check
    enqueue({ data: { id: 'submission-1' } }) // registrerad submission exists
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(postReq({ description: 'x' }), idParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ARSREDOVISNING_REGISTERED')
  })
})
