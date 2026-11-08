/**
 * connection-store: a connection row is the opt-in for ONE org number.
 * Changing the org number starts the opt-in over (nothing recorded for the
 * old number carries across), and a grant only serves reads while the
 * company still answers for the number it was verified on. On an org number
 * several live companies claim, only the one proven with BankID may hold the
 * ombud connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const queued = createQueuedMockSupabase()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => queued.supabase,
}))

import {
  getOmbudClaimStanding,
  getOmbudClaimStandings,
  keepRowsOnCurrentOrgNumber,
  listVerifiedCompanies,
  ombudClaimStanding,
  recordProbeResult,
} from '../lib/connection-store'

const ORG = '165560000000'
const OTHER_ORG = '165599999999'
const UPSERTED = { id: 'conn-1', company_id: 'company-1', org_number: ORG }

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    environment: 'production',
    org_number: ORG,
    status: 'verified',
    lasombud_status: 'granted',
    moms_ombud_status: 'granted',
    verified_at: '2026-08-01T10:00:00Z',
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  }
}

const upsertPayload = () => queued.findCall('skatteverket_company_connections', 'upsert')?.[0] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  queued.reset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('recordProbeResult', () => {
  it('same org number: a transient error keeps the earlier grant and the opt-in day', async () => {
    queued.enqueue({ data: storedRow() })
    queued.enqueue({ data: UPSERTED })

    await recordProbeResult({
      companyId: 'company-1',
      environment: 'production',
      orgNumber: ORG,
      lasombud: { status: 'error', detail: 'timeout' },
    })

    const payload = upsertPayload()
    expect(payload).toMatchObject({ lasombud_status: 'granted', status: 'verified' })
    expect(payload).not.toHaveProperty('created_at')
  })

  it('a behorighet the probe did not ask about keeps its status and its detail; losing the last grant leaves the row pending, never revoked (#115)', async () => {
    const mine = { status: 'denied', detail: 'ombudsregister: moms_ombud signerad 2026-06-01, före kopplingen 2026-07-01', reason: 'predates_opt_in' }
    queued.enqueue({ data: storedRow({ status: 'partial', moms_ombud_status: 'denied', last_probe_detail: { lasombud: null, moms_ombud: mine } }) })
    queued.enqueue({ data: UPSERTED })

    await recordProbeResult({
      companyId: 'company-1',
      environment: 'production',
      orgNumber: ORG,
      lasombud: { status: 'denied', detail: 'ombudsregister: lasombud saknas' },
      error: 'OMBUD_GRANT_MISSING',
    })

    expect(upsertPayload()).toMatchObject({
      lasombud_status: 'denied',
      moms_ombud_status: 'denied',
      status: 'pending',
      last_error: 'OMBUD_GRANT_MISSING',
      last_probe_detail: { lasombud: { status: 'denied', detail: 'ombudsregister: lasombud saknas' }, moms_ombud: mine },
    })
    expect(upsertPayload()).not.toHaveProperty('moms_ombud_checked_at')
  })

  it('a failed connection read records nothing instead of writing over a granted row', async () => {
    queued.enqueue({ error: { message: 'timeout' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await recordProbeResult({
      companyId: 'company-1',
      environment: 'production',
      orgNumber: ORG,
      lasombud: { status: 'error', detail: 'timeout' },
    })

    expect(result).toBeNull()
    expect(upsertPayload()).toBeUndefined()
  })

  it('a changed org number starts the opt-in over: no grant, verification or creator carries across', async () => {
    queued.enqueue({ data: storedRow({ org_number: OTHER_ORG }) })
    queued.enqueue({ data: UPSERTED })

    await recordProbeResult({
      companyId: 'company-1',
      environment: 'production',
      orgNumber: ORG,
      createdBy: 'user-2',
      lasombud: { status: 'error', detail: 'timeout' },
    })

    const payload = upsertPayload()
    expect(payload.org_number).toBe(ORG)
    // The old number's grants are gone: 'error' cannot keep a grant it never had.
    expect(payload).toMatchObject({ lasombud_status: 'error', moms_ombud_status: 'unknown', verified_at: null })
    expect(payload.created_by).toBe('user-2')
    expect(typeof payload.created_at).toBe('string')
    expect(Date.parse(payload.created_at as string)).toBeGreaterThan(Date.parse('2026-07-01T10:00:00Z'))
  })
})

describe('keepRowsOnCurrentOrgNumber', () => {
  it('keeps only rows whose company still answers for the recorded org number', async () => {
    queued.enqueue({
      data: [
        { company_id: 'same', org_number: '556000-0000', entity_type: 'aktiebolag' },
        { company_id: 'moved', org_number: '559999-9999', entity_type: 'aktiebolag' },
        { company_id: 'cleared', org_number: null, entity_type: 'aktiebolag' },
      ],
    })

    const kept = await keepRowsOnCurrentOrgNumber([
      { company_id: 'same', org_number: ORG },
      { company_id: 'moved', org_number: ORG },
      { company_id: 'cleared', org_number: ORG },
      { company_id: 'no-settings', org_number: ORG },
    ])

    expect(kept.map((row) => row.company_id)).toEqual(['same'])
    expect(queued.findCall('company_settings', 'in')).toEqual([
      'company_id',
      ['same', 'moved', 'cleared', 'no-settings'],
    ])
  })

  it('fails closed: a settings read error keeps nothing', async () => {
    queued.enqueue({ error: { message: 'boom' } })
    expect(await keepRowsOnCurrentOrgNumber([{ company_id: 'same', org_number: ORG }])).toEqual([])
  })

  it('asks nothing for an empty list', async () => {
    expect(await keepRowsOnCurrentOrgNumber([])).toEqual([])
    expect(queued.calls).toHaveLength(0)
  })
})

describe('listVerifiedCompanies', () => {
  it('returns granted rows bound to the current org number only', async () => {
    queued.enqueue({
      data: [
        { company_id: 'same', org_number: ORG, created_by: 'u1' },
        { company_id: 'moved', org_number: ORG, created_by: 'u2' },
      ],
    })
    queued.enqueue({
      data: [
        { company_id: 'same', org_number: '556000-0000', entity_type: 'aktiebolag' },
        { company_id: 'moved', org_number: '559999-9999', entity_type: 'aktiebolag' },
      ],
    })

    const rows = await listVerifiedCompanies('production', 'lasombud')

    expect(rows).toEqual([{ company_id: 'same', org_number: ORG, created_by: 'u1' }])
    expect(queued.findCalls('skatteverket_company_connections', 'eq')).toEqual(
      expect.arrayContaining([['lasombud_status', 'granted']])
    )
  })
})

describe('ombudClaimStanding: who may hold the ombud connection on an org number', () => {
  const none = new Set<string>()

  it('a sole claimant is clear without proof, as before', () => {
    expect(ombudClaimStanding('a', ['a'], none)).toBe('clear')
  })

  it('among several claimants only the one proven company is clear', () => {
    const proven = new Set(['a'])
    expect(ombudClaimStanding('a', ['a', 'b', 'c'], proven)).toBe('clear')
    expect(ombudClaimStanding('b', ['a', 'b', 'c'], proven)).toBe('unproven')
  })

  it('nobody proven: every claimant is held back', () => {
    expect(ombudClaimStanding('a', ['a', 'b'], none)).toBe('unproven')
  })

  it('two proven claimants are both held back', () => {
    const proven = new Set(['a', 'b'])
    expect(ombudClaimStanding('a', ['a', 'b', 'c'], proven)).toBe('proven_twice')
    expect(ombudClaimStanding('b', ['a', 'b', 'c'], proven)).toBe('proven_twice')
    expect(ombudClaimStanding('c', ['a', 'b', 'c'], proven)).toBe('unproven')
  })

  it('proof a company holds for some other number does not count here', () => {
    // 'x' answers for another number now; its proof was read for that one.
    expect(ombudClaimStanding('x', ['a', 'b'], new Set(['x']))).toBe('unproven')
  })

  it('a company that no longer claims the number is held back even when one company does, or none', () => {
    // A row left on the number before the company moved: the number's sole
    // claimant now is someone else, whose grant it must not pick up.
    expect(ombudClaimStanding('left', ['owner'], none)).toBe('unproven')
    expect(ombudClaimStanding('left', [], none)).toBe('unproven')
  })
})

describe('getOmbudClaimStandings', () => {
  const settings = (rows: Array<[string, string]>) =>
    rows.map(([company_id, org_number]) => ({ company_id, org_number, entity_type: 'aktiebolag' }))

  it('a sole claimant needs no proof read', async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['z', '559999-9999']]) })
    queued.enqueue({ data: [] })

    expect(await getOmbudClaimStanding('a', ORG)).toBe('clear')
    expect(queued.findCall('skatteverket_api_audit_log', 'select')).toBeUndefined()
    expect(queued.findCall('company_members', 'select')).toBeUndefined()
  })

  it("an archived copy does not contest the live company's number", async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['copy', '5560000000']]) })
    queued.enqueue({ data: [{ id: 'copy' }] })

    expect(await getOmbudClaimStanding('a', ORG)).toBe('clear')
  })

  it('reads proof per claimant: an own-BankID skattekonto read for that number, by a current member', async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['b', '5560000000']]) })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [{ company_id: 'a', user_id: 'owner' }, { company_id: 'b', user_id: 'stranger' }] })
    queued.enqueue({ data: [{ id: 'audit-1' }] })
    queued.enqueue({ data: [] })

    const result = await getOmbudClaimStandings([
      { companyId: 'a', orgNumber: ORG },
      { companyId: 'b', orgNumber: ORG },
    ])

    expect(Object.fromEntries(result)).toEqual({ a: 'clear', b: 'unproven' })
    const eqs = queued.findCalls('skatteverket_api_audit_log', 'eq')
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['company_id', 'a'],
        ['company_id', 'b'],
        ['ag_registered_id', ORG],
        ['auth_mode', 'user'],
        ['outcome', 'ok'],
      ])
    )
    expect(queued.findCalls('skatteverket_api_audit_log', 'in')).toEqual(
      expect.arrayContaining([
        ['endpoint', ['skattekonto/saldo', 'skattekonto/transaktioner']],
        ['user_id', ['owner']],
        ['user_id', ['stranger']],
      ])
    )
    expect(queued.findCall('skatteverket_api_audit_log', 'gte')).toEqual(['response_status', 200])
    expect(queued.findCall('skatteverket_api_audit_log', 'lt')).toEqual(['response_status', 300])
  })

  it('a claimant without members is never proven and costs no audit read', async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['b', '5560000000']]) })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [{ company_id: 'a', user_id: 'owner' }] })
    queued.enqueue({ data: [{ id: 'audit-1' }] })

    expect(await getOmbudClaimStanding('a', ORG)).toBe('clear')
    expect(queued.findCalls('skatteverket_api_audit_log', 'select')).toHaveLength(1)
  })

  it('before the auth_mode column exists there is no proof: contested claims stay held back, nothing throws', async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['b', '5560000000']]) })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [{ company_id: 'a', user_id: 'owner' }] })
    queued.enqueue({ error: { code: '42703', message: 'column skatteverket_api_audit_log.auth_mode does not exist' } })

    expect(await getOmbudClaimStanding('a', ORG)).toBe('unproven')
  })

  it('a failed proof read throws, never reads as clear', async () => {
    queued.enqueue({ data: settings([['a', '556000-0000'], ['b', '5560000000']]) })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [{ company_id: 'a', user_id: 'owner' }] })
    queued.enqueue({ error: { message: 'timeout' } })

    await expect(getOmbudClaimStanding('a', ORG)).rejects.toThrow(/ownership proof read failed/)
  })

  it('no claims: nothing is read', async () => {
    expect((await getOmbudClaimStandings([])).size).toBe(0)
    expect(queued.findCall('company_settings', 'select')).toBeUndefined()
  })
})
