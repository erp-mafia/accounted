import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  syncAccountTransactions: vi.fn(),
  updateBalancesFromSync: vi.fn(),
  emit: vi.fn(),
}))

vi.mock('../sync', () => ({
  syncAccountTransactions: (...args: unknown[]) => mocks.syncAccountTransactions(...args),
}))
vi.mock('@/lib/cash-accounts/service', () => ({
  updateBalancesFromSync: (...args: unknown[]) => mocks.updateBalancesFromSync(...args),
}))
vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mocks.emit(...args) },
}))

import { SessionExpiredError, REAUTH_REQUIRED_MESSAGE, ConnectorSyncError } from '../api-client'
import { SYNC_COOLDOWN_MS, triggerConnectionSync } from '../trigger-sync'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-09-02T09:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

interface State {
  connection: Record<string, unknown> | null
  membershipRole: string | null
  sieOverlap: boolean
  updates: Record<string, unknown>[]
  /**
   * The durable lease as the database holds it (epoch when never claimed).
   * The conditional UPDATE the runner issues (`sync_lease_until <= now`) is
   * reproduced here: a held lease makes the claim return no row.
   */
  leaseUntil: string
}

const EPOCH = '1970-01-01T00:00:00.000Z'

function makeClient(state: State) {
  return {
    from: (table: string) => {
      let updatePayload: Record<string, unknown> | null = null
      let lteFilter: { column: string; value: string } | null = null
      const chain: Record<string, unknown> = {}
      const passthrough = ['select', 'eq', 'gte', 'order', 'limit', 'in']
      for (const m of passthrough) chain[m] = vi.fn(() => chain)
      chain.lte = vi.fn((column: string, value: string) => {
        lteFilter = { column, value }
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayload = payload
        return chain
      })
      const resolve = () => {
        if (updatePayload && 'sync_lease_until' in updatePayload) {
          // Atomic claim: `.lte('sync_lease_until', <now>)`.
          if (lteFilter?.column !== 'sync_lease_until') {
            throw new Error('lease claim must carry the conditional filter')
          }
          if (state.leaseUntil > lteFilter.value) return { data: [], error: null }
          state.leaseUntil = updatePayload.sync_lease_until as string
          state.updates.push(updatePayload)
          return { data: [{ id: CONNECTION_ID }], error: null }
        }
        if (updatePayload) {
          state.updates.push(updatePayload)
          return { data: null, error: null }
        }
        if (table === 'bank_connections') return { data: state.connection, error: null }
        if (table === 'company_members')
          return { data: state.membershipRole ? { role: state.membershipRole } : null, error: null }
        if (table === 'sie_imports') return { data: state.sieOverlap ? { id: 'sie-1' } : null, error: null }
        if (table === 'transactions') return { data: [{ id: 'tx-1' }], error: null }
        return { data: null, error: null }
      }
      chain.maybeSingle = vi.fn(() => Promise.resolve(resolve()))
      chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onFulfilled)
      return chain
    },
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    company_id: COMPANY_ID,
    bank_name: 'Swedbank',
    status: 'active',
    accounts_data: [
      { uid: 'acc-1', currency: 'SEK', enabled: true, balance: 100 },
      { uid: 'acc-2', currency: 'SEK', enabled: false, balance: 5 },
    ],
    last_synced_at: new Date(NOW - 2 * DAY_MS).toISOString(),
    error_message: null,
    sync_lease_until: EPOCH,
    ...overrides,
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let state: State

function run(now = NOW) {
  return triggerConnectionSync(makeClient(state) as never, {
    companyId: COMPANY_ID,
    userId: 'user-1',
    connectionId: CONNECTION_ID,
    log,
    now,
  })
}

describe('triggerConnectionSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state = {
      connection: connection(),
      membershipRole: 'owner',
      sieOverlap: false,
      updates: [],
      leaseUntil: EPOCH,
    }
    mocks.syncAccountTransactions.mockResolvedValue({ imported: 2, duplicates: 5, errors: 0 })
    mocks.updateBalancesFromSync.mockResolvedValue(undefined)
    mocks.emit.mockResolvedValue(undefined)
  })

  it('syncs only the enabled accounts over the gap-aware window and stamps last_synced_at', async () => {
    const result = await run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ connection_id: CONNECTION_ID, bank: 'Swedbank', imported: 2, duplicates: 5 })
    // Synced 2 days ago: the 7-day floor applies.
    expect(result.from_date).toBe(new Date(NOW - 7 * DAY_MS).toISOString().split('T')[0])
    expect(result.to_date).toBe('2026-09-02')
    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.syncAccountTransactions.mock.calls[0][4]).toMatchObject({ uid: 'acc-1' })
    expect(state.updates.at(-1)).toMatchObject({ last_synced_at: result.last_synced_at })
    // Write-back keeps the disabled account so the user's selection survives.
    expect((state.updates.at(-1)!.accounts_data as unknown[]).length).toBe(2)
    expect(mocks.updateBalancesFromSync).toHaveBeenCalledTimes(1)
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
  })

  it('widens the window to cover a longer gap and asks for the deepest history past a month', async () => {
    state.connection = connection({ last_synced_at: new Date(NOW - 40 * DAY_MS).toISOString() })
    const result = await run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.from_date).toBe(new Date(NOW - 41 * DAY_MS).toISOString().split('T')[0])
    expect(mocks.syncAccountTransactions.mock.calls[0][8]).toMatchObject({ strategy: 'longest' })
  })

  it('refuses with a cooldown when the connection synced within 15 minutes', async () => {
    const syncedAt = NOW - 5 * 60 * 1000
    state.connection = connection({ last_synced_at: new Date(syncedAt).toISOString() })
    const result = await run()
    expect(result).toMatchObject({
      ok: false,
      code: 'BANK_SYNC_COOLDOWN',
      next_allowed_at: new Date(syncedAt + SYNC_COOLDOWN_MS).toISOString(),
      retry_after_seconds: 600,
    })
    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
  })

  it('claims the durable lease before calling the bank', async () => {
    await run()
    expect(state.leaseUntil).toBe(new Date(NOW + SYNC_COOLDOWN_MS).toISOString())
    // The claim is issued before syncAccountTransactions: the lease row
    // update is the first write recorded.
    expect(state.updates[0]).toEqual({ sync_lease_until: state.leaseUntil })
  })

  it('throttles a failing connection by the lease, not only by last_synced_at', async () => {
    mocks.syncAccountTransactions.mockRejectedValue(new Error('ASPSP 500'))
    const first = await run()
    expect(first).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
    // A second instance re-reads the row: the lease is now held.
    state.connection = connection({ sync_lease_until: state.leaseUntil })
    const second = await run(NOW + 60 * 1000)
    expect(second).toMatchObject({
      ok: false,
      code: 'BANK_SYNC_COOLDOWN',
      next_allowed_at: state.leaseUntil,
      retry_after_seconds: 14 * 60,
    })
    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
  })

  it('loses the race to a concurrent claimer and never calls the bank', async () => {
    // Our read saw no lease; between the read and the claim another
    // serverless instance took it. The conditional UPDATE returns no row.
    state.leaseUntil = new Date(NOW + SYNC_COOLDOWN_MS - 1000).toISOString()
    const result = await run()
    expect(result).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN' })
    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    expect(mocks.updateBalancesFromSync).not.toHaveBeenCalled()
  })

  it('accepts a sync once a previous lease has expired', async () => {
    state.leaseUntil = new Date(NOW - 1000).toISOString()
    state.connection = connection({ sync_lease_until: state.leaseUntil })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(state.leaseUntil).toBe(new Date(NOW + SYNC_COOLDOWN_MS).toISOString())
  })

  it('answers NOT_FOUND for a connection outside the company or a non-uuid id', async () => {
    state.connection = null
    expect(await run()).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const bogus = await triggerConnectionSync(makeClient(state) as never, {
      companyId: COMPANY_ID,
      userId: 'user-1',
      connectionId: 'not-a-uuid',
      log,
      now: NOW,
    })
    expect(bogus).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('answers NOT_FOUND when the caller is not a member of the company, before any lease or bank call', async () => {
    state.membershipRole = null
    expect(await run()).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(state.leaseUntil).toBe(EPOCH)
    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
  })

  it('refuses an expired or pending connection: only BankID can fix those', async () => {
    state.connection = connection({ status: 'expired' })
    expect(await run()).toMatchObject({ ok: false, code: 'BANK_SYNC_NOT_ACTIVE', status: 'expired' })
    state.connection = connection({ status: 'pending_selection' })
    expect(await run()).toMatchObject({ ok: false, code: 'BANK_SYNC_NOT_ACTIVE' })
    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
  })

  it('retries an errored connection and recovers it to active on success', async () => {
    state.connection = connection({ status: 'error', error_message: 'Banksynkningen misslyckades.' })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(state.updates.at(-1)).toMatchObject({ status: 'active', error_message: null })
  })

  it('refuses when every account is deselected', async () => {
    state.connection = connection({ accounts_data: [{ uid: 'acc-1', enabled: false }] })
    expect(await run()).toMatchObject({ ok: false, code: 'BANK_SYNC_NO_ACCOUNTS' })
  })

  it('answers retryable and leaves the row alone when the connector hop fails', async () => {
    state.connection = connection({ status: 'error', error_message: 'old' })
    mocks.syncAccountTransactions.mockRejectedValue(new ConnectorSyncError(null, 'CONNECTOR_TIMEOUT', 'aborted'))
    const result = await run()
    expect(result).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED', status: 'error' })
    expect(state.updates.some((u) => 'status' in u || 'error_message' in u)).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      'agent-triggered bank sync: connector hop failed',
      expect.objectContaining({ code: 'CONNECTOR_TIMEOUT' }),
    )
  })

  it('flips the connection to expired when the bank reports the session dead', async () => {
    mocks.syncAccountTransactions.mockRejectedValue(new SessionExpiredError(401, 'consent closed'))
    const result = await run()
    expect(result).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    expect(state.updates.at(-1)).toMatchObject({ status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE })
  })

  it('suppresses auto-categorisation over a completed SIE import and for viewers', async () => {
    state.sieOverlap = true
    state.membershipRole = 'viewer'
    await run()
    expect(mocks.syncAccountTransactions.mock.calls[0][8]).toMatchObject({
      skipAutoCategorization: true,
      rawInsertOnly: true,
    })
  })
})
