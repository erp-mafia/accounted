import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { budgetFor, reserveUpstream } from '../upstream-budget'

afterEach(() => vi.unstubAllEnvs())

function supa(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

describe('budgetFor', () => {
  it('defaults sit under the EB per-minute quota and are env-overridable', () => {
    expect(budgetFor('bank').minuteMax).toBe(90)
    vi.stubEnv('CONNECT_BANK_RPM_BUDGET', '50')
    expect(budgetFor('bank').minuteMax).toBe(50)
  })
})

describe('reserveUpstream', () => {
  it('passes the service and the resolved budget to the RPC and returns ok', async () => {
    const { supabase, rpc } = supa({ data: { ok: true } })
    expect(await reserveUpstream(supabase, 'bank')).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('connector_reserve_upstream', { p_service: 'bank', p_minute_max: 90, p_hour_max: 3000 })
  })

  it('maps a budget rejection to a Retry-After result', async () => {
    const { supabase } = supa({ data: { ok: false, scope: 'hour', retry_after_sec: 3600 } })
    expect(await reserveUpstream(supabase, 'bank')).toEqual({ ok: false, scope: 'hour', retryAfterSec: 3600 })
  })

  // Fail-open: a broken counter table must not block every connector call.
  it('fails open on a DB error', async () => {
    const { supabase } = supa({ error: { message: 'boom' } })
    expect(await reserveUpstream(supabase, 'skatteverket')).toEqual({ ok: true })
  })
})
