import { describe, it, expect, vi } from 'vitest'
import { isSandboxCompany, sandboxBlockedResponse, guardSandbox } from '../guard'

function mockSupabase(isSandboxValue: boolean | null) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: isSandboxValue === null ? null : { is_sandbox: isSandboxValue },
  })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

describe('guardSandbox', () => {
  it('returns null for non-sandbox companies so the route proceeds', async () => {
    const supabase = mockSupabase(false)
    const result = await guardSandbox(supabase, '00000000-0000-0000-0000-000000000001')
    expect(result).toBeNull()
  })

  it('returns null when no company_settings row exists', async () => {
    const supabase = mockSupabase(null)
    const result = await guardSandbox(supabase, '00000000-0000-0000-0000-000000000001')
    expect(result).toBeNull()
  })

  it('returns the 403 NextResponse for sandbox companies', async () => {
    const supabase = mockSupabase(true)
    const result = await guardSandbox(supabase, '00000000-0000-0000-0000-000000000001')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(403)
    const body = await result!.json()
    expect(body.sandbox_blocked).toBe(true)
    expect(body.error).toMatch(/sandlådan/i)
    expect(body.error_en).toMatch(/sandbox/i)
  })
})

describe('isSandboxCompany', () => {
  it('returns false when is_sandbox is missing', async () => {
    const supabase = mockSupabase(null)
    expect(await isSandboxCompany(supabase, 'cid')).toBe(false)
  })

  it('returns true only when is_sandbox is exactly true', async () => {
    expect(await isSandboxCompany(mockSupabase(true), 'cid')).toBe(true)
    expect(await isSandboxCompany(mockSupabase(false), 'cid')).toBe(false)
  })
})

describe('sandboxBlockedResponse', () => {
  it('returns a 403 with sandbox_blocked envelope', async () => {
    const res = sandboxBlockedResponse()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.sandbox_blocked).toBe(true)
  })
})
