import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn() }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { setBankFeedConnectForTests, type BankFeedConnect } from '../connect'
import { bankFeedPilot, bankFeedPilotAdmits, openBankFeedDoor, reachesUncoveredBanks, startingGrants } from '../door'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const supabase = {} as SupabaseClient
const entitled = vi.mocked(hasCapability)
const fake = {} as BankFeedConnect

beforeEach(() => {
  entitled.mockReset()
  setBankFeedConnectForTests(fake)
  vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '')
  vi.stubEnv('OPENPAYMENTS_READING_TRIALS', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  setBankFeedConnectForTests(undefined)
})

describe('bankFeedPilot', () => {
  it('is off when unset or empty, everyone on a plan with *, and exactly the listed companies otherwise', () => {
    expect(bankFeedPilot({})).toBeNull()
    expect(bankFeedPilot({ OPENPAYMENTS_READING_COMPANY_IDS: '' })).toBeNull()
    expect(bankFeedPilot({ OPENPAYMENTS_READING_COMPANY_IDS: ' , ' })).toBeNull()
    expect(bankFeedPilot({ OPENPAYMENTS_READING_COMPANY_IDS: '*' })).toBe('all')
    const listed = bankFeedPilot({ OPENPAYMENTS_READING_COMPANY_IDS: 'co-2, co-1 ,co-3' })
    expect([...(listed as Set<string>)]).toEqual(['co-2', 'co-1', 'co-3'])
  })

  it('counts the seeded trial only when OPENPAYMENTS_READING_TRIALS is exactly true', () => {
    expect(startingGrants({})).toEqual({ excludeTrial: true })
    expect(startingGrants({ OPENPAYMENTS_READING_TRIALS: 'false' })).toEqual({ excludeTrial: true })
    expect(startingGrants({ OPENPAYMENTS_READING_TRIALS: '1' })).toEqual({ excludeTrial: true })
    expect(startingGrants({ OPENPAYMENTS_READING_TRIALS: ' true ' })).toEqual({})
  })

  it('answers the cron without the plan check', () => {
    expect(bankFeedPilotAdmits(COMPANY, {})).toBe('no')
    expect(bankFeedPilotAdmits(COMPANY, { OPENPAYMENTS_READING_COMPANY_IDS: '*' })).toBe('with_capability')
    expect(bankFeedPilotAdmits(COMPANY, { OPENPAYMENTS_READING_COMPANY_IDS: COMPANY })).toBe('yes')
    expect(bankFeedPilotAdmits(COMPANY, { OPENPAYMENTS_READING_COMPANY_IDS: 'other' })).toBe('no')
  })
})

describe('openBankFeedDoor', () => {
  it('is closed without a connector key, whatever the switch says', async () => {
    setBankFeedConnectForTests(null)
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'no_connector' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('is closed when the switch is unset: Enable Banking stays the feed', async () => {
    entitled.mockResolvedValue(true)
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'not_in_pilot' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('lets exactly the listed companies in, whatever their plan', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', `${COMPANY},other`)
    entitled.mockResolvedValue(false)
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: true, connect: fake })
    expect(await openBankFeedDoor({ supabase, companyId: 'stranger' })).toEqual({ ok: false, reason: 'not_in_pilot' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('with * asks for a paid grant: the seeded trial does not open it, since every consent is billed', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
    entitled.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: true, connect: fake })
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'subscription' })
    expect(entitled).toHaveBeenCalledWith(supabase, COMPANY, 'bank_sync', { excludeTrial: true })
    expect(entitled).not.toHaveBeenCalledWith(supabase, COMPANY, 'bank_sync')
  })

  it('with * and OPENPAYMENTS_READING_TRIALS=true lets the seeded trial in, and an expired trial gets the subscription answer', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
    vi.stubEnv('OPENPAYMENTS_READING_TRIALS', 'true')
    entitled.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: true, connect: fake })
    expect(await openBankFeedDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'subscription' })
    expect(entitled).toHaveBeenCalledWith(supabase, COMPANY, 'bank_sync', {})
    expect(entitled).not.toHaveBeenCalledWith(supabase, COMPANY, 'bank_sync', { excludeTrial: true })
  })
})

describe('reachesUncoveredBanks', () => {
  it('is off when unset or empty and lets exactly the listed companies through to a held-back bank', () => {
    expect(reachesUncoveredBanks(COMPANY, {})).toBe(false)
    expect(reachesUncoveredBanks(COMPANY, { OPENPAYMENTS_UNCOVERED_PILOT_COMPANY_IDS: ' , ' })).toBe(false)
    expect(reachesUncoveredBanks(COMPANY, { OPENPAYMENTS_UNCOVERED_PILOT_COMPANY_IDS: `co-2, ${COMPANY} ` })).toBe(true)
    expect(reachesUncoveredBanks('co-3', { OPENPAYMENTS_UNCOVERED_PILOT_COMPANY_IDS: `co-2, ${COMPANY}` })).toBe(false)
    // Never a wildcard: the list is for proving a fix with one company, not opening a bank.
    expect(reachesUncoveredBanks(COMPANY, { OPENPAYMENTS_UNCOVERED_PILOT_COMPANY_IDS: '*' })).toBe(false)
  })
})
