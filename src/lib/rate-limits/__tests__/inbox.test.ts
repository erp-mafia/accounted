import { describe, it, expect, vi } from 'vitest'
import { checkInboxUploadRateLimit } from '../inbox'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient
}

describe('checkInboxUploadRateLimit', () => {
  it('returns ok=true when the RPC says ok', async () => {
    const supabase = makeSupabase({ data: { ok: true }, error: null })
    const result = await checkInboxUploadRateLimit(supabase, 'company-1')
    expect(result.ok).toBe(true)
    expect(result.scope).toBeUndefined()
  })

  it('returns ok=false with minute scope and retry_after when minute window hit', async () => {
    const supabase = makeSupabase({
      data: { ok: false, scope: 'minute', retry_after_sec: 42 },
      error: null,
    })
    const result = await checkInboxUploadRateLimit(supabase, 'company-1')
    expect(result.ok).toBe(false)
    expect(result.scope).toBe('minute')
    expect(result.retryAfterSec).toBe(42)
  })

  it('returns ok=false with day scope when day window hit', async () => {
    const supabase = makeSupabase({
      data: { ok: false, scope: 'day', retry_after_sec: 3600 },
      error: null,
    })
    const result = await checkInboxUploadRateLimit(supabase, 'company-1')
    expect(result.ok).toBe(false)
    expect(result.scope).toBe('day')
    expect(result.retryAfterSec).toBe(3600)
  })

  it('fails open (ok=true) when the RPC errors: better to accept than 500 a real user', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'boom' } })
    // Silence the console.error the helper emits on infra error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await checkInboxUploadRateLimit(supabase, 'company-1')
    expect(result.ok).toBe(true)
    spy.mockRestore()
  })

  it('passes the configured minute and day caps to the RPC', async () => {
    const supabase = makeSupabase({ data: { ok: true }, error: null })
    await checkInboxUploadRateLimit(supabase, 'company-xyz')
    expect(supabase.rpc).toHaveBeenCalledWith('check_and_increment_inbox_quota', {
      p_company_id: 'company-xyz',
      p_minute_max: 30,
      p_day_max: 500,
    })
  })
})
