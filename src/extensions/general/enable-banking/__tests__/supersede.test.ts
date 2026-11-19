import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockDeleteSession } = vi.hoisted(() => ({ mockDeleteSession: vi.fn() }))
vi.mock('../lib/api-client', () => ({ deleteSession: (...args: unknown[]) => mockDeleteSession(...args) }))
import { finishBankSupersession } from '../lib/supersede'
import { eventBus } from '@/lib/events/bus'

const input = { companyId: 'company-1', userId: 'user-1', newConnectionId: 'new-1',
  bankName: 'Test bank', newSessionId: 'new-session' }
const superseded = [{ id: 'old-1', session_id: 'old-session' }, { id: 'old-2', session_id: 'old-session' }]
function setup(options: { shared?: boolean } = {}) {
  const calls: string[] = []
  const rpc = vi.fn(async (name: string) => {
    calls.push(name)
    if (name === 'claim_bank_session_revocation') return { data: options.shared ? { claimed: false, reason: 'shared' } : { claimed: true, token: 'claim-token' }, error: null }
    if (name === 'finish_bank_session_revocation') return { data: true, error: null }
    throw new Error(`Unexpected RPC ${name}`)
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc, calls }
}
beforeEach(() => { vi.clearAllMocks(); eventBus.clear(); mockDeleteSession.mockResolvedValue(undefined) })

describe('finishBankSupersession', () => {
  it('revokes each released consent once behind its claim and emits one event per superseded sibling', async () => {
    const { client, calls } = setup()
    const emit = vi.spyOn(eventBus, 'emit')
    mockDeleteSession.mockImplementation(async () => { calls.push('provider') })
    await finishBankSupersession(client, input, superseded)
    expect(mockDeleteSession).toHaveBeenCalledExactlyOnceWith('old-session')
    expect(calls).toEqual(['claim_bank_session_revocation','provider','finish_bank_session_revocation'])
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith({ type: 'bank_connection.superseded', payload: {
      connectionId: 'old-1', supersededById: 'new-1', bankName: 'Test bank', userId: 'user-1', companyId: 'company-1',
    } })
  })

  it('never revokes the session the new connection uses', async () => {
    const { client, rpc } = setup()
    await finishBankSupersession(client, input, [{ id: 'old-1', session_id: 'new-session' }, { id: 'old-2', session_id: null }])
    expect(rpc).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('retains a consent still held in another company', async () => {
    const { client } = setup({ shared: true })
    await finishBankSupersession(client, input, superseded)
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('records a failed upstream revocation and still emits the events', async () => {
    const { client, rpc } = setup(); mockDeleteSession.mockRejectedValue(new Error('provider unavailable'))
    const emit = vi.spyOn(eventBus, 'emit')
    await finishBankSupersession(client, input, superseded)
    expect(rpc).toHaveBeenLastCalledWith('finish_bank_session_revocation', {
      p_provider: 'enablebanking', p_session_id: 'old-session', p_claim_token: 'claim-token', p_succeeded: false,
    })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('does no upstream work and emits nothing when nothing was superseded', async () => {
    const { client, calls } = setup()
    const emit = vi.spyOn(eventBus, 'emit')
    await finishBankSupersession(client, input, [])
    expect(calls).toEqual([])
    expect(emit).not.toHaveBeenCalled()
  })
})
