/**
 * The ownership and signatory registers are owner/admin routes
 * (withRouteContext requireAdmin): a plain member is refused with the
 * canonical owner/admin envelope before the handler runs, an owner and an
 * admin write. The predicate is the database's (user_is_company_admin),
 * answered here from the caller's role.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest } from '@/tests/helpers'
import type { CompanyRole } from '@/types'

const state = vi.hoisted(() => ({ role: 'member' as string }))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(async (_supabase: unknown, _userId: string, facts?: { role?: string }) => {
    if (facts) facts.role = state.role
    return 'company-1'
  }),
}))
// The real predicate and envelope; the write guard must not be what decides.
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/bolaget/share-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/share-register')>()),
  registerShareEvent: vi.fn(),
  completeShareRegisterSetup: vi.fn(),
  createShareClass: vi.fn(),
  updateShareClass: vi.fn(),
  setAvstamningsbolag: vi.fn(),
}))
vi.mock('@/lib/bolaget/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/roles')>()),
  addCompanyRole: vi.fn(),
  endCompanyRole: vi.fn(),
  setSignatoryRule: vi.fn(),
}))
vi.mock('@/lib/bolaget/beneficial-owners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/beneficial-owners')>()),
  confirmBeneficialOwners: vi.fn(),
}))
vi.mock('@/lib/bolaget/people', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/people')>()),
  savePersonPrivate: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { completeShareRegisterSetup, createShareClass, registerShareEvent, setAvstamningsbolag, updateShareClass } from '@/lib/bolaget/share-register'
import { addCompanyRole, endCompanyRole, setSignatoryRule } from '@/lib/bolaget/roles'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { savePersonPrivate } from '@/lib/bolaget/people'
import { POST as postEvent } from '../share-register/events/route'
import { POST as postSetup } from '../share-register/setup/route'
import { POST as postClass } from '../share-classes/route'
import { PATCH as patchClass } from '../share-classes/[id]/route'
import { POST as postRole } from '../roles/route'
import { POST as postRoleEnd } from '../roles/[id]/end/route'
import { POST as postSignatoryRule } from '../signatory-rules/route'
import { POST as postAssessment } from '../beneficial-owners/assessments/route'
import { PATCH as patchPerson } from '../people/[partyId]/route'
import { PATCH as patchSettings } from '../settings/route'

const ID = '22222222-2222-4222-8222-222222222222'
const ANNA = '11111111-1111-4111-8111-111111111111'
const ADMIN_ROLES: readonly string[] = ['owner', 'admin']

const supabase = {
  rpc: vi.fn(async (fn: string, args: { p_company_id?: string }) => {
    if (fn !== 'user_is_company_admin') throw new Error(`unexpected rpc ${fn}`)
    return { data: args.p_company_id === 'company-1' && ADMIN_ROLES.includes(state.role), error: null }
  }),
}

const noParams = { params: Promise.resolve({}) } as never
const idParams = { params: Promise.resolve({ id: ID }) } as never
const personParams = { params: Promise.resolve({ partyId: ANNA }) } as never
const req = (path: string, method: string, body: unknown) => createMockRequest(path, { method, body })
const ok = <T>(data: T) => ({ ok: true as const, data, created: true })

interface Door {
  name: string
  call: () => Promise<Response>
  write: { mock: { calls: unknown[] } }
  status: number
}

const doors: Door[] = [
  {
    name: 'POST /api/bolaget/share-register/events',
    call: () => postEvent(req('/api/bolaget/share-register/events', 'POST', { kind: 'anteckning', event_date: '2026-10-01', note: 'x' }), noParams),
    write: vi.mocked(registerShareEvent),
    status: 201,
  },
  {
    name: 'POST /api/bolaget/share-register/setup',
    call: () => postSetup(req('/api/bolaget/share-register/setup', 'POST', {}), noParams),
    write: vi.mocked(completeShareRegisterSetup),
    status: 200,
  },
  {
    name: 'POST /api/bolaget/share-classes',
    call: () => postClass(req('/api/bolaget/share-classes', 'POST', { code: 'B', votes_per_share: 1 }), noParams),
    write: vi.mocked(createShareClass),
    status: 201,
  },
  {
    name: 'PATCH /api/bolaget/share-classes/:id',
    call: () => patchClass(req(`/api/bolaget/share-classes/${ID}`, 'PATCH', { votes_per_share: 10 }), idParams),
    write: vi.mocked(updateShareClass),
    status: 200,
  },
  {
    name: 'POST /api/bolaget/roles',
    call: () => postRole(req('/api/bolaget/roles', 'POST', { name: 'Bo Ek', role: 'styrelseledamot', valid_from: '2026-06-15' }), noParams),
    write: vi.mocked(addCompanyRole),
    status: 201,
  },
  {
    name: 'POST /api/bolaget/roles/:id/end',
    call: () => postRoleEnd(req(`/api/bolaget/roles/${ID}/end`, 'POST', { valid_to: '2026-06-14' }), idParams),
    write: vi.mocked(endCompanyRole),
    status: 200,
  },
  {
    name: 'POST /api/bolaget/signatory-rules',
    call: () => postSignatoryRule(req('/api/bolaget/signatory-rules', 'POST', { rule_text: 'Firman tecknas av styrelsen', valid_from: '2026-06-15' }), noParams),
    write: vi.mocked(setSignatoryRule),
    status: 201,
  },
  {
    name: 'POST /api/bolaget/beneficial-owners/assessments',
    call: () =>
      postAssessment(
        req('/api/bolaget/beneficial-owners/assessments', 'POST', {
          assessed_on: '2026-10-29',
          conclusion: 'owners_identified',
          owners: [{ party_id: ANNA }],
          family_aggregation_checked: true,
          control_agreements: false,
        }),
        noParams,
      ),
    write: vi.mocked(confirmBeneficialOwners),
    status: 201,
  },
  {
    name: 'PATCH /api/bolaget/people/:partyId',
    call: () => patchPerson(req(`/api/bolaget/people/${ANNA}`, 'PATCH', { city: 'Lund' }), personParams),
    write: vi.mocked(savePersonPrivate),
    status: 200,
  },
  {
    name: 'PATCH /api/bolaget/settings',
    call: () => patchSettings(req('/api/bolaget/settings', 'PATCH', { is_avstamningsbolag: true }), noParams),
    write: vi.mocked(setAvstamningsbolag),
    status: 200,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  state.role = 'member'
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(registerShareEvent).mockResolvedValue(ok({ share_register_event_id: 'e1', event_number: 1, kind: 'anteckning', event_date: '2026-10-01', range_start: null, range_end: null, share_class_id: null, from_party_id: null, to_party_id: null }))
  vi.mocked(completeShareRegisterSetup).mockResolvedValue({ ok: true, data: { setup_completed_at: '2026-10-29T09:00:00Z', total_shares: 100, holders: 1, completed_now: true } })
  const shareClass = { id: ID, code: 'B', name: null, votes_per_share: 1, forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: false, forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null }
  vi.mocked(createShareClass).mockResolvedValue(ok(shareClass))
  vi.mocked(updateShareClass).mockResolvedValue(ok({ ...shareClass, votes_per_share: 10 }))
  vi.mocked(addCompanyRole).mockResolvedValue(ok({ company_role_id: ID, party_id: 'p1', role: 'styrelseledamot', valid_from: '2026-06-15' }) as never)
  vi.mocked(endCompanyRole).mockResolvedValue(ok({ company_role_id: ID, valid_to: '2026-06-14' }) as never)
  vi.mocked(setSignatoryRule).mockResolvedValue(ok({ signatory_rule_id: 'r1', rule_text: 'Firman tecknas av styrelsen', valid_from: '2026-06-15', ended_rule_ids: [] }) as never)
  vi.mocked(confirmBeneficialOwners).mockResolvedValue(ok({ beneficial_owner_assessment_id: 'a1', changed: true, ended_role_ids: [], added_role_ids: [], deadline_source_key: null, filing_url: null }) as never)
  vi.mocked(savePersonPrivate).mockResolvedValue({ ok: true, personnummer_masked: null })
  vi.mocked(setAvstamningsbolag).mockResolvedValue(undefined)
})

describe.each(doors)('$name', (door) => {
  it('refuses a plain member with the owner/admin envelope and writes nothing', async () => {
    state.role = 'member'
    const res = await door.call()
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string; details: { required_roles: string[] } } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toBe('Bara företagets ägare eller en administratör kan göra det här.')
    expect(body.error.details.required_roles).toEqual(['owner', 'admin'])
    expect(door.write.mock.calls).toHaveLength(0)
    expect(supabase.rpc).toHaveBeenCalledWith('user_is_company_admin', { p_company_id: 'company-1' })
    // requireAdmin replaces the write guard: a member passes that one.
    expect(requireWritePermission).not.toHaveBeenCalled()
  })

  it.each<CompanyRole>(['owner', 'admin'])('lets the %s write', async (role) => {
    state.role = role
    const res = await door.call()
    expect(res.status).toBe(door.status)
    expect(door.write.mock.calls).toHaveLength(1)
  })
})
