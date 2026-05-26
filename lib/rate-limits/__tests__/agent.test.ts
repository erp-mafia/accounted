import { describe, it, expect, vi } from 'vitest'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '../agent'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient
}

describe('checkAgentRateLimit', () => {
  it('returns ok=true when the RPC says ok', async () => {
    const result = await checkAgentRateLimit(makeSupabase({ data: { ok: true }, error: null }), 'user-1')
    expect(result.ok).toBe(true)
    expect(result.scope).toBeUndefined()
  })

  it('returns ok=false with minute scope + retry when the minute window is hit', async () => {
    const result = await checkAgentRateLimit(
      makeSupabase({ data: { ok: false, scope: 'minute', retry_after_sec: 60 }, error: null }),
      'user-1',
    )
    expect(result.ok).toBe(false)
    expect(result.scope).toBe('minute')
    expect(result.retryAfterSec).toBe(60)
  })

  it('returns ok=false with day scope when the day window is hit', async () => {
    const result = await checkAgentRateLimit(
      makeSupabase({ data: { ok: false, scope: 'day', retry_after_sec: 3600 }, error: null }),
      'user-1',
    )
    expect(result.scope).toBe('day')
    expect(result.retryAfterSec).toBe(3600)
  })

  it('fails open (ok=true) when the RPC errors — never 429 a real user on infra blip', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await checkAgentRateLimit(makeSupabase({ data: null, error: { message: 'boom' } }), 'user-1')
    expect(result.ok).toBe(true)
    spy.mockRestore()
  })

  it('passes generous caps keyed per-user', async () => {
    const supabase = makeSupabase({ data: { ok: true }, error: null })
    await checkAgentRateLimit(supabase, 'user-xyz')
    expect(supabase.rpc).toHaveBeenCalledWith('check_and_increment_agent_quota', {
      p_user_id: 'user-xyz',
      p_minute_max: 30,
      p_day_max: 1000,
    })
  })
})

describe('agentRateLimitResponseBody', () => {
  it('day scope → daily-limit message', () => {
    expect(agentRateLimitResponseBody({ ok: false, scope: 'day' }).error).toMatch(/dagens gräns/i)
  })
  it('minute scope → try-again-soon message', () => {
    expect(agentRateLimitResponseBody({ ok: false, scope: 'minute' }).error).toMatch(/förfrågningar/i)
  })
})
