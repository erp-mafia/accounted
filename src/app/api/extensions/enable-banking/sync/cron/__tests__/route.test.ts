import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Covers the hourly bank sync cron: which connections a run takes (due,
 * entitled, lease free), how it fans out, and what it leaves for the next run.
 * The session health probe has its own route and tests (../../health-probe).
 */

const EPOCH = '1970-01-01T00:00:00.000Z'

interface ClientState {
  /** bank_connections as the database holds them: writes land on these rows. */
  active: Record<string, unknown>[]
  /** Non-lease updates, in order. */
  updates: { ids: unknown[]; payload: Record<string, unknown> }[]
  /** Lease writes (claims and holds) and the rows each one landed on. */
  leaseWrites: { ids: unknown[]; until: string }[]
  /** Connections whose claim loses the race although the plan saw the lease free. */
  claimLosers: Set<string>
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  syncAccountTransactions: vi.fn(),
  getCompanyIdsWithCapability: vi.fn(),
  runReconciliation: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/extensions/general/enable-banking/lib/sync', () => ({
  syncAccountTransactions: (...args: unknown[]) => mocks.syncAccountTransactions(...args),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) => mocks.getCompanyIdsWithCapability(...args),
}))

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  runReconciliation: (...args: unknown[]) => mocks.runReconciliation(...args),
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD: 0.9,
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => false, sendEmail: vi.fn() }),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

import {
  REAUTH_REQUIRED_MESSAGE,
  SessionExpiredError,
  AspspUnavailableError,
  ConnectorSyncError,
} from '@/extensions/general/enable-banking/lib/api-client'
import { GET } from '../route'

function makeClient(state: ClientState) {
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const row = state.active.find(row => row.id === args.p_connection_id && row.company_id === args.p_company_id)
      if (!row) throw new Error('Unknown sync fixture connection')
      const payload = name === 'persist_bank_sync_result'
        ? { last_synced_at: args.p_completed_at, status: 'active', error_message: null }
        : { status: args.p_status, error_message: args.p_message }
      Object.assign(row, payload)
      state.updates.push({ ids: [row.id], payload })
      return { data: name === 'persist_bank_sync_result' ? { applied: true } : true, error: null }
    }),
    from: () => {
      const filters: Record<string, unknown> = {}
      let isDelete = false
      let updatePayload: Record<string, unknown> | null = null
      let leaseBound: { op: 'lte' | 'lt'; value: string } | null = null

      function result() {
        if (isDelete) return { data: [], error: null }
        if (updatePayload) {
          const targets = state.active.filter(row =>
            filters.session_id ? row.session_id === filters.session_id : row.id === filters.id,
          )
          if (Object.keys(updatePayload).join() === 'sync_lease_until') {
            // The conditional lease write of lib/sync-lease.ts, reproduced:
            // claim = `<= now`, hold = `< until`.
            if (!leaseBound) throw new Error('lease write must carry its conditional filter')
            const bound = leaseBound
            const hit = targets.filter(row => {
              if (bound.op === 'lte' && state.claimLosers.has(row.id as string)) return false
              const current = (row.sync_lease_until as string | undefined) ?? EPOCH
              return bound.op === 'lte' ? current <= bound.value : current < bound.value
            })
            for (const row of hit) Object.assign(row, updatePayload)
            state.leaseWrites.push({
              ids: hit.map(row => row.id),
              until: updatePayload.sync_lease_until as string,
            })
            return { data: hit.map(row => ({ id: row.id })), error: null }
          }
          for (const row of targets) Object.assign(row, updatePayload)
          state.updates.push({ ids: [filters.id], payload: updatePayload })
          return { data: null, error: null }
        }
        if (filters.status === 'active') {
          return { data: state.active.filter(row => row.status === 'active'), error: null }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {}
      const passthrough = ['select', 'not', 'gte', 'order', 'limit', 'range']
      for (const method of passthrough) chain[method] = vi.fn(() => chain)
      chain.eq = vi.fn((col: string, value: unknown) => {
        filters[col] = value
        return chain
      })
      chain.lte = vi.fn((col: string, value: string) => {
        if (col === 'sync_lease_until') leaseBound = { op: 'lte', value }
        return chain
      })
      chain.lt = vi.fn((col: string, value: string) => {
        if (col === 'sync_lease_until') leaseBound = { op: 'lt', value }
        return chain
      })
      chain.delete = vi.fn(() => {
        isDelete = true
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayload = payload
        return chain
      })
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      chain.then = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled)
      return chain
    },
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: null } }) } },
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    bank_name: 'TestBank',
    session_id: 'sess-1',
    status: 'active',
    consent_expires: '2099-01-01T00:00:00Z',
    accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
    initial_sync_completed_at: '2026-01-01T00:00:00Z',
    last_synced_at: null,
    sync_lease_until: EPOCH,
    last_expiry_notification_at: null,
    error_message: null,
    ...overrides,
  }
}

let state: ClientState

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  state = { active: [], updates: [], leaseWrites: [], claimLosers: new Set() }
  mocks.createClient.mockImplementation(() => makeClient(state))
  mocks.getCompanyIdsWithCapability.mockImplementation(
    async (_supabase: unknown, companyIds: string[]) => new Set(companyIds),
  )
  mocks.syncAccountTransactions.mockResolvedValue({ imported: 0, duplicates: 0, errors: 0 })
})

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey
})

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/extensions/enable-banking/sync/cron')
}

const HOUR_MS = 60 * 60 * 1000
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString()
const companyId = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
/** One connection per company, so nothing serializes unless a test wants it to. */
const fleet = (count: number, overrides: Record<string, unknown> = {}) =>
  Array.from({ length: count }, (_, index) =>
    connection({ id: `conn-${String(index).padStart(4, '0')}`, company_id: companyId(index), ...overrides }),
  )

/** A sync mock whose calls the test resolves by hand. */
function manualSyncs() {
  const started: string[] = []
  const resolvers = new Map<string, () => void>()
  mocks.syncAccountTransactions.mockImplementation((...args: unknown[]) => {
    const id = args[3] as string
    started.push(id)
    return new Promise(resolve => {
      resolvers.set(id, () => resolve({ imported: 0, duplicates: 0, errors: 0 }))
    })
  })
  const finish = (id: string) => {
    resolvers.get(id)?.()
    resolvers.delete(id)
  }
  return { started, finish, finishAll: () => [...resolvers.keys()].forEach(finish) }
}

describe('GET /api/extensions/enable-banking/sync/cron: which connections a run takes', () => {
  it('skips a connection synced within the day and takes an overdue one', async () => {
    state.active = [
      connection({ id: 'fresh', company_id: companyId(1), last_synced_at: hoursAgo(2) }),
      connection({ id: 'overdue', company_id: companyId(2), last_synced_at: hoursAgo(30) }),
    ]

    const response = await GET(cronRequest())

    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.syncAccountTransactions.mock.calls[0][3]).toBe('overdue')
    await expect(response.json()).resolves.toMatchObject({
      eligible: 2,
      fresh: 1,
      due: 1,
      completed: 1,
      oldestOverdueHours: 7,
    })
  })

  it('selects an entitled connection after fifty ineligible queue rows', async () => {
    state.active = [
      ...Array.from({ length: 50 }, (_, index) => connection({
        id: `free-${index}`,
        company_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
      connection({ id: 'paid-connection', company_id: '11111111-1111-4111-8111-111111111111' }),
    ]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(
      new Set(['11111111-1111-4111-8111-111111111111']),
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(200)
    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.syncAccountTransactions.mock.calls[0][3]).toBe('paid-connection')
    await expect(response.json()).resolves.toMatchObject({ processed: 1, notEntitled: 50, eligible: 1 })
  })

  it('works through more than one batch of due connections over successive runs', async () => {
    state.active = fleet(650)

    const first = await (await GET(cronRequest())).json()
    expect(first).toMatchObject({ due: 650, selected: 300, completed: 300, deferredByBatchLimit: 350 })

    const second = await (await GET(cronRequest())).json()
    expect(second).toMatchObject({ due: 350, selected: 300, deferredByBatchLimit: 50 })

    const third = await (await GET(cronRequest())).json()
    expect(third).toMatchObject({ due: 50, selected: 50, deferredByBatchLimit: 0 })

    const fourth = await (await GET(cronRequest())).json()
    expect(fourth).toMatchObject({ due: 0, fresh: 650, processed: 0 })

    // Every connection exactly once: a finished sync is fresh for the next run.
    const synced = mocks.syncAccountTransactions.mock.calls.map(call => call[3])
    expect(synced).toHaveLength(650)
    expect(new Set(synced).size).toBe(650)
  })

  it('leaves a connection with every account deselected out of the work list', async () => {
    // It can never record a sync, so it would sit first in the queue forever.
    state.active = [connection({ accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: false }] })]

    const response = await GET(cronRequest())

    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ noAccounts: 1, due: 0 })
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: worker pool', () => {
  it('keeps four companies in flight and replaces each one the moment it finishes', async () => {
    const syncs = manualSyncs()
    state.active = fleet(6)

    const responsePromise = GET(cronRequest())

    await vi.waitFor(() => expect(syncs.started).toHaveLength(4))
    // One finishes: exactly one more starts. The old waves waited for all four.
    syncs.finish(syncs.started[1])
    await vi.waitFor(() => expect(syncs.started).toHaveLength(5))
    syncs.finishAll()
    await vi.waitFor(() => expect(syncs.started).toHaveLength(6))
    syncs.finishAll()

    await expect((await responsePromise).json()).resolves.toMatchObject({ processed: 6 })
  })

  it('does not let one slow company hold the others back', async () => {
    const syncs = manualSyncs()
    state.active = fleet(12)

    const responsePromise = GET(cronRequest())

    await vi.waitFor(() => expect(syncs.started).toHaveLength(4))
    const slow = syncs.started[0]
    // Everything but the slow one drains through the three remaining workers.
    while (syncs.started.length < 12) {
      const before = syncs.started.length
      syncs.started.filter(id => id !== slow).forEach(syncs.finish)
      await vi.waitFor(() => expect(syncs.started.length).toBeGreaterThan(before))
    }
    syncs.started.filter(id => id !== slow).forEach(syncs.finish)
    syncs.finish(slow)

    await expect((await responsePromise).json()).resolves.toMatchObject({ processed: 12 })
  })

  it('never syncs two connections of the same company concurrently', async () => {
    // The post-sync unattended sweep is company-scoped: two concurrent sweeps
    // for one company can both read a journal entry as unlinked and claim it
    // for different bank transactions. Same-company connections must serialize.
    const syncs = manualSyncs()
    state.active = [
      connection({ id: 'same-a', company_id: 'company-shared' }),
      connection({ id: 'same-b', company_id: 'company-shared' }),
      connection({ id: 'other', company_id: 'company-other' }),
    ]

    const responsePromise = GET(cronRequest())

    await vi.waitFor(() => expect(syncs.started).toContain('other'))
    expect(syncs.started).toEqual(expect.arrayContaining(['same-a', 'other']))
    syncs.finish('other')
    // A free worker is not enough: same-b waits for same-a.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(syncs.started).not.toContain('same-b')
    syncs.finish('same-a')
    await vi.waitFor(() => expect(syncs.started).toContain('same-b'))
    syncs.finish('same-b')

    await expect((await responsePromise).json()).resolves.toMatchObject({ processed: 3 })
  })

  it('isolates one failing connection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.syncAccountTransactions.mockImplementation((...args: unknown[]) => {
      if (args[3] === 'conn-0001') return Promise.reject(new Error('ASPSP 500'))
      return Promise.resolve({ imported: 0, duplicates: 0, errors: 0 })
    })
    state.active = fleet(4)

    const body = await (await GET(cronRequest())).json()

    expect(body).toMatchObject({ processed: 4, completed: 3, totalFailed: 1 })
    const failed = body.results.find((r: { connectionId: string }) => r.connectionId === 'conn-0001')
    expect(failed).toMatchObject({ status: 'error', errors: 1 })
    consoleError.mockRestore()
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: shared sync lease', () => {
  it('claims the lease before it calls the bank', async () => {
    state.active = [connection()]
    mocks.syncAccountTransactions.mockImplementation(async () => {
      expect(state.leaseWrites).toHaveLength(1)
      return { imported: 0, duplicates: 0, errors: 0 }
    })

    await GET(cronRequest())

    expect(state.leaseWrites[0].ids).toEqual(['conn-1'])
    expect(Date.parse(state.leaseWrites[0].until)).toBeGreaterThan(Date.now() + 14 * 60 * 1000)
  })

  it('stays off a connection whose lease another sync holds', async () => {
    // An agent-triggered sync, "Synka nu", or a rate-limit cooldown.
    state.active = [connection({ sync_lease_until: new Date(Date.now() + 5 * 60 * 1000).toISOString() })]

    const response = await GET(cronRequest())

    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ coolingDown: 1, due: 0, processed: 0 })
  })

  it('yields when it loses the claim to a sync that started after the plan', async () => {
    state.active = [connection()]
    state.claimLosers.add('conn-1')

    const response = await GET(cronRequest())

    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      selected: 1,
      leaseLost: 1,
      processed: 0,
      deferredByTimeBudget: 0,
    })
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: bank rate limit', () => {
  it('leaves the row alone and cools down every connection on the consent', async () => {
    // Before: an untyped 429 parked the row in 'error', which no cron run
    // selects again, under a message telling the user to renew the consent.
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.active = [
      connection({ id: 'limited', company_id: companyId(1) }),
      connection({ id: 'sibling', company_id: companyId(2), last_synced_at: hoursAgo(1) }),
      connection({ id: 'stranger', company_id: companyId(3), session_id: 'sess-2', last_synced_at: hoursAgo(1) }),
    ]
    mocks.syncAccountTransactions.mockRejectedValue(
      new AspspUnavailableError(429, '{"message":"Consent daily limit 4 is exceeded"}', 'rate-limited', undefined, {
        dailyQuota: true,
      }),
    )

    const body = await (await GET(cronRequest())).json()

    expect(body).toMatchObject({ totalRateLimited: 1, totalFailed: 0 })
    expect(state.updates).toEqual([])
    const lease = (id: string) => Date.parse(state.active.find(row => row.id === id)?.sync_lease_until as string)
    expect(lease('limited')).toBeGreaterThan(Date.now() + 5 * HOUR_MS)
    expect(lease('sibling')).toBe(lease('limited'))
    expect(lease('stranger')).toBe(0)

    // The next hourly run does not spend another refused call.
    mocks.syncAccountTransactions.mockClear()
    const next = await (await GET(cronRequest())).json()
    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    expect(next).toMatchObject({ coolingDown: 1, due: 0 })
    consoleWarn.mockRestore()
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: time budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops starting work at the budget and leaves the rest due for the next run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-09-02T05:00:00.000Z')
    vi.setSystemTime(start)
    state.active = fleet(6)
    mocks.syncAccountTransactions.mockImplementation(async () => {
      // The first bank call eats the whole budget.
      vi.setSystemTime(start + 231_000)
      return { imported: 0, duplicates: 0, errors: 0 }
    })

    const first = await (await GET(cronRequest())).json()

    // The four workers were already in flight; nothing new starts.
    expect(first).toMatchObject({ selected: 6, completed: 4, deferredByTimeBudget: 2 })
    const unsynced = state.active.filter(row => row.last_synced_at === null).map(row => row.id)
    expect(unsynced).toEqual(['conn-0004', 'conn-0005'])

    // Next hour: only the two left over are due.
    vi.setSystemTime(start + HOUR_MS)
    mocks.syncAccountTransactions.mockResolvedValue({ imported: 0, duplicates: 0, errors: 0 })
    const second = await (await GET(cronRequest())).json()
    expect(second).toMatchObject({ due: 2, completed: 2, deferredByTimeBudget: 0 })
  })

  it('reports at the deadline instead of dying with a bank call that hangs', async () => {
    vi.useFakeTimers()
    state.active = fleet(2)
    mocks.syncAccountTransactions.mockImplementation((...args: unknown[]) =>
      args[3] === 'conn-0000'
        ? new Promise(() => {})
        : Promise.resolve({ imported: 0, duplicates: 0, errors: 0 }),
    )

    const responsePromise = GET(cronRequest())
    await vi.advanceTimersByTimeAsync(281_000)
    const body = await (await responsePromise).json()

    expect(body).toMatchObject({ hitReportDeadline: true, completed: 1, deferredByTimeBudget: 1 })
    // Nothing was recorded for the hung one: it is due again next run.
    expect(state.active.find(row => row.id === 'conn-0000')?.last_synced_at).toBeNull()
  })
})

/**
 * The cron used to log every per-connection failure at error level before it
 * decided what the failure was, so an expired PSD2 consent (the normal end of
 * a bank grant, answered with a reconnect prompt) filled the error panel the
 * same way a broken sync does. The non-cron path was fixed first; this locks
 * the cron half.
 */
describe('GET /api/extensions/enable-banking/sync/cron: failure log level', () => {
  it('logs an expired bank session as a warning, not an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.active = [connection()]
    mocks.syncAccountTransactions.mockRejectedValue(
      new SessionExpiredError(401, '{"message":"Session has expired"}'),
    )

    const response = await GET(cronRequest())

    // The connection still gets the re-auth state and its Swedish message.
    expect(state.updates[0].payload).toMatchObject({
      status: 'expired',
      error_message: REAUTH_REQUIRED_MESSAGE,
    })
    await expect(response.json()).resolves.toMatchObject({ processed: 1 })

    const lines = consoleError.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('sync failed for connection'))).toBe(false)
    consoleError.mockRestore()
  })

  it('still logs a genuine sync failure at error level', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.active = [connection()]
    mocks.syncAccountTransactions.mockRejectedValue(new Error('ASPSP 500'))

    await GET(cronRequest())

    expect(state.updates[0].payload).toMatchObject({ status: 'error' })
    const lines = consoleError.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('sync failed for connection'))).toBe(true)
    consoleError.mockRestore()
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: transient failures leave the row alone', () => {
  it('keeps a routing conflict eligible for the next run without changing its cursor or consent status', async () => {
    const lastSyncedAt = hoursAgo(24)
    state.active = [connection({ last_synced_at: lastSyncedAt })]
    mocks.syncAccountTransactions.mockRejectedValue(Object.assign(new Error('BANK_CONFIGURATION_CHANGED'), { code: 'PT409' }))
    const response = await GET(cronRequest())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ processed: 1, totalFailed: 1 })
    expect(state.updates).toEqual([])
    expect(state.active[0]).toMatchObject({ status: 'active', last_synced_at: lastSyncedAt, error_message: null })
  })

  // 2026-09-04: a connector contract mismatch parked four canary companies in
  // 'error' with "förnya anslutningen", and users re-authorized consents that
  // were fine. Neither a connector-hop failure nor a bank refusing right now
  // says anything about the PSD2 session, so the row keeps its status (the
  // daily health probe checks the session itself).
  it('does not park a connection in error when the connector hop fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.active = [connection()]
    mocks.syncAccountTransactions.mockRejectedValue(
      new ConnectorSyncError(200, 'CONNECTOR_BAD_SHAPE', '{"transactions":[]}', ['transactions.0.amount: Invalid input']),
    )

    const response = await GET(cronRequest())

    expect(state.updates).toEqual([])
    await expect(response.json()).resolves.toMatchObject({ processed: 1 })
    const errorLines = consoleError.mock.calls.map(call => String(call[0]))
    expect(errorLines.some(line => line.includes('sync failed for connection'))).toBe(false)
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  it('does not park a connection in error when the bank is refusing right now', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.active = [connection()]
    mocks.syncAccountTransactions.mockRejectedValue(
      new AspspUnavailableError(400, '{"error":"ASPSP_ERROR"}', 'window-already-accepted', '2026-08-28'),
    )

    await GET(cronRequest())

    expect(state.updates).toEqual([])
    const errorLines = consoleError.mock.calls.map(call => String(call[0]))
    expect(errorLines.some(line => line.includes('sync failed for connection'))).toBe(false)
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})

describe('GET /api/extensions/enable-banking/sync/cron: incremental lookback', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  // Pin the clock: the route reads Date.now() after the fixture does, and a
  // single elapsed millisecond makes Math.ceil in incrementalLookbackDays
  // count one more day than the fixture intended.
  const NOW = Date.parse('2026-09-02T05:00:00.000Z')
  const isoDate = (msAgo: number) => new Date(NOW - msAgo).toISOString().split('T')[0]
  const syncedDaysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString()

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the 7-day window when the connection synced yesterday', async () => {
    state.active = [connection({ last_synced_at: syncedDaysAgo(1) })]

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    const [, , , , , fromDate, , , options] = mocks.syncAccountTransactions.mock.calls[0]
    expect(fromDate).toBe(isoDate(7 * DAY_MS))
    expect(options).not.toHaveProperty('strategy')
  })

  it('widens the window to cover a gap since the last sync', async () => {
    // A subscription that lapsed for 20 days and was paid again: a fixed
    // 7-day window would silently drop the 13 days in between.
    state.active = [connection({ last_synced_at: syncedDaysAgo(20) })]

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    const [, , , , , fromDate] = mocks.syncAccountTransactions.mock.calls[0]
    expect(fromDate).toBe(isoDate(21 * DAY_MS))
  })

  it('asks for the deepest history the bank serves on a gap of a month or more', async () => {
    state.active = [connection({ last_synced_at: syncedDaysAgo(40) })]

    await GET(cronRequest())

    const [, , , , , fromDate, , , options] = mocks.syncAccountTransactions.mock.calls[0]
    expect(fromDate).toBe(isoDate(41 * DAY_MS))
    expect(options).toMatchObject({ strategy: 'longest' })
  })

  it('caps the widened window at 90 days', async () => {
    state.active = [connection({ last_synced_at: syncedDaysAgo(200) })]

    await GET(cronRequest())

    const [, , , , , fromDate] = mocks.syncAccountTransactions.mock.calls[0]
    expect(fromDate).toBe(isoDate(90 * DAY_MS))
  })
})
