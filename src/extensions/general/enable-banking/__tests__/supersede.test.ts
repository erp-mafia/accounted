import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockDeleteSession } = vi.hoisted(() => ({ mockDeleteSession: vi.fn() }))
vi.mock('../lib/api-client', () => ({ deleteSession: (...args: unknown[]) => mockDeleteSession(...args) }))
import { supersedeSiblingConnections } from '../lib/supersede'
import { eventBus } from '@/lib/events/bus'

const accounts = [{ uid: 'new-uid', iban: 'SE1234', currency: 'SEK', dedup_scope: 'legacy-scope' }]
const input = { companyId: 'company-1', userId: 'user-1', newConnectionId: 'new-1',
  bankName: 'Test bank', newSessionId: 'new-session', newAccounts: accounts, preserveDedupScopeUids: ['new-uid'] }
function setup(options: { error?: object; readError?: object; shared?: boolean; noSiblings?: boolean; missing?: boolean } = {}) {
  const calls: string[] = []
  const rpc = vi.fn(async (name: string) => {
    calls.push(name)
    if (name === 'read_bank_configuration') return { data: { token: 'snapshot-token', connection: {
      id: 'new-1', bank_name: 'Test bank', status: 'pending_selection', session_id: 'new-session', accounts_data: accounts,
    } }, error: options.readError ?? null }
    if (name === 'supersede_bank_connections') return { data: options.missing ? null : {
      accounts, superseded: options.noSiblings ? [] : [{ id: 'old-1', session_id: 'old-session' }, { id: 'old-2', session_id: 'old-session' }],
    }, error: options.error ?? null }
    if (name === 'claim_bank_session_revocation') return { data: options.shared ? { claimed: false, reason: 'shared' } : { claimed: true, token: 'claim-token' }, error: null }
    if (name === 'finish_bank_session_revocation') return { data: true, error: null }
    throw new Error(`Unexpected RPC ${name}`)
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc, calls }
}
beforeEach(() => { vi.clearAllMocks(); eventBus.clear(); mockDeleteSession.mockResolvedValue(undefined) })

describe('checked atomic sibling supersession', () => {
  it('commits the complete transition before one guarded revoke per released consent and returns committed accounts', async () => {
    const { client, rpc, calls } = setup()
    const emit = vi.spyOn(eventBus, 'emit')
    mockDeleteSession.mockImplementation(async () => { calls.push('provider') })
    const result = await supersedeSiblingConnections(client, input)
    expect(result).toEqual({ supersededIds: ['old-1','old-2'], accounts })
    expect(rpc).toHaveBeenNthCalledWith(2, 'supersede_bank_connections', {
      p_company_id: 'company-1', p_user_id: 'user-1', p_connection_id: 'new-1', p_expected_token: 'snapshot-token',
      p_expected_session_id: 'new-session', p_preserve_scope_uids: ['new-uid'],
    })
    expect(mockDeleteSession).toHaveBeenCalledExactlyOnceWith('old-session')
    expect(calls).toEqual(['read_bank_configuration','supersede_bank_connections',
      'claim_bank_session_revocation','provider','finish_bank_session_revocation'])
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith({ type: 'bank_connection.superseded', payload: {
      connectionId: 'old-1', supersededById: 'new-1', bankName: 'Test bank', userId: 'user-1', companyId: 'company-1',
    } })
  })

  it.each([
    ['stale topology', { code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' }],
    ['late database failure', { code: 'XX000', message: 'carry failed' }],
    ['actor denial', { code: '42501', message: 'BANK_SUPERSEDE_ACTOR_DENIED' }],
  ])('propagates %s without provider work or events', async (_label, error) => {
    const { client, calls } = setup({ error }); const emit = vi.spyOn(eventBus, 'emit')
    await expect(supersedeSiblingConnections(client, input)).rejects.toMatchObject(error)
    expect(calls).toEqual(['read_bank_configuration','supersede_bank_connections'])
    expect(mockDeleteSession).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled()
  })

  it('propagates a failed snapshot read', async () => {
    const { client, rpc } = setup({ readError: { code: 'XX000', message: 'read failed' } })
    await expect(supersedeSiblingConnections(client, input)).rejects.toMatchObject({ code: 'XX000' })
    expect(rpc).toHaveBeenCalledOnce(); expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('does not treat a missing receipt as committed success', async () => {
    const { client } = setup({ missing: true })
    await expect(supersedeSiblingConnections(client, input)).rejects.toThrow('receipt missing')
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('retains a consent still held in another company', async () => {
    const { client } = setup({ shared: true })
    expect((await supersedeSiblingConnections(client, input)).supersededIds).toHaveLength(2)
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('keeps the committed receipt if upstream revocation fails', async () => {
    const { client, rpc } = setup(); mockDeleteSession.mockRejectedValue(new Error('provider unavailable'))
    expect((await supersedeSiblingConnections(client, input)).supersededIds).toHaveLength(2)
    expect(rpc).toHaveBeenLastCalledWith('finish_bank_session_revocation', {
      p_provider: 'enablebanking', p_session_id: 'old-session', p_claim_token: 'claim-token', p_succeeded: false,
    })
  })

  it('does no upstream work for an idempotent repeat', async () => {
    const { client, calls } = setup({ noSiblings: true })
    expect(await supersedeSiblingConnections(client, input)).toEqual({ supersededIds: [], accounts })
    expect(calls).toEqual(['read_bank_configuration','supersede_bank_connections'])
  })
})
