import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('../lib/api-client', () => ({ deleteSession: vi.fn() }))
import { deleteSession } from '../lib/api-client'
import { revokeUnusedSession } from '../lib/session-revocation'

const remove = vi.mocked(deleteSession)
beforeEach(() => { vi.clearAllMocks(); remove.mockResolvedValue(undefined) })
function client(claim: unknown = { claimed: true, token: 'claim-token' }) {
  const rpc = vi.fn().mockResolvedValueOnce({ data: claim, error: null }).mockResolvedValue({ data: true, error: null })
  return { rpc, supabase: { rpc } as unknown as SupabaseClient }
}

describe('checked provider session revocation', () => {
  it('calls the provider only after the database claim and records success afterward', async () => {
    const { rpc, supabase } = client()
    expect(await revokeUnusedSession(supabase, 'session')).toEqual({ revoked: true })
    expect(rpc.mock.calls).toEqual([
      ['claim_bank_session_revocation', { p_provider: 'enablebanking', p_session_id: 'session' }],
      ['finish_bank_session_revocation', { p_provider: 'enablebanking', p_session_id: 'session', p_claim_token: 'claim-token', p_succeeded: true }],
    ])
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1])
  })

  it.each(['shared', 'in-progress', 'already-revoked'])('does not call the provider when the claim says %s', async reason => {
    const { rpc, supabase } = client({ claimed: false, reason })
    expect(await revokeUnusedSession(supabase, 'session')).toEqual({ revoked: reason === 'already-revoked', reason })
    expect(remove).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('does not call the provider after a database conflict', async () => {
    const { rpc, supabase } = client()
    rpc.mockReset().mockResolvedValue({ data: null, error: { code: 'PT409', message: 'Busy' } })
    await expect(revokeUnusedSession(supabase, 'session')).rejects.toMatchObject({ code: 'PT409' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not call the provider without a valid claim receipt', async () => {
    const { supabase } = client(null)
    await expect(revokeUnusedSession(supabase, 'session')).rejects.toThrow('claim missing')
    expect(remove).not.toHaveBeenCalled()
  })

  it('records failure and preserves the provider error', async () => {
    const { rpc, supabase } = client()
    remove.mockRejectedValue(new Error('Provider unavailable'))
    await expect(revokeUnusedSession(supabase, 'session')).rejects.toThrow('Provider unavailable')
    expect(rpc).toHaveBeenLastCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_succeeded: false }))
  })

  it.each(['error', 'changed'])('does not report success when completion is %s', async failure => {
    const { rpc, supabase } = client()
    rpc.mockResolvedValueOnce({ data: failure === 'changed' ? false : null, error: failure === 'error' ? { message: 'Write unavailable' } : null })
    await expect(revokeUnusedSession(supabase, 'session')).rejects.toThrow(failure === 'changed' ? 'completion changed' : 'Write unavailable')
  })
})
