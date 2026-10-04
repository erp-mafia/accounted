/**
 * connection-store: a connection row is the opt-in for ONE org number.
 * Changing the org number starts the opt-in over (nothing recorded for the
 * old number carries across), and a grant only serves reads while the
 * company still answers for the number it was verified on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const queued = createQueuedMockSupabase()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => queued.supabase,
}))

import {
  keepRowsOnCurrentOrgNumber,
  listVerifiedCompanies,
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
