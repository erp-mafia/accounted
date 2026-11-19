import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capability = vi.hoisted(() => ({ has: vi.fn(), batch: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...a: unknown[]) => capability.has(...a),
  getCompanyIdsWithCapability: (...a: unknown[]) => capability.batch(...a),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setBankFeedConnectForTests } from '../connect'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import {
  admittedCompanyIds,
  bankCoveredByOpenPayments,
  bankSwitchProgressTotals,
  enableBankingSunset,
  ENABLE_BANKING_SUNSET_MESSAGE,
  getBankSwitchProgress,
  switchCampaign,
  switchDaysLeft,
  switchDeepLink,
  switchLinkFor,
  switchMailsEnabled,
  switchStateFor,
  switchStateFrom,
  switchStatesForCompanies,
  SWITCH_URGENT_DAYS,
  UNCOVERED_BANK_NEEDLES,
  type SwitchConnectionRow,
} from '../switch-campaign'

const NOW = new Date('2026-10-12T10:00:00Z')
const DEADLINE = '2026-11-09'

function eb(id: string, bank: string | null, overrides: Partial<SwitchConnectionRow> = {}): SwitchConnectionRow {
  return { id, company_id: 'co-1', bank_name: bank, provider: `${(bank ?? 'x').toLowerCase()}-se`, aggregator: 'enable_banking', status: 'active', superseded_by: null, ...overrides }
}
function op(id: string, bank: string | null, overrides: Partial<SwitchConnectionRow> = {}): SwitchConnectionRow {
  return { id, company_id: 'co-1', bank_name: bank, provider: 'open_payments', aggregator: 'open_payments', status: 'active', superseded_by: null, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  setBankFeedConnectForTests({} as never)
  capability.has.mockResolvedValue(true)
  capability.batch.mockResolvedValue(new Set<string>())
})
afterEach(() => {
  vi.unstubAllEnvs()
  setBankFeedConnectForTests(undefined)
})

describe('switchCampaign', () => {
  it('is off without a deadline, and off on a malformed or impossible one', () => {
    expect(switchCampaign({})).toEqual({ on: false, deadline: null })
    expect(switchCampaign({ OPENPAYMENTS_SWITCH_DEADLINE: '' })).toEqual({ on: false, deadline: null })
    expect(switchCampaign({ OPENPAYMENTS_SWITCH_DEADLINE: '9 november' })).toEqual({ on: false, deadline: null })
    expect(switchCampaign({ OPENPAYMENTS_SWITCH_DEADLINE: '2026-13-40' })).toEqual({ on: false, deadline: null })
    expect(switchCampaign({ OPENPAYMENTS_SWITCH_DEADLINE: '2026-02-30' })).toEqual({ on: false, deadline: null })
  })

  it('is on with the ISO date, trimmed, read from the environment by default', () => {
    expect(switchCampaign({ OPENPAYMENTS_SWITCH_DEADLINE: ' 2026-11-09 ' })).toEqual({ on: true, deadline: '2026-11-09' })
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-11-09')
    expect(switchCampaign()).toEqual({ on: true, deadline: '2026-11-09' })
  })

  it('mails are a separate flag, exactly true', () => {
    expect(switchMailsEnabled({})).toBe(false)
    expect(switchMailsEnabled({ OPENPAYMENTS_SWITCH_MAILS: '1' })).toBe(false)
    expect(switchMailsEnabled({ OPENPAYMENTS_SWITCH_MAILS: 'TRUE' })).toBe(true)
  })
})

describe('switchDaysLeft', () => {
  it('counts whole Swedish calendar days: 0 on the day, negative after', () => {
    expect(switchDaysLeft(DEADLINE, NOW)).toBe(28)
    expect(switchDaysLeft('2026-10-12', NOW)).toBe(0)
    expect(switchDaysLeft('2026-10-11', NOW)).toBe(-1)
    // 23:30 UTC on the 11th is already the 12th in Stockholm.
    expect(switchDaysLeft('2026-10-12', new Date('2026-10-11T23:30:00Z'))).toBe(0)
  })
})

describe('enableBankingSunset', () => {
  it('is off while the campaign is off, whatever the date', () => {
    expect(enableBankingSunset({}, new Date('2030-01-01T12:00:00Z'))).toBe(false)
    expect(enableBankingSunset({ OPENPAYMENTS_SWITCH_DEADLINE: 'soon' }, new Date('2030-01-01T12:00:00Z'))).toBe(false)
  })

  it('stays off before and on the deadline day, and is on from the Swedish day after', () => {
    const env = { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE }
    expect(enableBankingSunset(env, NOW)).toBe(false)
    expect(enableBankingSunset(env, new Date('2026-11-09T12:00:00Z'))).toBe(false)
    // 23:30Z on the 9th is already the 10th in Stockholm (UTC+1 in November).
    expect(enableBankingSunset(env, new Date('2026-11-09T22:30:00Z'))).toBe(false)
    expect(enableBankingSunset(env, new Date('2026-11-09T23:30:00Z'))).toBe(true)
    expect(enableBankingSunset(env, new Date('2026-11-10T07:00:00Z'))).toBe(true)
    expect(enableBankingSunset(env, new Date('2027-03-01T07:00:00Z'))).toBe(true)
  })

  it('reads the environment by default', () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
    expect(enableBankingSunset(undefined, NOW)).toBe(true)
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2099-01-01')
    expect(enableBankingSunset(undefined, NOW)).toBe(false)
  })

  it('refuses with the same sentence the error registry carries', () => {
    const entry = getStructuredError(Object.assign(new Error('x'), { code: 'ENABLE_BANKING_SUNSET' }))
    expect(entry.code).toBe('ENABLE_BANKING_SUNSET')
    expect(entry.message_sv).toBe(ENABLE_BANKING_SUNSET_MESSAGE)
    expect(entry.retryable).toBe(false)
  })
})

describe('bankCoveredByOpenPayments', () => {
  it('names the banks Open Payments does not reach, case aside, and treats every other bank as covered', () => {
    // Svea until a Svea consent through Open Payments reads transactions (bank-coverage.ts).
    for (const name of ['Wise', 'PayPal', 'Bank Norwegian', 'Nordea First Card', 'Juni', 'JUNI Technology', 'Svea Bank', 'Svea']) {
      expect(bankCoveredByOpenPayments(name)).toBe(false)
    }
    for (const name of ['Swedbank', 'Nordea', 'Länsförsäkringar Bank', 'Lunar', 'Revolut', null, '']) {
      expect(bankCoveredByOpenPayments(name)).toBe(true)
    }
    expect(UNCOVERED_BANK_NEEDLES).toEqual(['wise', 'paypal', 'norwegian', 'first card', 'juni', 'svea'])
  })
})

describe('switchStateFrom', () => {
  it('is done with no Enable Banking row left, counting the live Open Payments connections', () => {
    const state = switchStateFrom([op('o1', 'Swedbank'), op('o2', 'SEB', { status: 'pending_selection' }), op('o3', 'Nordea', { status: 'pending' })], DEADLINE, NOW)
    expect(state).toMatchObject({ state: 'done', pending: [], uncovered: [], open_payments: 2, deadline: DEADLINE, days_left: 28, passed: false, urgent: false })
  })

  it('lists the active Enable Banking rows at reachable banks without an Open Payments sibling as pending', () => {
    const state = switchStateFrom([eb('e1', 'Swedbank'), eb('e2', 'SEB')], DEADLINE, NOW)
    expect(state.state).toBe('pending')
    expect(state.pending).toEqual([
      { connection_id: 'e1', bank_name: 'Swedbank' },
      { connection_id: 'e2', bank_name: 'SEB' },
    ])
  })

  it('drops an Enable Banking row whose bank has a live Open Payments sibling, matched by name as the dialog matches', () => {
    const rows = [eb('e1', 'Swedbank'), eb('e2', 'Länsförsäkringar Bank'), eb('e3', 'SEB'), op('o1', 'Swedbank'), op('o2', 'Länsförsäkringar', { status: 'expired' })]
    const state = switchStateFrom(rows, DEADLINE, NOW)
    expect(state.pending).toEqual([{ connection_id: 'e3', bank_name: 'SEB' }])
    expect(state.open_payments).toBe(2)
  })

  it('ignores superseded, revoked, expired and errored Enable Banking rows: the campaign is about the live feed', () => {
    const rows = [
      eb('e1', 'Swedbank', { status: 'revoked', superseded_by: 'o1' }),
      eb('e2', 'SEB', { status: 'expired' }),
      eb('e3', 'Nordea', { status: 'error' }),
      eb('e4', 'Handelsbanken', { superseded_by: 'o9' }),
    ]
    expect(switchStateFrom(rows, DEADLINE, NOW)).toMatchObject({ state: 'done', pending: [], uncovered: [] })
  })

  it('treats a row without an aggregator as Enable Banking (every row before Open Payments)', () => {
    const state = switchStateFrom([eb('e1', 'Swedbank', { aggregator: null })], DEADLINE, NOW)
    expect(state.pending).toEqual([{ connection_id: 'e1', bank_name: 'Swedbank' }])
  })

  it('puts the banks Open Payments does not reach under uncovered, before any name match could claim them', () => {
    const rows = [eb('e1', 'Nordea First Card'), eb('e2', 'Wise'), op('o1', 'Nordea')]
    const state = switchStateFrom(rows, DEADLINE, NOW)
    expect(state.state).toBe('uncovered')
    expect(state.pending).toEqual([])
    expect(state.uncovered).toEqual([
      { connection_id: 'e1', bank_name: 'Nordea First Card' },
      { connection_id: 'e2', bank_name: 'Wise' },
    ])
  })

  it('is pending when both kinds are present, with both lists filled', () => {
    const state = switchStateFrom([eb('e1', 'Swedbank'), eb('e2', 'PayPal')], DEADLINE, NOW)
    expect(state.state).toBe('pending')
    expect(state.pending).toHaveLength(1)
    expect(state.uncovered).toHaveLength(1)
  })

  it('turns urgent inside 14 days and passed after the deadline', () => {
    expect(switchStateFrom([eb('e1', 'SEB')], '2026-10-27', NOW)).toMatchObject({ days_left: 15, urgent: false, passed: false })
    expect(switchStateFrom([eb('e1', 'SEB')], '2026-10-26', NOW)).toMatchObject({ days_left: SWITCH_URGENT_DAYS, urgent: true, passed: false })
    expect(switchStateFrom([eb('e1', 'SEB')], '2026-10-12', NOW)).toMatchObject({ days_left: 0, urgent: true, passed: false })
    expect(switchStateFrom([eb('e1', 'SEB')], '2026-10-11', NOW)).toMatchObject({ days_left: -1, urgent: true, passed: true, state: 'pending' })
  })

  it('names a row without a bank name with an empty string', () => {
    expect(switchStateFrom([eb('e1', null)], DEADLINE, NOW).pending).toEqual([{ connection_id: 'e1', bank_name: '' }])
  })
})

describe('switchStateFor', () => {
  function supabaseWith(rows: unknown[]) {
    const mock = createTableMockSupabase({ bank_connections: { data: rows } })
    return { supabase: mock.supabase as unknown as SupabaseClient, mock }
  }

  it('is null while the campaign is off, without touching the database', async () => {
    const { supabase, mock } = supabaseWith([eb('e1', 'SEB')])
    await expect(switchStateFor({ supabase, companyId: 'co-1' }, { now: NOW, env: {} })).resolves.toBeNull()
    expect(mock.tables()).toEqual([])
  })

  it('is null when the door is closed: no connector, not in the pilot, no paid plan', async () => {
    const env = { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE }
    const { supabase } = supabaseWith([eb('e1', 'SEB')])
    setBankFeedConnectForTests(null)
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
    await expect(switchStateFor({ supabase, companyId: 'co-1' }, { now: NOW, env })).resolves.toBeNull()
    setBankFeedConnectForTests({} as never)
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', 'co-9')
    await expect(switchStateFor({ supabase, companyId: 'co-1' }, { now: NOW, env })).resolves.toBeNull()
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
    capability.has.mockResolvedValue(false)
    await expect(switchStateFor({ supabase, companyId: 'co-1' }, { now: NOW, env })).resolves.toBeNull()
  })

  it('reads the company\'s live rows once and computes the state', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', 'co-1')
    const { supabase, mock } = supabaseWith([eb('e1', 'SEB'), op('o1', 'Swedbank')])
    const state = await switchStateFor({ supabase, companyId: 'co-1' }, { now: NOW, env: { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE } })
    expect(state).toMatchObject({ state: 'pending', pending: [{ connection_id: 'e1', bank_name: 'SEB' }], open_payments: 1, days_left: 28 })
    expect(mock.tables()).toEqual(['bank_connections'])
    expect(mock.findCall('bank_connections', 'eq')).toEqual(['company_id', 'co-1'])
    expect(mock.findCall('bank_connections', 'in')).toEqual(['status', ['active', 'pending_selection', 'expired', 'error']])
    expect(mock.findCall('bank_connections', 'is')).toEqual(['superseded_by', null])
  })
})

describe('admittedCompanyIds and switchStatesForCompanies', () => {
  it('admits listed companies without a capability read, and asks the capability once for the rest under *', async () => {
    const supabase = createTableMockSupabase().supabase as unknown as SupabaseClient
    expect(await admittedCompanyIds(supabase, ['a', 'b'], { OPENPAYMENTS_READING_COMPANY_IDS: 'a' })).toEqual(new Set(['a']))
    expect(capability.batch).not.toHaveBeenCalled()
    capability.batch.mockResolvedValue(new Set(['b']))
    expect(await admittedCompanyIds(supabase, ['a', 'b', 'b'], { OPENPAYMENTS_READING_COMPANY_IDS: '*' })).toEqual(new Set(['b']))
    expect(capability.batch).toHaveBeenCalledTimes(1)
    expect(capability.batch.mock.calls[0][1]).toEqual(['a', 'b'])
    // Paid grants only, like the door: a cardless trial is not invited to switch.
    expect(capability.batch.mock.calls[0][2]).toBe('bank_sync')
    expect(capability.batch.mock.calls[0][3]).toEqual({ excludeTrial: true })
    expect(await admittedCompanyIds(supabase, ['a'], {})).toEqual(new Set())
    // With OPENPAYMENTS_READING_TRIALS=true the trial counts, like the door, so a trial on Enable Banking is invited too.
    await admittedCompanyIds(supabase, ['a'], { OPENPAYMENTS_READING_COMPANY_IDS: '*', OPENPAYMENTS_READING_TRIALS: 'true' })
    expect(capability.batch.mock.calls[1][3]).toEqual({})
  })

  it('admits nobody without a connector', async () => {
    setBankFeedConnectForTests(null)
    const supabase = createTableMockSupabase().supabase as unknown as SupabaseClient
    expect(await admittedCompanyIds(supabase, ['a'], { OPENPAYMENTS_READING_COMPANY_IDS: 'a' })).toEqual(new Set())
  })

  it('groups the rows per company and leaves out companies the door does not admit', async () => {
    const rows = [eb('e1', 'SEB'), { ...eb('e2', 'Swedbank'), company_id: 'co-2' }, { ...op('o2', 'Swedbank'), company_id: 'co-2' }, { ...eb('e3', 'Wise'), company_id: 'co-3' }]
    const mock = createTableMockSupabase({ bank_connections: { data: rows } })
    const states = await switchStatesForCompanies(mock.supabase as unknown as SupabaseClient, null, {
      now: NOW,
      env: { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE, OPENPAYMENTS_READING_COMPANY_IDS: 'co-1,co-2' },
    })
    expect([...states.keys()].sort()).toEqual(['co-1', 'co-2'])
    expect(states.get('co-1')).toMatchObject({ state: 'pending', pending: [{ connection_id: 'e1', bank_name: 'SEB' }] })
    expect(states.get('co-2')).toMatchObject({ state: 'done', open_payments: 1 })
    // Every company: no company filter, the live-status and superseded filters still apply.
    expect(mock.findCalls('bank_connections', 'in')).toEqual([['status', ['active', 'pending_selection', 'expired', 'error']]])
  })

  it('answers a listed company without rows as done, and filters the read to the given companies', async () => {
    const mock = createTableMockSupabase({ bank_connections: { data: [] } })
    const states = await switchStatesForCompanies(mock.supabase as unknown as SupabaseClient, ['co-1'], {
      now: NOW,
      env: { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE, OPENPAYMENTS_READING_COMPANY_IDS: 'co-1' },
    })
    expect(states.get('co-1')).toMatchObject({ state: 'done', pending: [], open_payments: 0 })
    expect(mock.findCalls('bank_connections', 'in')).toContainEqual(['company_id', ['co-1']])
  })

  it('is empty while the campaign is off', async () => {
    const mock = createTableMockSupabase({ bank_connections: { data: [eb('e1', 'SEB')] } })
    expect(await switchStatesForCompanies(mock.supabase as unknown as SupabaseClient, null, { env: {} })).toEqual(new Map())
    expect(mock.tables()).toEqual([])
  })
})

describe('deep links', () => {
  it('names the connection on the Kopplingar page, with an origin for mail', () => {
    expect(switchDeepLink('abc')).toBe('/settings/connections?bank_connect_switch=abc')
    expect(switchDeepLink('a b', 'https://app.test')).toBe('https://app.test/settings/connections?bank_connect_switch=a%20b')
    expect(switchLinkFor({ pending: [{ connection_id: 'x' }] })).toBe('/settings/connections?bank_connect_switch=x')
    expect(switchLinkFor({ pending: [{ connection_id: 'x' }, { connection_id: 'y' }] }, 'https://a')).toBe('https://a/settings/connections')
  })
})

describe('the counter', () => {
  it('asks the RPC with the uncovered list and fills in missing totals', async () => {
    const mock = createTableMockSupabase({ 'rpc:bank_switch_progress': { data: { companies: { pending: 3 }, banks: [{ bank: 'SEB', pending: 2, uncovered: 0, switched: 1 }] } } })
    const totals = await bankSwitchProgressTotals(mock.supabase as unknown as SupabaseClient)
    expect(mock.findCall('rpc:bank_switch_progress', 'rpc')).toEqual([{ p_uncovered: ['wise', 'paypal', 'norwegian', 'first card', 'juni', 'svea'] }])
    expect(totals).toEqual({
      companies: { pending: 3, uncovered: 0, done: 0 },
      connections: { pending: 0, uncovered: 0, switched: 0 },
      banks: [{ bank: 'SEB', pending: 2, uncovered: 0, switched: 1 }],
    })
  })

  it('getBankSwitchProgress answers the campaign, the company and the totals only with a service client', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', 'co-1')
    const env = { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE }
    const session = createTableMockSupabase({ bank_connections: { data: [eb('e1', 'SEB')] } })
    const service = createTableMockSupabase({ 'rpc:bank_switch_progress': { data: { companies: { pending: 1, uncovered: 0, done: 0 } } } })
    const ctx = { supabase: session.supabase as unknown as SupabaseClient, companyId: 'co-1' }
    const member = await getBankSwitchProgress(ctx, { now: NOW, env })
    expect(member.campaign).toEqual({ on: true, deadline: DEADLINE, days_left: 28, passed: false })
    expect(member.company?.pending).toEqual([{ connection_id: 'e1', bank_name: 'SEB' }])
    expect(member.totals).toBeNull()
    const admin = await getBankSwitchProgress(ctx, { now: NOW, env, totalsClient: service.supabase as unknown as SupabaseClient })
    expect(admin.totals?.companies.pending).toBe(1)
    const off = await getBankSwitchProgress(ctx, { now: NOW, env: {}, totalsClient: service.supabase as unknown as SupabaseClient })
    expect(off).toEqual({ campaign: { on: false, deadline: null, days_left: null, passed: false }, company: null, totals: null })
  })
})
