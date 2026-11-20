/**
 * Whether the company's skattekonto saldo is a reading it still has
 * (crm#1701): a token row from any member, or the verified ombud grant, by
 * the rule the skattekonto page's saldo route uses. A failed read is
 * 'unknown', never 'not_connected'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const hasOmbudReadAccess = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false))
vi.mock('../ombud-access', () => ({
  hasSkatteverketOmbudReadAccess: (...args: unknown[]) => hasOmbudReadAccess(...(args as [])),
}))

import { readSkatteverketConnection } from '../connection-state'

const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  hasOmbudReadAccess.mockResolvedValue(false)
})

describe('readSkatteverketConnection', () => {
  it('a token row from any member, whatever its status, is a connection', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'token-1' }] })

    expect(await readSkatteverketConnection(supabase as never, COMPANY)).toBe('connected')
    expect(findCall('skatteverket_tokens', 'eq')).toEqual(['company_id', COMPANY])
    expect(hasOmbudReadAccess).not.toHaveBeenCalled()
  })

  it('no token row but the verified ombud grant is a connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    hasOmbudReadAccess.mockResolvedValueOnce(true)

    expect(await readSkatteverketConnection(supabase as never, COMPANY)).toBe('connected')
    expect(hasOmbudReadAccess).toHaveBeenCalledWith(COMPANY)
  })

  it('neither is no connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })

    expect(await readSkatteverketConnection(supabase as never, COMPANY)).toBe('not_connected')
  })

  it('a failed token read is unknown, never not connected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })

    expect(await readSkatteverketConnection(supabase as never, COMPANY)).toBe('unknown')
    expect(hasOmbudReadAccess).not.toHaveBeenCalled()
  })
})
