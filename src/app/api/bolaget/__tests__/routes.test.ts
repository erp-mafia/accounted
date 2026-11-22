import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
// The register writes are owner/admin routes (requireAdmin): these tests act
// as an admin; admin-doors.test.ts holds the member's refusal.
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  companyAdminRequiredResponse: (await importOriginal<typeof import('@/lib/auth/require-write')>()).companyAdminRequiredResponse,
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'member' }),
  isCompanyAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/share-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/share-register')>()),
  loadShareRegisterData: vi.fn(),
  registerShareEvent: vi.fn(),
  completeShareRegisterSetup: vi.fn(),
}))
vi.mock('@/lib/bolaget/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/roles')>()),
  loadRoles: vi.fn(),
  addCompanyRole: vi.fn(),
}))
vi.mock('@/lib/bolaget/people', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/people')>()),
  loadRegisterParties: vi.fn().mockResolvedValue(new Map()),
  loadFullIdentity: vi.fn().mockResolvedValue(new Map()),
  savePersonPrivate: vi.fn(),
  renameRegisterParty: vi.fn(),
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
import { completeShareRegisterSetup, loadShareRegisterData, registerShareEvent } from '@/lib/bolaget/share-register'
import { addCompanyRole, loadRoles } from '@/lib/bolaget/roles'
import { loadFullIdentity, loadRegisterParties, renameRegisterParty, savePersonPrivate } from '@/lib/bolaget/people'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { replayShareRegister, summarizeHoldings } from '@/lib/bolaget/register-state'
import { reconcileWithSettings } from '@/lib/bolaget/reconcile'
import type { ShareRegisterData } from '@/lib/bolaget/share-register'
import type { RolesView } from '@/lib/bolaget/roles'
import { GET as getRegister } from '../share-register/route'
import { POST as postEvent } from '../share-register/events/route'
import { POST as postSetup } from '../share-register/setup/route'
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
    setup_completed_at: null,
    classes,
    events,
    replay,
    summary: summarizeHoldings(replay.ranges, classes),
    parties: new Map([[ANNA, { party_id: ANNA, name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', foreign_id_masked: null, birth_date: null, address: null, email: null }]]),
    reconciliation: reconcileWithSettings(100, { aktiekapital: 25000, antal_aktier: 100 }),
    note_problems: [],
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

  it('sends a person\'s address, e-mail and birth date to an owner or admin only', async () => {
    const anna = {
      party_id: ANNA, name: 'Anna Ek', kind: 'person' as const, org_number: null, personnummer_masked: 'XXXXXXXX-1234', foreign_id_masked: null,
      birth_date: '1980-01-01', address: { line1: 'Storgatan 1', line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE' }, email: 'anna@example.se',
    }
    vi.mocked(loadRegisterParties).mockResolvedValue(new Map([[ANNA, anna]]))

    vi.mocked(getCompanyRole).mockResolvedValueOnce({ ok: true, role: 'member' } as never)
    const forMember = (await (await get('')).json()).data
    expect(forMember.can_print_full_identity).toBe(false)
    expect(forMember.people).toEqual([expect.objectContaining({ party_id: ANNA, name: 'Anna Ek', personnummer_masked: 'XXXXXXXX-1234', address: null, email: null, birth_date: null })])

    vi.mocked(getCompanyRole).mockResolvedValueOnce({ ok: true, role: 'admin' } as never)
    const forAdmin = (await (await get('')).json()).data
    expect(forAdmin.can_print_full_identity).toBe(true)
    expect(forAdmin.people).toEqual([expect.objectContaining({ email: 'anna@example.se', birth_date: '1980-01-01', address: expect.objectContaining({ line1: 'Storgatan 1' }) })])
    vi.mocked(loadRegisterParties).mockResolvedValue(new Map())
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
    // No name was sent: the party is not touched.
    expect(renameRegisterParty).not.toHaveBeenCalled()
  })

  it('checks the name, saves the particulars, then writes the name', async () => {
    const renamed = { ok: true as const, party_id: ANNA, name: 'Ek Holding AB', org_number: '5560000001', changed: true }
    vi.mocked(renameRegisterParty).mockResolvedValue(renamed)
    vi.mocked(savePersonPrivate).mockResolvedValueOnce({ ok: true, personnummer_masked: null })
    const res = await patch({ name: 'Ek Holding AB', org_number: '556000-0001', city: 'Lund' })
    expect(res.status).toBe(200)
    const calls = vi.mocked(renameRegisterParty).mock.calls
    expect(calls.map((call) => call.slice(1))).toEqual([
      [ANNA, { name: 'Ek Holding AB', org_number: '556000-0001' }, { dryRun: true }],
      [ANNA, { name: 'Ek Holding AB', org_number: '556000-0001' }],
    ])
    expect(savePersonPrivate).toHaveBeenCalledWith('company-1', ANNA, { city: 'Lund' })
    // The check runs before the particulars are saved, the write after.
    const order = [calls.length > 0 ? vi.mocked(renameRegisterParty).mock.invocationCallOrder[0]! : 0, vi.mocked(savePersonPrivate).mock.invocationCallOrder[0]!, vi.mocked(renameRegisterParty).mock.invocationCallOrder[1]!]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('saves nothing when the name is refused, and says why', async () => {
    vi.mocked(renameRegisterParty).mockResolvedValueOnce({ ok: false, code: 'BOLAGET_PARTY_INVALID', messageSv: 'Organisationsnumret är inte giltigt.' })
    const res = await patch({ org_number: '1234', city: 'Lund' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ code: 'BOLAGET_PARTY_INVALID', message: 'Organisationsnumret är inte giltigt.' })
    expect(savePersonPrivate).not.toHaveBeenCalled()
  })

  it('leaves the name alone when the particulars are refused', async () => {
    vi.mocked(renameRegisterParty).mockResolvedValue({ ok: true, party_id: ANNA, name: 'Anna Berg', org_number: null, changed: true })
    vi.mocked(savePersonPrivate).mockResolvedValueOnce({ ok: false, code: 'BOLAGET_PERSONNUMMER_INVALID' })
    const res = await patch({ name: 'Anna Berg', personnummer: '123' })
    expect(res.status).toBe(400)
    // Checked, never written.
    expect(vi.mocked(renameRegisterParty).mock.calls.map((call) => call[3])).toEqual([{ dryRun: true }])
  })

  it('refuses an empty name before anything is read', async () => {
    expect((await patch({ name: '  ' })).status).toBe(400)
    expect(renameRegisterParty).not.toHaveBeenCalled()
  })
})

describe('POST /api/bolaget/share-register/setup', () => {
  const post = (body: unknown = {}, q = '') => postSetup(createMockRequest(`/api/bolaget/share-register/setup${q}`, { method: 'POST', body }), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post()).status).toBe(401)
    expect(completeShareRegisterSetup).not.toHaveBeenCalled()
  })

  it('answers 404 outside the rollout and refuses an unknown field', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect((await post()).status).toBe(404)
    expect((await post({ setup_completed_at: '2020-01-01' })).status).toBe(400)
    expect(completeShareRegisterSetup).not.toHaveBeenCalled()
  })

  it('previews with dry_run and completes the setup otherwise', async () => {
    vi.mocked(completeShareRegisterSetup).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { total_shares: 100, holders: 1, last_event_number: 1, warnings: [] } })
    const preview = await post({}, '?dry_run=true')
    expect(preview.status).toBe(200)
    expect((await preview.json()).data).toMatchObject({ total_shares: 100, holders: 1 })
    expect(vi.mocked(completeShareRegisterSetup).mock.calls[0]![2]).toEqual({ dryRun: true })

    vi.mocked(completeShareRegisterSetup).mockResolvedValueOnce({ ok: true, data: { setup_completed_at: '2026-10-29T09:00:00Z', total_shares: 100, holders: 1, completed_now: true } })
    const res = await post({ expected_last_event_number: 1 })
    expect(res.status).toBe(200)
    expect((await res.json()).data.setup_completed_at).toBe('2026-10-29T09:00:00Z')
    expect(vi.mocked(completeShareRegisterSetup).mock.calls[1]![1]).toEqual({ expected_last_event_number: 1 })
  })

  it('answers an empty register and a register that has moved on with their codes', async () => {
    vi.mocked(completeShareRegisterSetup).mockResolvedValueOnce({ ok: false, code: 'SHARE_REGISTER_EMPTY' })
    const empty = await post()
    expect(empty.status).toBe(409)
    expect((await empty.json()).error.code).toBe('SHARE_REGISTER_EMPTY')
    vi.mocked(completeShareRegisterSetup).mockResolvedValueOnce({ ok: false, code: 'SHARE_REGISTER_STALE', details: { last_event_number: 2 } })
    expect((await post({ expected_last_event_number: 1 })).status).toBe(409)
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
    expect(loadFullIdentity).not.toHaveBeenCalled()

    vi.mocked(getCompanyRole).mockResolvedValueOnce({ ok: true, role: 'owner' } as never)
    vi.mocked(loadFullIdentity).mockResolvedValueOnce(new Map([[ANNA, '19800101-1234']]))
    const admin = await getExport(createMockRequest('/api/bolaget/aktiebok/export?format=csv&view=holders'), noParams)
    expect(await admin.text()).toContain('Anna Ek;19800101-1234;100')
  })

  it('answers 404 for a holder the register does not name', async () => {
    const res = await getExtract(createMockRequest('/api/bolaget/holders/nobody/extract'), { params: Promise.resolve({ partyId: 'nobody' }) })
    expect(res.status).toBe(404)
  })
})
