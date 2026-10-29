import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'member' }),
}))
vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/share-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/share-register')>()),
  loadShareRegisterData: vi.fn(),
  registerShareEvent: vi.fn(),
}))
vi.mock('@/lib/bolaget/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/roles')>()),
  loadRoles: vi.fn(),
  addCompanyRole: vi.fn(),
}))
vi.mock('@/lib/bolaget/people', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/people')>()),
  loadRegisterParties: vi.fn().mockResolvedValue(new Map()),
  loadFullPersonnummer: vi.fn().mockResolvedValue(new Map()),
  savePersonPrivate: vi.fn(),
}))
vi.mock('@/lib/bolaget/beneficial-owners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/beneficial-owners')>()),
  confirmBeneficialOwners: vi.fn(),
}))
vi.mock('@/lib/bolaget/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/session')>()),
  companyForPdf: vi.fn().mockResolvedValue({ name: 'Test AB', org_number: '5561234567' }),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { getCompanyRole } from '@/lib/auth/require-write'
import { bolagetGate } from '@/lib/bolaget/gate'
import { loadShareRegisterData, registerShareEvent } from '@/lib/bolaget/share-register'
import { addCompanyRole, loadRoles } from '@/lib/bolaget/roles'
import { loadFullPersonnummer, savePersonPrivate } from '@/lib/bolaget/people'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { replayShareRegister, summarizeHoldings } from '@/lib/bolaget/register-state'
import { reconcileWithSettings } from '@/lib/bolaget/reconcile'
import type { ShareRegisterData } from '@/lib/bolaget/share-register'
import type { RolesView } from '@/lib/bolaget/roles'
import { GET as getRegister } from '../share-register/route'
import { POST as postEvent } from '../share-register/events/route'
import { PATCH as patchPerson } from '../people/[partyId]/route'
import { POST as postRole } from '../roles/route'
import { POST as postAssessment } from '../beneficial-owners/assessments/route'
import { GET as getExport } from '../aktiebok/export/route'
import { GET as getExtract } from '../holders/[partyId]/extract/route'

const supabase = {}
const noParams = { params: Promise.resolve({}) } as never
const ANNA = '11111111-1111-4111-8111-111111111111'

const events = [
  {
    id: 'e1', event_number: 1, event_date: '2020-01-10', kind: 'bildande' as const, share_class_id: 'A', to_share_class_id: null, from_party_id: null,
    to_party_id: ANNA, range_start: 1, range_end: 100, transfer_reason: null, price_total: null, ratio: null, aktiebrev_number: null,
    aktiebrev_action: null, counterparty_party_id: null, note_status: null, corrects_event_id: null, registered_on: null, decision_id: null,
    document_id: null, journal_entry_id: null, note: null, created_at: '2020-01-10T10:00:00Z',
  },
]
const classes = [{ id: 'A', code: 'A', name: null, votes_per_share: 1, forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: false, forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null }]

function registerData(): ShareRegisterData {
  const replay = replayShareRegister(events)
  return {
    as_of: '2026-10-29',
    is_avstamningsbolag: false,
    classes,
    events,
    replay,
    summary: summarizeHoldings(replay.ranges, classes),
    parties: new Map([[ANNA, { party_id: ANNA, name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', birth_date: null, address: null, email: null }]]),
    reconciliation: reconcileWithSettings(100, { aktiekapital: 25000, antal_aktier: 100 }),
  }
}

const roles: RolesView = { as_of: '2026-10-29', signatory_rule: null, roles: [], signatory_rules: [], board: [], ceo: null }

function unauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(bolagetGate).mockResolvedValue(null)
  vi.mocked(loadShareRegisterData).mockResolvedValue(registerData())
  vi.mocked(loadRoles).mockResolvedValue(roles)
})

describe('GET /api/bolaget/share-register', () => {
  const get = (q = '') => getRegister(createMockRequest(`/api/bolaget/share-register${q}`), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get()).status).toBe(401)
    expect(loadShareRegisterData).not.toHaveBeenCalled()
  })

  it('answers 404 outside the rollout and 409 for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    const off = await get()
    expect(off.status).toBe(404)
    expect((await off.json()).error.code).toBe('BOLAGET_DISABLED')
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect((await get()).status).toBe(409)
  })

  it('refuses a malformed as_of', async () => {
    expect((await get('?as_of=2026-13-45')).status).toBe(400)
  })

  it('answers the register, the history and the roles, never a full personnummer', async () => {
    const res = await get('?as_of=2026-10-29')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.register.holders).toEqual([expect.objectContaining({ party_id: ANNA, name: 'Anna Ek', identity: 'XXXXXXXX-1234', shares: 100, capital_pct: 100 })])
    expect(body.data.events[0].text).toContain('Bildande')
    expect(loadShareRegisterData).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), '2026-10-29')
    expect(JSON.stringify(body)).not.toMatch(/"(19|20)\d{6}-?\d{4}"/)
  })
})

describe('POST /api/bolaget/share-register/events', () => {
  const post = (body: unknown, q = '') => postEvent(createMockRequest(`/api/bolaget/share-register/events${q}`, { method: 'POST', body }), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post({ kind: 'anteckning', event_date: '2026-10-01', note: 'x' })).status).toBe(401)
  })

  it('refuses an unknown kind or field', async () => {
    expect((await post({ kind: 'gift', event_date: '2026-10-01' })).status).toBe(400)
    expect((await post({ kind: 'anteckning', event_date: '2026-10-01', personnummer: '198001011234' })).status).toBe(400)
    expect(registerShareEvent).not.toHaveBeenCalled()
  })

  it('previews with dry_run and enters the event otherwise', async () => {
    vi.mocked(registerShareEvent).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { kind: 'overlatelse' } })
    const preview = await post({ kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'Bo', share_count: 10, transfer_reason: 'gava' }, '?dry_run=true')
    expect(preview.status).toBe(200)
    expect((await preview.json()).data).toEqual({ kind: 'overlatelse' })
    expect(vi.mocked(registerShareEvent).mock.calls[0]![2]).toEqual({ dryRun: true })

    vi.mocked(registerShareEvent).mockResolvedValueOnce({
      ok: true,
      data: { share_register_event_id: 'e2', event_number: 2, kind: 'overlatelse', event_date: '2026-10-01', range_start: 1, range_end: 10, share_class_id: 'A', from_party_id: ANNA, to_party_id: 'p2' },
      created: true,
    })
    const res = await post({ kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'Bo', share_count: 10, transfer_reason: 'gava' })
    expect(res.status).toBe(201)
    expect((await res.json()).data.event_number).toBe(2)
    expect(vi.mocked(registerShareEvent).mock.calls[1]![1]).toMatchObject({ created_via: 'app' })
  })

  it('answers a register refusal with its code', async () => {
    vi.mocked(registerShareEvent).mockResolvedValueOnce({ ok: false, code: 'SHARE_REGISTER_NOT_HELD', messageSv: 'aktierna 1-10 ägs inte av överlåtaren.' })
    const res = await post({ kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'Bo', range_start: 1, range_end: 10, transfer_reason: 'kop' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SHARE_REGISTER_NOT_HELD')
  })
})

describe('PATCH /api/bolaget/people/{partyId}', () => {
  const patch = (body: unknown) =>
    patchPerson(createMockRequest(`/api/bolaget/people/${ANNA}`, { method: 'PATCH', body }), { params: Promise.resolve({ partyId: ANNA }) })

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await patch({ city: 'Lund' })).status).toBe(401)
  })

  it('refuses an unknown field', async () => {
    expect((await patch({ ssn: '1' })).status).toBe(400)
  })

  it('answers 404 for a party outside the company', async () => {
    vi.mocked(savePersonPrivate).mockResolvedValueOnce({ ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' })
    expect((await patch({ city: 'Lund' })).status).toBe(404)
  })

  it('saves and answers only the masked personnummer', async () => {
    vi.mocked(savePersonPrivate).mockResolvedValueOnce({ ok: true, personnummer_masked: 'XXXXXXXX-1234' })
    const res = await patch({ personnummer: '19800101-1234', city: 'Lund' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ party_id: ANNA, personnummer_masked: 'XXXXXXXX-1234' })
    expect(savePersonPrivate).toHaveBeenCalledWith('company-1', ANNA, { personnummer: '19800101-1234', city: 'Lund' })
  })
})

describe('POST /api/bolaget/roles', () => {
  const post = (body: unknown) => postRole(createMockRequest('/api/bolaget/roles', { method: 'POST', body }), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post({ name: 'Bo', role: 'vd', valid_from: '2026-01-01' })).status).toBe(401)
  })

  it('refuses a verklig huvudman (recorded by an assessment) and a bad date', async () => {
    expect((await post({ name: 'Bo', role: 'verklig_huvudman', valid_from: '2026-01-01' })).status).toBe(400)
    expect((await post({ name: 'Bo', role: 'vd', valid_from: 'igår' })).status).toBe(400)
  })

  it('adds the role', async () => {
    vi.mocked(addCompanyRole).mockResolvedValueOnce({ ok: true, data: { company_role_id: 'r1', party_id: 'p1', role: 'vd', valid_from: '2026-01-01' }, created: true })
    const res = await post({ name: 'Bo', role: 'vd', valid_from: '2026-01-01' })
    expect(res.status).toBe(201)
    expect(vi.mocked(addCompanyRole).mock.calls[0]![1]).toMatchObject({ party: { name: 'Bo' }, role: 'vd', source: 'person' })
  })
})

describe('POST /api/bolaget/beneficial-owners/assessments', () => {
  const post = (body: unknown) => postAssessment(createMockRequest('/api/bolaget/beneficial-owners/assessments', { method: 'POST', body }), noParams)
  const valid = { assessed_on: '2026-10-29', conclusion: 'owners_identified', owners: [{ party_id: ANNA }], family_aggregation_checked: true, control_agreements: false }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post(valid)).status).toBe(401)
  })

  it('refuses a missing family question', async () => {
    const { family_aggregation_checked: _omit, ...rest } = valid
    expect((await post(rest)).status).toBe(400)
  })

  it('records the assessment', async () => {
    vi.mocked(confirmBeneficialOwners).mockResolvedValueOnce({
      ok: true,
      data: { beneficial_owner_assessment_id: 'a1', changed: true, ended_role_ids: [], added_role_ids: ['r1'], deadline_source_key: 'bolaget:verklig-huvudman:a1', filing_url: 'https://bolagsverket.se/x' },
      created: true,
    })
    const res = await post(valid)
    expect(res.status).toBe(201)
    expect((await res.json()).data.deadline_source_key).toBe('bolaget:verklig-huvudman:a1')
  })
})

describe('GET /api/bolaget/aktiebok/export and the holder extract', () => {
  it('refuses an unknown format', async () => {
    expect((await getExport(createMockRequest('/api/bolaget/aktiebok/export?format=xls'), noParams)).status).toBe(400)
  })

  it('answers the CSV, with the full personnummer only for an owner or admin', async () => {
    const res = await getExport(createMockRequest('/api/bolaget/aktiebok/export?format=csv&view=holders'), noParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    expect(await res.text()).toContain('Anna Ek;XXXXXXXX-1234;100')
    expect(loadFullPersonnummer).not.toHaveBeenCalled()

    vi.mocked(getCompanyRole).mockResolvedValueOnce({ ok: true, role: 'owner' } as never)
    vi.mocked(loadFullPersonnummer).mockResolvedValueOnce(new Map([[ANNA, '19800101-1234']]))
    const admin = await getExport(createMockRequest('/api/bolaget/aktiebok/export?format=csv&view=holders'), noParams)
    expect(await admin.text()).toContain('Anna Ek;19800101-1234;100')
  })

  it('answers 404 for a holder the register does not name', async () => {
    const res = await getExtract(createMockRequest('/api/bolaget/holders/nobody/extract'), { params: Promise.resolve({ partyId: 'nobody' }) })
    expect(res.status).toBe(404)
  })
})
