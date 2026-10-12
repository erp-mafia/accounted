import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveRoute: vi.fn(),
  syncAccount: vi.fn(),
  persistResult: vi.fn(),
  persistFailure: vi.fn(),
  persistRoute: vi.fn(),
  claimLease: vi.fn(),
  holdLease: vi.fn(),
  party: vi.fn(),
  emit: vi.fn(),
}))
vi.mock('@/lib/bank-sync/ingest-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bank-sync/ingest-route')>()),
  resolveBankIngestRoute: (...a: unknown[]) => mocks.resolveRoute(...a),
}))
vi.mock('../sync', () => ({ syncOpenPaymentsAccount: (...a: unknown[]) => mocks.syncAccount(...a) }))
vi.mock('@/lib/bank-sync/persist-sync-result', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bank-sync/persist-sync-result')>()),
  persistBankSyncResult: (...a: unknown[]) => mocks.persistResult(...a),
  persistBankSyncFailure: (...a: unknown[]) => mocks.persistFailure(...a),
  persistBankRouteNeedsConfiguration: (...a: unknown[]) => mocks.persistRoute(...a),
}))
vi.mock('../lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lease')>()),
  claimBankFeedLease: (...a: unknown[]) => mocks.claimLease(...a),
  holdBankFeedLease: (...a: unknown[]) => mocks.holdLease(...a),
}))
vi.mock('../party', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../party')>()),
  buildBankFeedParty: (...a: unknown[]) => mocks.party(...a),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => mocks.emit(...a) } }))

import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { BankSyncResultObsoleteError } from '@/lib/bank-sync/persist-sync-result'
import { ConsentOverError, ProviderUnavailableError, RateLimitedError, type BankFeedConnect } from '../connect'
import { RATE_LIMIT_COOLDOWN_MS } from '../lease'
import { CONSENT_EXPIRED_MESSAGE, SYNC_FAILED_MESSAGE, incrementalWindow, initialWindow, runOpenPaymentsSync } from '../feed'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const connect = {} as BankFeedConnect

/** The shared per-table Supabase mock (tests/helpers.ts), keyed by table, answers consumed in call order. */
function stub(answers: Record<string, unknown[]>) {
  const mock = createTableMockSupabase(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value as TableMockResult[]])))
  return { supabase: mock.supabase as never, calls: mock.calls, from: mock.supabase.from }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', company_id: 'co-1', user_id: 'owner-1', bank_name: 'Swedbank', session_id: 'consent-1', status: 'active', bic: 'SWEDSESS',
    affiliated_aspsp_id: null, psu_type: 'business', accounts_data: [{ uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' }],
    last_synced_at: new Date(NOW - 2 * DAY).toISOString(), initial_sync_completed_at: '2026-09-01T00:00:00Z', sync_lease_until: '1970-01-01T00:00:00Z',
    consent_attempt: null, ...overrides,
  }
}

function run(supabase: never, extra: Record<string, unknown> = {}) {
  return runOpenPaymentsSync(supabase, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', log, connect, now: NOW, ...extra })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveRoute.mockResolvedValue({ connectionId: 'conn-1', sessionId: 'consent-1', accountUid: 'A', cashAccountId: 'cash-1', ledgerAccount: '1930', currency: 'SEK', token: 't' })
  mocks.syncAccount.mockResolvedValue({ imported: 2, duplicates: 1, errors: 0, transactionIds: ['t1', 't2'], returnedMinBookingDate: '2026-10-05', returnedMaxBookingDate: '2026-10-11', requestedFromDate: '2026-10-03', historyNarrowed: false, truncated: false })
  mocks.persistResult.mockResolvedValue(undefined)
  mocks.persistFailure.mockResolvedValue(true)
  mocks.persistRoute.mockResolvedValue(undefined)
  mocks.claimLease.mockResolvedValue(true)
  mocks.holdLease.mockResolvedValue(undefined)
  mocks.party.mockResolvedValue({ ok: true, party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: null, psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null } })
  mocks.emit.mockResolvedValue(undefined)
})

describe('windows', () => {
  it('asks incrementally for the gap since the last sync plus a day, between a week and 90 days', () => {
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 2 * DAY).toISOString() }, NOW)).toMatchObject({ fromDate: '2026-10-05', toDate: '2026-10-12', lookbackDays: 7 })
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 20 * DAY).toISOString() }, NOW).lookbackDays).toBe(21)
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 400 * DAY).toISOString() }, NOW).lookbackDays).toBe(90)
    expect(incrementalWindow({ last_synced_at: null }, NOW).lookbackDays).toBe(7)
  })

  it('asks the first import from the later of the extended window and the Enable Banking history minus a week', () => {
    expect(initialWindow({ extendedHistoryDays: 760, lastBookedDate: null }, NOW).fromDate).toBe('2024-09-12')
    expect(initialWindow({ extendedHistoryDays: null, lastBookedDate: null }, NOW).fromDate).toBe('2025-10-12')
    expect(initialWindow({ extendedHistoryDays: 760, lastBookedDate: '2026-10-01' }, NOW)).toMatchObject({ fromDate: '2026-09-24', toDate: '2026-10-12', lookbackDays: 18 })
    expect(initialWindow({ extendedHistoryDays: 88, lastBookedDate: '2024-01-01' }, NOW).fromDate).toBe('2026-07-16')
  })
})

describe('runOpenPaymentsSync', () => {
  it('answers NOT_FOUND for a row it does not know, before asking for the connector', async () => {
    const { supabase } = stub({ bank_connections: [{ data: null, error: null }] })
    expect(await runOpenPaymentsSync(supabase, { companyId: 'co-1', userId: 'user-1', connectionId: 'x', log, connect: undefined, now: NOW })).toEqual({ ok: false, code: 'NOT_FOUND', connection_id: 'x' })
  })

  it('refuses a row that is not active and a row without enabled accounts', async () => {
    const pending = stub({ bank_connections: [{ data: row({ status: 'pending_selection' }), error: null }] })
    expect(await run(pending.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_NOT_ACTIVE', status: 'pending_selection' })
    const none = stub({ bank_connections: [{ data: row({ accounts_data: [{ uid: 'A', currency: 'SEK', enabled: false }] }), error: null }] })
    expect(await run(none.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_NO_ACCOUNTS' })
  })

  it('reads every enabled account through the route, persists, emits and answers the window', async () => {
    const { supabase, calls } = stub({
      bank_connections: [{ data: row(), error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [{ id: 't1' }, { id: 't2' }], error: null }],
    })
    const result = await run(supabase, { trigger: 'manual', signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' } })
    expect(result).toEqual({ ok: true, connection_id: 'conn-1', bank: 'Swedbank', imported: 2, duplicates: 1, from_date: '2026-10-05', to_date: '2026-10-12', last_synced_at: expect.any(String) })
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'eq', args: ['aggregator', 'open_payments'] })
    expect(mocks.claimLease).toHaveBeenCalledWith(supabase, 'conn-1', NOW)
    expect(mocks.party).toHaveBeenCalledWith(supabase, expect.objectContaining({ bic: 'SWEDSESS', psuType: 'business', signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' } }))
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'conn-1', fromDate: '2026-10-05', toDate: '2026-10-12', options: {} }))
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'conn-1', sessionId: 'consent-1', initialSync: undefined }))
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
  })

  it('gives a never-synced connection the extended window, no cooldown, and records the first import', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: new Date(NOW - 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'viewer' }, error: null }],
      transactions: [{ data: { date: '2026-10-01' }, error: null }],
      sie_imports: [{ data: { id: 'sie' }, error: null }],
    })
    const result = await run(supabase, { trigger: 'initial' })
    expect(result).toMatchObject({ ok: true, from_date: '2026-09-24' })
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ fromDate: '2026-09-24', options: { rawInsertOnly: true, skipAutoCategorization: true } }))
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ initialSync: expect.objectContaining({ requestedFrom: '2026-09-24', returnedMin: '2026-10-05', lookbackDays: 18 }) }))
    // Viewers get raw inserts: no synced event for them.
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('answers the cooldown after a recent sync or a held lease, and a lost claim', async () => {
    const fresh = stub({ bank_connections: [{ data: row({ last_synced_at: new Date(NOW - 60_000).toISOString() }), error: null }], company_members: [{ data: { role: 'owner' }, error: null }] })
    expect(await run(fresh.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN', retry_after_seconds: 14 * 60 })
    const held = stub({ bank_connections: [{ data: row({ sync_lease_until: new Date(NOW + 5 * 60_000).toISOString() }), error: null }], company_members: [{ data: { role: 'owner' }, error: null }] })
    expect(await run(held.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN', retry_after_seconds: 300 })
    mocks.claimLease.mockResolvedValueOnce(false)
    const lost = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }] })
    expect(await run(lost.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN' })
    expect(mocks.syncAccount).not.toHaveBeenCalled()
  })

  it('reads a long lease as a spent budget and does not call the bank', async () => {
    const { supabase } = stub({ bank_connections: [{ data: row({ sync_lease_until: new Date(NOW + 6 * 60 * 60_000).toISOString() }), error: null }], company_members: [{ data: { role: 'owner' }, error: null }] })
    expect(await run(supabase)).toMatchObject({ ok: false, code: 'BANK_RATE_LIMITED', retry_after_seconds: 6 * 3600 })
    expect(mocks.syncAccount).not.toHaveBeenCalled()
  })

  it('skips the membership check for the cron and refuses a stranger otherwise', async () => {
    const cron = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    expect(await run(cron.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: true })
    expect(cron.from).not.toHaveBeenCalledWith('company_members')
    const stranger = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: null, error: null }] })
    expect(await run(stranger.supabase)).toEqual({ ok: false, code: 'NOT_FOUND', connection_id: 'conn-1' })
  })

  it('flips the row to expired when the consent is over', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new ConsentOverError('over', { status: 410 }))
    const { supabase } = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase)).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ status: 'expired', message: CONSENT_EXPIRED_MESSAGE }))
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.sync_failed', payload: expect.objectContaining({ provider: 'open_payments', errorClass: 'session_expired', status: 'expired', httpStatus: 410 }) }))
  })

  it('holds the lease for the Retry-After on a spent budget, else half a day, and leaves the row alone', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new RateLimitedError('budget', { retryAfterSeconds: 7200 }))
    const { supabase } = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase)).toMatchObject({ ok: false, code: 'BANK_RATE_LIMITED', status: 'active', retry_after_seconds: 7200 })
    expect(mocks.holdLease).toHaveBeenCalledWith(supabase, 'conn-1', NOW + 7200_000)
    expect(mocks.persistFailure).not.toHaveBeenCalled()

    mocks.syncAccount.mockRejectedValueOnce(new RateLimitedError('budget'))
    const again = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(again.supabase)).toMatchObject({ retry_after_seconds: RATE_LIMIT_COOLDOWN_MS / 1000 })
  })

  it('leaves the row untouched when the provider is unavailable, and parks an unknown failure in error', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new ProviderUnavailableError('down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
    const down = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(down.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED', status: 'active' })
    expect(mocks.persistFailure).not.toHaveBeenCalled()

    mocks.syncAccount.mockRejectedValueOnce(new Error('boom'))
    const boom = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(boom.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED', status: 'error' })
    expect(mocks.persistFailure).toHaveBeenCalledWith(boom.supabase, expect.objectContaining({ status: 'error', message: SYNC_FAILED_MESSAGE }))
  })

  it('stores the picker advice on an unresolved route and reports an obsolete result as a failure', async () => {
    mocks.resolveRoute.mockRejectedValueOnce(Object.assign(new Error('BANK_INGEST_ROUTE_UNRESOLVED'), { code: 'PT409' }))
    const unresolved = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(unresolved.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
    expect(mocks.persistRoute).toHaveBeenCalledWith(unresolved.supabase, { companyId: 'co-1', connectionId: 'conn-1' })

    mocks.persistResult.mockRejectedValueOnce(new BankSyncResultObsoleteError('session_changed'))
    const obsolete = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(obsolete.supabase)).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
    expect(mocks.persistFailure).not.toHaveBeenCalled()
  })
})
