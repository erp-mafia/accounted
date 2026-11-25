import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const paidMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) => paidMock(...args),
}))

import {
  PEPPOL_MONTHLY_SENDS,
  PEPPOL_PLAN_RULE_ACTOR,
  applyPeppolPlanRule,
  peppolCompanyPays,
  peppolPaidCompanyIds,
} from '@/lib/invoices/peppol-plan-rule'

const NOW = new Date('2026-11-25T10:00:00.000Z')

type Row = {
  company_id: string
  status: 'requested' | 'enabled'
  max_sends: number | null
  receive_enabled: boolean
  request_note: string | null
  enabled_at: string | null
}

const request = (companyId: string, extra: Partial<Row> = {}): Row => ({
  company_id: companyId,
  status: 'requested',
  max_sends: null,
  receive_enabled: false,
  request_note: null,
  enabled_at: null,
  ...extra,
})

const ab = (companyId: string, extra: Record<string, unknown> = {}) => ({
  company_id: companyId,
  org_number: '556677-8899',
  company_name: `Bolag ${companyId}`,
  vat_number: null,
  city: 'Stockholm',
  country: 'SE',
  entity_type: 'aktiebolag',
  is_sandbox: false,
  ...extra,
})

type ChainCall = { method: string; args: unknown[] }

function mock(rows: Row[], settings: unknown[], writes: (calls: ChainCall[]) => { data?: unknown; error?: unknown } = (calls) => {
  const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1]
  return { data: [{ company_id: id }] }
}) {
  return createTableMockSupabase({
    peppol_access: (calls: ChainCall[]) => (calls.some((c) => c.method === 'update') ? writes(calls) : { data: rows }),
    company_settings: { data: settings },
  })
}

function updates(calls: Array<{ table: string; method: string; args: unknown[] }>) {
  return calls.filter((c) => c.table === 'peppol_access' && c.method === 'update').map((c) => c.args[0] as Record<string, unknown>)
}

describe('peppolPaidCompanyIds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for a paid grant of the plan key, the seeded trial left out', async () => {
    paidMock.mockResolvedValue(new Set(['c1']))
    const service = {} as SupabaseClient
    expect(await peppolPaidCompanyIds(service, ['c1', 'c2'])).toEqual(new Set(['c1']))
    expect(paidMock).toHaveBeenCalledWith(service, ['c1', 'c2'], 'email_send', { excludeTrial: true })
    expect(await peppolCompanyPays(service, 'c1')).toBe(true)
    paidMock.mockResolvedValue(new Set())
    expect(await peppolCompanyPays(service, 'c1')).toBe(false)
  })
})

describe('applyPeppolPlanRule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('switches on a paying company that asked: sending at the monthly cap, receiving as it chose', async () => {
    paidMock.mockResolvedValue(new Set(['send-only', 'receiver']))
    const { supabase, calls } = mock(
      [request('send-only'), request('receiver', { receive_enabled: true })],
      [ab('send-only'), ab('receiver')],
    )

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result).toEqual({ enabled: ['send-only', 'receiver'], paused: [], failed: [] })
    expect(updates(calls)).toEqual([
      {
        status: 'enabled',
        enabled_at: NOW.toISOString(),
        enabled_by: PEPPOL_PLAN_RULE_ACTOR,
        disabled_at: null,
        receive_enabled: false,
        max_sends: PEPPOL_MONTHLY_SENDS,
      },
      {
        status: 'enabled',
        enabled_at: NOW.toISOString(),
        enabled_by: PEPPOL_PLAN_RULE_ACTOR,
        disabled_at: null,
        receive_enabled: true,
        max_sends: PEPPOL_MONTHLY_SENDS,
      },
    ])
    // Guarded on the status it read: an operator's change in between wins.
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'status').map((c) => c.args[1])).toEqual(['requested', 'requested'])
    // Only open rows are read: a row the operators disabled is never touched.
    expect(calls.find((c) => c.table === 'peppol_access' && c.method === 'in')?.args).toEqual(['status', ['requested', 'enabled']])
  })

  it('reads the receiving choice of a request made before it had a column', async () => {
    paidMock.mockResolvedValue(new Set(['old']))
    const { supabase, calls } = mock([request('old', { request_note: '[vill ta emot e-fakturor] Vi fakturerar kommuner' })], [ab('old')])

    await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(updates(calls)[0]).toMatchObject({ status: 'enabled', receive_enabled: true })
  })

  it('leaves a request alone while the company does not pay', async () => {
    paidMock.mockResolvedValue(new Set())
    const { supabase, calls } = mock([request('free')], [ab('free')])

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result).toEqual({ enabled: [], paused: [], failed: [] })
    expect(updates(calls)).toEqual([])
  })

  it('never switches on a company that cannot be a participant, or the demo company, even when it pays', async () => {
    paidMock.mockResolvedValue(new Set(['sole-trader', 'sandbox']))
    const { supabase, calls } = mock(
      [request('sole-trader'), request('sandbox')],
      [ab('sole-trader', { entity_type: 'enskild_firma', org_number: '800101-1234' }), ab('sandbox', { is_sandbox: true })],
    )

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result.enabled).toEqual([])
    expect(updates(calls)).toEqual([])
  })

  it('pauses a company whose plan ended: back to requested with the pause stamped, nothing else changed', async () => {
    paidMock.mockResolvedValue(new Set(['paying']))
    const { supabase, calls } = mock(
      [
        request('lapsed', { status: 'enabled', max_sends: 10, receive_enabled: true, enabled_at: '2026-10-19T13:30:00.000Z' }),
        request('paying', { status: 'enabled', max_sends: 10, enabled_at: '2026-10-19T13:30:00.000Z' }),
      ],
      [],
    )

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result).toEqual({ enabled: [], paused: ['lapsed'], failed: [] })
    expect(updates(calls)).toEqual([{ status: 'requested', disabled_at: NOW.toISOString() }])
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'status').map((c) => c.args[1])).toEqual(['enabled'])
  })

  it('brings a paused company back with the cap and receiving choice it had', async () => {
    paidMock.mockResolvedValue(new Set(['back']))
    const { supabase, calls } = mock(
      [request('back', { max_sends: null, receive_enabled: true, enabled_at: '2026-09-07T10:00:00.000Z' })],
      [ab('back')],
    )

    await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    const [update] = updates(calls)
    expect(update).toMatchObject({ status: 'enabled', receive_enabled: true })
    // An operator's unlimited cap (null) survives the pause.
    expect(update).not.toHaveProperty('max_sends')
  })

  it('keeps a returning send-only row send-only, whatever the old note says', async () => {
    paidMock.mockResolvedValue(new Set(['send-only']))
    const { supabase, calls } = mock(
      [request('send-only', { receive_enabled: false, request_note: '[vill ta emot e-fakturor]', enabled_at: '2026-09-07T10:00:00.000Z' })],
      [ab('send-only')],
    )

    await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(updates(calls)[0]).toMatchObject({ status: 'enabled', receive_enabled: false })
  })

  it('reports a failed write and goes on with the rest', async () => {
    paidMock.mockResolvedValue(new Set(['a', 'b']))
    const { supabase } = mock([request('a'), request('b')], [ab('a'), ab('b')], (calls) => {
      const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1]
      return id === 'a' ? { error: { message: 'boom' } } : { data: [{ company_id: id }] }
    })

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result).toEqual({ enabled: ['b'], paused: [], failed: [{ companyId: 'a', reason: 'boom' }] })
  })

  it('does not count a row another writer changed first', async () => {
    paidMock.mockResolvedValue(new Set(['raced']))
    const { supabase } = mock([request('raced')], [ab('raced')], () => ({ data: [] }))

    const result = await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, now: NOW })

    expect(result).toEqual({ enabled: [], paused: [], failed: [] })
  })

  it('reads only the companies asked about when given ids', async () => {
    paidMock.mockResolvedValue(new Set())
    const { supabase, calls } = mock([request('one')], [])

    await applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient, companyIds: ['one'] })

    expect(calls.some((c) => c.table === 'peppol_access' && c.method === 'in' && c.args[0] === 'company_id')).toBe(true)
    expect(calls.some((c) => c.table === 'peppol_access' && c.method === 'range')).toBe(false)
  })

  it('throws when it cannot tell who pays, so nobody is paused on a failed read', async () => {
    paidMock.mockRejectedValue(new Error('Failed to resolve capability company scopes: timeout'))
    const { supabase, calls } = mock([request('x', { status: 'enabled', enabled_at: '2026-10-19T13:30:00.000Z' })], [])

    await expect(applyPeppolPlanRule({ service: supabase as unknown as SupabaseClient })).rejects.toThrow('timeout')
    expect(updates(calls)).toEqual([])
  })
})
