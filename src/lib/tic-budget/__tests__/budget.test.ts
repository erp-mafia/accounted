import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const logs = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logs.warn, error: vi.fn(), child: vi.fn() }),
}))

import { reserveTicCall, ticBudgetCaps, ticCycleStart, toTicCallPurpose } from '../budget'

function clientWith(result: { data?: unknown; error?: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result
    return { data: result.data ?? null, error: result.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

// 2026-10-28 12:00 Stockholm.
const NOW = new Date('2026-10-28T11:00:00Z')

describe('ticCycleStart', () => {
  it('is this month on or after the reset day', () => {
    expect(ticCycleStart(new Date('2026-10-22T08:00:00Z'), 22)).toBe('2026-10-22')
    expect(ticCycleStart(NOW, 22)).toBe('2026-10-22')
  })

  it('is last month before the reset day, across the year boundary', () => {
    expect(ticCycleStart(new Date('2026-10-21T12:00:00Z'), 22)).toBe('2026-09-22')
    expect(ticCycleStart(new Date('2027-01-05T12:00:00Z'), 22)).toBe('2026-12-22')
  })

  it('follows the Stockholm calendar day, not UTC', () => {
    // 2026-10-21 23:30 UTC is already the 22nd in Stockholm (UTC+2 until 10-25).
    expect(ticCycleStart(new Date('2026-10-21T23:30:00Z'), 22)).toBe('2026-10-22')
  })
})

describe('ticBudgetCaps', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to 3,000 calls with an onboarding reserve and purpose caps that leave it free', () => {
    const caps = ticBudgetCaps()
    expect(caps.total).toBe(3000)
    expect(caps.purpose.onboarding_lookup).toBeNull()
    const others = Object.entries(caps.purpose)
      .filter(([p]) => p !== 'onboarding_lookup')
      .reduce((sum, [, cap]) => sum + (cap ?? 0), 0)
    expect(others).toBeLessThanOrEqual(caps.total - caps.onboardingReserve)
    expect(caps.mcpLookupPerKeyDaily).toBe(20)
    expect(caps.cycleResetDay).toBe(22)
  })

  it('reads env overrides and ignores garbage', () => {
    vi.stubEnv('TIC_MONTHLY_CALL_BUDGET', '5000')
    vi.stubEnv('TIC_BUDGET_CAP_MCP_LOOKUP', '50')
    vi.stubEnv('TIC_MCP_LOOKUP_DAILY_PER_KEY', 'many')
    vi.stubEnv('TIC_BUDGET_CYCLE_DAY', '31')
    const caps = ticBudgetCaps()
    expect(caps.total).toBe(5000)
    expect(caps.purpose.mcp_lookup).toBe(50)
    expect(caps.mcpLookupPerKeyDaily).toBe(20)
    expect(caps.cycleResetDay).toBe(28)
  })
})

describe('toTicCallPurpose', () => {
  it('keeps a known purpose and maps anything else to other', () => {
    expect(toTicCallPurpose('composer')).toBe('composer')
    expect(toTicCallPurpose('scrape')).toBe('other')
    expect(toTicCallPurpose(undefined)).toBe('other')
  })
})

describe('reserveTicCall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows when the RPC allows, threading purpose, caps and cycle', async () => {
    const { client, rpc } = clientWith({ data: { ok: true, total_calls: 12 } })
    await expect(reserveTicCall({ purpose: 'composer' }, client, NOW)).resolves.toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('reserve_external_call', {
      p_provider: 'tic',
      p_cycle_start: '2026-10-22',
      p_purpose: 'composer',
      p_purpose_cap: 1200,
      p_total_cap: 2500,
      p_subject: null,
      p_subject_day_cap: null,
    })
  })

  it('gives onboarding lookup the whole total (the reserve is its own)', async () => {
    const { client, rpc } = clientWith({ data: { ok: true } })
    await reserveTicCall({ purpose: 'onboarding_lookup' }, client, NOW)
    expect(rpc).toHaveBeenCalledWith(
      'reserve_external_call',
      expect.objectContaining({ p_purpose: 'onboarding_lookup', p_purpose_cap: null, p_total_cap: 3000 }),
    )
  })

  it('charges an unnamed purpose to other', async () => {
    const { client, rpc } = clientWith({ data: { ok: true } })
    await reserveTicCall({}, client, NOW)
    expect(rpc).toHaveBeenCalledWith('reserve_external_call', expect.objectContaining({ p_purpose: 'other' }))
  })

  it('adds the per-key daily cap for the MCP lookup only', async () => {
    const { client, rpc } = clientWith({ data: { ok: true } })
    await reserveTicCall({ purpose: 'mcp_lookup', subject: 'key-1' }, client, NOW)
    expect(rpc).toHaveBeenLastCalledWith(
      'reserve_external_call',
      expect.objectContaining({ p_purpose: 'mcp_lookup', p_subject: 'key-1', p_subject_day_cap: 20 }),
    )

    await reserveTicCall({ purpose: 'composer', subject: 'key-1' }, client, NOW)
    expect(rpc).toHaveBeenLastCalledWith(
      'reserve_external_call',
      expect.objectContaining({ p_subject: null, p_subject_day_cap: null }),
    )
  })

  it('denies (fails closed) when the RPC denies, with its scope', async () => {
    const { client } = clientWith({ data: { ok: false, scope: 'subject' } })
    await expect(reserveTicCall({ purpose: 'mcp_lookup', subject: 'k' }, client, NOW)).resolves.toEqual({
      ok: false,
      scope: 'subject',
    })
    const total = clientWith({ data: { ok: false, scope: 'total' } })
    await expect(reserveTicCall({ purpose: 'refresh' }, total.client, NOW)).resolves.toEqual({
      ok: false,
      scope: 'total',
    })
  })

  it('fails open with a warning when the RPC is not deployed yet', async () => {
    const { client } = clientWith({ error: { code: 'PGRST202', message: 'Could not find the function' } })
    await expect(reserveTicCall({ purpose: 'composer' }, client, NOW)).resolves.toEqual({
      ok: true,
      failedOpen: true,
    })
    expect(logs.warn).toHaveBeenCalledWith(
      'tic budget rpc missing, call allowed (fail open)',
      expect.objectContaining({ code: 'PGRST202', purpose: 'composer' }),
    )
  })

  it('fails open when the RPC throws or no database is configured', async () => {
    const { client } = clientWith(new Error('fetch failed'))
    await expect(reserveTicCall({ purpose: 'composer' }, client, NOW)).resolves.toEqual({
      ok: true,
      failedOpen: true,
    })
    await expect(reserveTicCall({ purpose: 'composer' }, null, NOW)).resolves.toEqual({
      ok: true,
      failedOpen: true,
    })
  })
})
