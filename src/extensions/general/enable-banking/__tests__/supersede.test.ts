import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockDeleteSession, mockCountLiveSiblings } = vi.hoisted(() => ({
  mockDeleteSession: vi.fn(),
  mockCountLiveSiblings: vi.fn(),
}))

vi.mock('../lib/api-client', () => ({
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
}))
vi.mock('../lib/session-sharing', () => ({
  countLiveSiblings: (...args: unknown[]) => mockCountLiveSiblings(...args),
}))

import { supersedeSiblingConnections } from '../lib/supersede'
import { eventBus } from '@/lib/events/bus'
import type { StoredAccount } from '../types'

interface RecordedCall {
  method: string
  args: unknown[]
}

interface RecordedChain {
  _calls: RecordedCall[]
  [key: string]: unknown
}

function makeChain(result: { data?: unknown; error?: unknown } = {}): RecordedChain {
  const calls: RecordedCall[] = []
  const chain: Record<string, unknown> = { _calls: calls }
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'update', 'delete']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    })
  }
  chain.single = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain as RecordedChain
}

interface ScriptStep {
  table: string
  chain: RecordedChain
}

/** from() dispatcher that asserts the table order and hands out scripted chains. */
function makeSupabase(script: ScriptStep[]): { client: SupabaseClient; from: ReturnType<typeof vi.fn> } {
  let i = 0
  const from = vi.fn((table: string) => {
    const step = script[i]
    i++
    expect(step, `unexpected from('${table}') call #${i}`).toBeDefined()
    expect(table).toBe(step.table)
    return step.chain
  })
  return { client: { from } as unknown as SupabaseClient, from }
}

function updatePayload(chain: RecordedChain): Record<string, unknown> {
  const call = chain._calls.find((c) => c.method === 'update')
  expect(call, 'expected an update on this chain').toBeDefined()
  return call!.args[0] as Record<string, unknown>
}

const BASE_INPUT = {
  companyId: 'company-1',
  userId: 'user-1',
  newConnectionId: 'new-1',
  bankName: 'TestBank',
  newSessionId: 'sess-new',
}

function makeSibling(overrides: Record<string, unknown> = {}) {
  return {
    id: 'old-1',
    status: 'expired',
    session_id: 'sess-old',
    accounts_data: [
      {
        uid: 'uid-old',
        iban: 'SE45 5000 0000 0583 9825 7466',
        currency: 'SEK',
        dedup_scope: 'legacy-scope',
      },
    ] as StoredAccount[],
    last_synced_at: '2026-08-01T00:00:00Z',
    initial_sync_completed_at: '2026-06-01T00:00:00Z',
    initial_sync_requested_from: '2026-01-01',
    initial_sync_returned_min_date: '2026-01-02',
    initial_sync_returned_max_date: '2026-07-31',
    initial_sync_lookback_days: 365,
    ...overrides,
  }
}

const NEW_ACCOUNTS: StoredAccount[] = [
  { uid: 'uid-new', iban: 'SE4550000000058398257466', currency: 'SEK' },
]

describe('supersedeSiblingConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockCountLiveSiblings.mockResolvedValue(0)
    mockDeleteSession.mockResolvedValue(undefined)
  })

  it('supersedes an IBAN-overlapping sibling: revoked + superseded_by, transactions re-pointed, claims released', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const siblingSelect = makeChain({ data: [makeSibling()] })
    const revokeUpdate = makeChain({})
    const txSelect = makeChain({ data: [{ id: 't1' }, { id: 't2' }] })
    const txUpdate = makeChain({})
    const cashDemote = makeChain({})
    const newRowSelect = makeChain({ data: { last_synced_at: null, initial_sync_completed_at: null } })
    const carryUpdate = makeChain({})

    const { client } = makeSupabase([
      { table: 'bank_connections', chain: siblingSelect },
      { table: 'bank_connections', chain: revokeUpdate },
      { table: 'transactions', chain: txSelect },
      { table: 'transactions', chain: txUpdate },
      { table: 'cash_accounts', chain: cashDemote },
      { table: 'bank_connections', chain: newRowSelect },
      { table: 'bank_connections', chain: carryUpdate },
    ])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: NEW_ACCOUNTS,
    })

    expect(result.supersededIds).toEqual(['old-1'])
    // The explicit dedup scope travels, keyed by normalized IBAN.
    expect(result.dedupScopeByIban.get('SE4550000000058398257466')).toBe('legacy-scope')

    // The dead consent is revoked at EB (nobody else shares it).
    expect(mockDeleteSession).toHaveBeenCalledWith('sess-old')

    // The row is parked, not deleted: revoked + superseded_by disambiguates
    // a supersede from a user disconnect.
    const parked = updatePayload(revokeUpdate)
    expect(parked.status).toBe('revoked')
    expect(parked.session_id).toBeNull()
    expect(parked.superseded_by).toBe('new-1')
    expect(typeof parked.superseded_at).toBe('string')

    // Feed rows follow the survivor, batch-scoped by the selected ids.
    expect(updatePayload(txUpdate)).toEqual({ bank_connection_id: 'new-1' })
    const inCall = txUpdate._calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['id', ['t1', 't2']])

    // Leftover ledger claims are demoted to manual, mirroring /disconnect.
    expect(updatePayload(cashDemote)).toEqual({ bank_connection_id: null })

    // Sync state is carried onto the survivor so neither the cron's
    // first-sync backfill nor the picker treats the renewal as a first connect.
    const carried = updatePayload(carryUpdate)
    expect(carried.last_synced_at).toBe('2026-08-01T00:00:00Z')
    expect(carried.initial_sync_completed_at).toBe('2026-06-01T00:00:00Z')
    expect(carried.initial_sync_requested_from).toBe('2026-01-01')
    expect(carried.initial_sync_lookback_days).toBe(365)

    expect(emitSpy).toHaveBeenCalledWith({
      type: 'bank_connection.superseded',
      payload: {
        connectionId: 'old-1',
        supersededById: 'new-1',
        bankName: 'TestBank',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('parks the sibling row BEFORE revoking its session at Enable Banking', async () => {
    // Revoking first and then failing to park would leave a live-looking row
    // whose session is already dead at the bank: the park update must come
    // first, in call order.
    const sequence: string[] = []
    mockDeleteSession.mockImplementation(async () => {
      sequence.push('deleteSession')
    })

    const siblingSelect = makeChain({ data: [makeSibling()] })
    const revokeUpdate = makeChain({})
    const originalUpdate = revokeUpdate.update as ReturnType<typeof vi.fn>
    revokeUpdate.update = vi.fn((...args: unknown[]) => {
      sequence.push('parkUpdate')
      return originalUpdate(...args)
    })
    const txSelect = makeChain({ data: [] })
    const cashDemote = makeChain({})
    const newRowSelect = makeChain({ data: { last_synced_at: null, initial_sync_completed_at: null } })
    const carryUpdate = makeChain({})

    const { client } = makeSupabase([
      { table: 'bank_connections', chain: siblingSelect },
      { table: 'bank_connections', chain: revokeUpdate },
      { table: 'transactions', chain: txSelect },
      { table: 'cash_accounts', chain: cashDemote },
      { table: 'bank_connections', chain: newRowSelect },
      { table: 'bank_connections', chain: carryUpdate },
    ])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: NEW_ACCOUNTS,
    })

    expect(result.supersededIds).toEqual(['old-1'])
    expect(sequence).toEqual(['parkUpdate', 'deleteSession'])
  })

  it('skips the EB session revoke entirely when the park update fails', async () => {
    const siblingSelect = makeChain({ data: [makeSibling()] })
    const failedPark = makeChain({ error: { message: 'update refused' } })

    // Only the lookup and the failed park run: no revoke, no re-point, no
    // demote, no sync-state carry.
    const { client, from } = makeSupabase([
      { table: 'bank_connections', chain: siblingSelect },
      { table: 'bank_connections', chain: failedPark },
    ])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: NEW_ACCOUNTS,
    })

    expect(result.supersededIds).toEqual([])
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(from).toHaveBeenCalledTimes(2)
  })

  it('never supersedes an ACTIVE sibling without IBAN overlap (separate login at the same bank)', async () => {
    const siblingSelect = makeChain({
      data: [
        makeSibling({
          id: 'other-login',
          status: 'active',
          accounts_data: [{ uid: 'uid-x', iban: 'SE9999999999999999999999', currency: 'SEK' }],
        }),
      ],
    })
    const { client, from } = makeSupabase([{ table: 'bank_connections', chain: siblingSelect }])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: NEW_ACCOUNTS,
    })

    expect(result.supersededIds).toEqual([])
    // Only the sibling lookup ran: nothing was updated, revoked, or re-pointed.
    expect(from).toHaveBeenCalledTimes(1)
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('parks the row but keeps the EB session when other connections still share it', async () => {
    mockCountLiveSiblings.mockResolvedValue(2)

    const siblingSelect = makeChain({ data: [makeSibling()] })
    const revokeUpdate = makeChain({})
    const txSelect = makeChain({ data: [] })
    const cashDemote = makeChain({})
    const newRowSelect = makeChain({ data: { last_synced_at: null, initial_sync_completed_at: null } })
    const carryUpdate = makeChain({})

    const { client } = makeSupabase([
      { table: 'bank_connections', chain: siblingSelect },
      { table: 'bank_connections', chain: revokeUpdate },
      { table: 'transactions', chain: txSelect },
      { table: 'cash_accounts', chain: cashDemote },
      { table: 'bank_connections', chain: newRowSelect },
      { table: 'bank_connections', chain: carryUpdate },
    ])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: NEW_ACCOUNTS,
    })

    expect(result.supersededIds).toEqual(['old-1'])
    // A shared consent is never revoked upstream; the row is still parked.
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(updatePayload(revokeUpdate).status).toBe('revoked')
  })

  it('matches a DEAD sibling on bank identity alone only when neither side has IBANs', async () => {
    const siblingSelect = makeChain({
      data: [
        makeSibling({
          session_id: null,
          accounts_data: [{ uid: 'uid-old', currency: 'SEK' }],
          initial_sync_completed_at: null,
          last_synced_at: null,
        }),
      ],
    })
    const revokeUpdate = makeChain({})
    const txSelect = makeChain({ data: [] })
    const cashDemote = makeChain({})
    const newRowSelect = makeChain({ data: { last_synced_at: null, initial_sync_completed_at: null } })

    const { client } = makeSupabase([
      { table: 'bank_connections', chain: siblingSelect },
      { table: 'bank_connections', chain: revokeUpdate },
      { table: 'transactions', chain: txSelect },
      { table: 'cash_accounts', chain: cashDemote },
      { table: 'bank_connections', chain: newRowSelect },
    ])

    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      newAccounts: [{ uid: 'uid-new', currency: 'SEK' }],
    })

    expect(result.supersededIds).toEqual(['old-1'])
    expect(updatePayload(revokeUpdate).superseded_by).toBe('new-1')
  })

  it('does nothing without a bank name', async () => {
    const { client, from } = makeSupabase([])
    const result = await supersedeSiblingConnections(client, {
      ...BASE_INPUT,
      bankName: null,
      newAccounts: NEW_ACCOUNTS,
    })
    expect(result.supersededIds).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})
