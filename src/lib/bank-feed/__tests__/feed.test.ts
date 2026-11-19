import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveRoute: vi.fn(),
  syncAccount: vi.fn(),
  persistResult: vi.fn(),
  persistFailure: vi.fn(),
  persistRoute: vi.fn(),
  claimLease: vi.fn(),
  holdLease: vi.fn(),
  takeOverHold: vi.fn(),
  party: vi.fn(),
  emit: vi.fn(),
  sweep: vi.fn(),
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
  takeOverBankFeedHold: (...a: unknown[]) => mocks.takeOverHold(...a),
}))
vi.mock('../party', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../party')>()),
  buildBankFeedParty: (...a: unknown[]) => mocks.party(...a),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => mocks.emit(...a) } }))
vi.mock('@/lib/bank-sync/post-sync-sweep', () => ({ sweepAfterOverlappingSync: (...a: unknown[]) => mocks.sweep(...a) }))

import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import { BankSyncResultObsoleteError } from '@/lib/bank-sync/persist-sync-result'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'
import { BankFeedRefusedError, BankThrottledError, ConsentOverError, ProviderUnavailableError, RateLimitedError, type BankFeedConnect } from '../connect'
import { RATE_LIMIT_COOLDOWN_MS, rateLimitHoldUntil } from '../lease'
import {
  bankHistoryLimits,
  CONSENT_EXPIRED_MESSAGE,
  consentRefusedMessage,
  EXTENDED_HISTORY_MARGIN_DAYS,
  UNATTENDED_MAX_LOOKBACK_DAYS,
  DEFAULT_BANK_HISTORY_LIMITS,
  DEFAULT_TRANSACTION_HISTORY_MAX_DAYS,
  extendedHistoryWindowOpen,
  incrementalWindow,
  initialWindow,
  READ_AUTHENTICATION_REFUSED_MESSAGE,
  runOpenPaymentsSync,
  shouldAskForEnrichment,
  SYNC_FAILED_MESSAGE,
} from '../feed'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
/** The person at the screen, as the route forwards them: the bank serves the extended history to them only. */
const PRESENT = { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' }
const connect = {} as BankFeedConnect

/** The shared per-table Supabase mock (tests/helpers.ts), keyed by table, answers consumed in call order. */
function stub(answers: Record<string, unknown[] | TableMockResolver>) {
  const mock = createTableMockSupabase(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value as TableMockResult[] | TableMockResolver])))
  return { supabase: mock.supabase as never, calls: mock.calls, from: mock.supabase.from }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', company_id: 'co-1', user_id: 'owner-1', bank_name: 'Swedbank', session_id: 'consent-1', status: 'active', bic: 'SWEDSESS',
    affiliated_aspsp_id: null, psu_type: 'business', accounts_data: [{ uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' }],
    last_synced_at: new Date(NOW - 2 * DAY).toISOString(), initial_sync_completed_at: '2026-09-01T00:00:00Z', sync_lease_until: '1970-01-01T00:00:00Z',
    created_at: new Date(NOW - 10 * 60_000).toISOString(), consent_attempt: null, ...overrides,
  }
}

/** An adapter whose bank details say how far back the bank serves. */
function connectWithBank(details: { transactionHistoryMaxDays: number | null; extendedTransactionHistoryAvailableWindowMinutes: number | null }): BankFeedConnect {
  return { getBankDetails: vi.fn().mockResolvedValue({ bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: false, extendedTransactionHistoryMaxDays: 760, affiliates: [], ...details }) } as unknown as BankFeedConnect
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
  mocks.takeOverHold.mockResolvedValue(true)
  mocks.party.mockResolvedValue({ ok: true, party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: null, psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null } })
  mocks.emit.mockResolvedValue(undefined)
  mocks.sweep.mockResolvedValue(0)
})

describe('windows', () => {
  it('asks incrementally for the gap since the last sync plus a day, between a week and what the bank serves (88 days unless it says)', () => {
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 2 * DAY).toISOString() }, NOW)).toMatchObject({ fromDate: '2026-10-05', toDate: '2026-10-12', lookbackDays: 7 })
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 20 * DAY).toISOString() }, NOW).lookbackDays).toBe(21)
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 400 * DAY).toISOString() }, NOW).lookbackDays).toBe(88)
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 400 * DAY).toISOString() }, NOW, 30).lookbackDays).toBe(30)
    expect(incrementalWindow({ last_synced_at: new Date(NOW - 2 * DAY).toISOString() }, NOW, 5).lookbackDays).toBe(5)
    expect(incrementalWindow({ last_synced_at: null }, NOW).lookbackDays).toBe(7)
    expect(DEFAULT_TRANSACTION_HISTORY_MAX_DAYS).toBe(88)
  })

  it('reads the extended history window from the row\'s age against the bank\'s minutes, open when the age is unknown', () => {
    expect(extendedHistoryWindowOpen({ created_at: new Date(NOW - 59 * 60_000).toISOString() }, 60, NOW)).toBe(true)
    expect(extendedHistoryWindowOpen({ created_at: new Date(NOW - 61 * 60_000).toISOString() }, 60, NOW)).toBe(false)
    expect(extendedHistoryWindowOpen({ created_at: new Date(NOW - 61 * 60_000).toISOString() }, 120, NOW)).toBe(true)
    expect(extendedHistoryWindowOpen({ created_at: null }, 60, NOW)).toBe(true)
  })

  it('takes the bank\'s limits from the adapter\'s cached details and falls back to the defaults', async () => {
    expect(await bankHistoryLimits(connectWithBank({ transactionHistoryMaxDays: 30, extendedTransactionHistoryAvailableWindowMinutes: 15 }), 'co-1', 'SWEDSESS')).toEqual({ maxDays: 30, extendedWindowMinutes: 15 })
    expect(await bankHistoryLimits(connectWithBank({ transactionHistoryMaxDays: null, extendedTransactionHistoryAvailableWindowMinutes: null }), 'co-1', 'SWEDSESS')).toEqual(DEFAULT_BANK_HISTORY_LIMITS)
    expect(await bankHistoryLimits({ getBankDetails: vi.fn().mockRejectedValue(new Error('down')) } as unknown as BankFeedConnect, 'co-1', 'SWEDSESS')).toEqual(DEFAULT_BANK_HISTORY_LIMITS)
    expect(await bankHistoryLimits(connect, 'co-1', 'SWEDSESS')).toEqual(DEFAULT_BANK_HISTORY_LIMITS)
  })

  it('asks the first import from the later of the extended window and the Enable Banking history minus a week', () => {
    expect(initialWindow({ extendedHistoryDays: 760, lastBookedDate: null }, NOW).fromDate).toBe('2024-09-12')
    expect(initialWindow({ extendedHistoryDays: null, lastBookedDate: null }, NOW).fromDate).toBe('2025-10-12')
    expect(initialWindow({ extendedHistoryDays: 760, lastBookedDate: '2026-10-01' }, NOW)).toMatchObject({ fromDate: '2026-09-24', toDate: '2026-10-12', lookbackDays: 18 })
    expect(initialWindow({ extendedHistoryDays: 88, lastBookedDate: '2024-01-01' }, NOW).fromDate).toBe('2026-07-16')
  })
})

describe('bank history limits (Länsförsäkringar)', () => {
  it('never lets an ordinary read past 89 days, even when the bank details list more', async () => {
    const lf = connectWithBank({ transactionHistoryMaxDays: 180, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    expect((await bankHistoryLimits(lf, 'co-1', 'ELLFSESS')).maxDays).toBe(UNATTENDED_MAX_LOOKBACK_DAYS)
    expect(UNATTENDED_MAX_LOOKBACK_DAYS).toBeLessThan(90)
    // Swedbank lists 88, under the cap: unchanged.
    const swedbank = connectWithBank({ transactionHistoryMaxDays: 88, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    expect((await bankHistoryLimits(swedbank, 'co-1', 'SWEDSESS')).maxDays).toBe(88)
    // A connection last read 150 days ago asks for 89 days, not 151.
    const stale = { last_synced_at: new Date(NOW - 150 * 24 * 60 * 60_000).toISOString() }
    expect(incrementalWindow(stale, NOW, (await bankHistoryLimits(lf, 'co-1', 'ELLFSESS')).maxDays).lookbackDays).toBe(89)
  })

  it('closes the extended window after 20 minutes, whatever the details or the default say', async () => {
    const lf = connectWithBank({ transactionHistoryMaxDays: 180, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    expect((await bankHistoryLimits(lf, 'co-1', 'ELLFSESS')).extendedWindowMinutes).toBe(20)
    expect((await bankHistoryLimits(connectWithBank({ transactionHistoryMaxDays: 180, extendedTransactionHistoryAvailableWindowMinutes: null }), 'co-1', 'ELLFSESS')).extendedWindowMinutes).toBe(20)
    expect((await bankHistoryLimits({ getBankDetails: vi.fn().mockRejectedValue(new Error('down')) } as unknown as BankFeedConnect, 'co-1', 'ELLFSESS')).extendedWindowMinutes).toBe(20)
    // A shorter window the bank lists stands.
    expect((await bankHistoryLimits(connectWithBank({ transactionHistoryMaxDays: 180, extendedTransactionHistoryAvailableWindowMinutes: 10 }), 'co-1', 'ellfsess')).extendedWindowMinutes).toBe(10)
    // Swedbank keeps its hour.
    expect((await bankHistoryLimits(connectWithBank({ transactionHistoryMaxDays: 88, extendedTransactionHistoryAvailableWindowMinutes: 60 }), 'co-1', 'SWEDSESS')).extendedWindowMinutes).toBe(60)
    // 25 minutes after the consent: the first import asks for the ordinary window.
    const limits = await bankHistoryLimits(lf, 'co-1', 'ELLFSESS')
    expect(extendedHistoryWindowOpen({ created_at: new Date(NOW - 25 * 60_000).toISOString() }, limits.extendedWindowMinutes, NOW)).toBe(false)
    expect(extendedHistoryWindowOpen({ created_at: new Date(NOW - 15 * 60_000).toISOString() }, limits.extendedWindowMinutes, NOW)).toBe(true)
  })

  it('keeps the first import three days off the extended edge the bank lists (395 days refused as past 13 months)', async () => {
    const lf = connectWithBank({ transactionHistoryMaxDays: 180, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    const { supabase } = stub({
      bank_connections: [{ data: row({ bic: 'ELLFSESS', initial_sync_completed_at: null, last_synced_at: null, created_at: new Date(NOW - 5 * 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 395 } } }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    const result = await run(supabase, { trigger: 'initial', signer: PRESENT, connect: lf })
    expect(result).toMatchObject({ ok: true, history_window: 'extended' })
    expect(EXTENDED_HISTORY_MARGIN_DAYS).toBe(3)
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ fromDate: new Date(NOW - 392 * 24 * 60 * 60_000).toISOString().slice(0, 10) }))
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

  it('asks an unattended sync for the enrichment facts while the stamp is missing or older than today, stamps the latest time on the connection and reports the window\'s enrichment and the rows the re-read updated', async () => {
    const { supabase, calls } = stub({
      bank_connections: [{ data: row({ last_enriched_at: '2026-10-11T04:05:00+00:00', accounts_data: [{ uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' }, { uid: 'B', currency: 'SEK', enabled: true, ledger_account: '1930' }] }), error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [], error: null }],
    })
    mocks.syncAccount
      .mockResolvedValueOnce({ imported: 0, duplicates: 3, errors: 0, transactionIds: [], requestedFromDate: '2026-10-05', historyNarrowed: false, truncated: false, enrichedUpdated: 2, enrichment: { lastEnrichedAt: '2026-10-12T04:05:00Z', windowEnriched: true } })
      .mockResolvedValueOnce({ imported: 0, duplicates: 1, errors: 0, transactionIds: [], requestedFromDate: '2026-10-05', historyNarrowed: false, truncated: false, enrichedUpdated: 1, enrichment: { lastEnrichedAt: '2026-10-12T04:09:00Z', windowEnriched: false } })
    const result = await run(supabase, { trigger: 'cron', unattended: true })
    expect(result).toMatchObject({ ok: true, duplicates: 4, enriched_updated: 3, window_enriched: false })
    expect(mocks.syncAccount).toHaveBeenCalledTimes(2)
    for (const call of mocks.syncAccount.mock.calls) expect(call[1]).toMatchObject({ includeEnrichment: true })
    const stamp = calls.find((c) => c.table === 'bank_connections' && c.method === 'update')
    expect(stamp?.args).toEqual([{ last_enriched_at: '2026-10-12T04:09:00Z' }])
    expect(log.info).toHaveBeenCalledWith('open payments sync completed', expect.objectContaining({ enrichedUpdated: 3, windowEnriched: false, lastEnrichedAt: '2026-10-12T04:09:00Z' }))
  })

  it('does not ask for the enrichment facts when today\'s stamp is already on the connection, nor on a sync a person triggered', async () => {
    const today = stub({ bank_connections: [{ data: row({ last_enriched_at: '2026-10-12T03:00:00+00:00' }), error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    await expect(run(today.supabase, { trigger: 'cron', unattended: true })).resolves.toMatchObject({ ok: true, window_enriched: null })
    expect(mocks.syncAccount.mock.calls[0][1]).not.toHaveProperty('includeEnrichment')
    expect(today.calls.filter((c) => c.table === 'bank_connections' && c.method === 'update')).toEqual([])

    mocks.syncAccount.mockClear()
    const manual = stub({ bank_connections: [{ data: row({ last_enriched_at: null }), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    await expect(run(manual.supabase, { trigger: 'manual' })).resolves.toMatchObject({ ok: true })
    expect(mocks.syncAccount.mock.calls[0][1]).not.toHaveProperty('includeEnrichment')

    // The rule on its own: missing or older than today's UTC date asks; today's does not; a person never.
    const yesterday = '2026-10-11T14:40:00+00:00'
    expect(shouldAskForEnrichment({ last_enriched_at: null, last_synced_at: yesterday }, true, NOW)).toBe(true)
    expect(shouldAskForEnrichment({ last_enriched_at: null, last_synced_at: null }, true, NOW)).toBe(true)
    expect(shouldAskForEnrichment({ last_enriched_at: '2026-10-11T23:59:59+00:00', last_synced_at: yesterday }, true, NOW)).toBe(true)
    expect(shouldAskForEnrichment({ last_enriched_at: '2026-10-12T00:00:01+00:00', last_synced_at: yesterday }, true, NOW)).toBe(false)
    expect(shouldAskForEnrichment({ last_enriched_at: '2026-10-12T02:00:00+02:00', last_synced_at: yesterday }, true, NOW)).toBe(false)
    expect(shouldAskForEnrichment({ last_enriched_at: null, last_synced_at: yesterday }, false, NOW)).toBe(false)
    // Only the first sync of the UTC day asks: a bank that never stamps (Swedbank) is asked once a day, not on every run.
    expect(shouldAskForEnrichment({ last_enriched_at: null, last_synced_at: '2026-10-12T02:40:00+00:00' }, true, NOW)).toBe(false)
    expect(shouldAskForEnrichment({ last_enriched_at: '2026-10-10T04:00:00+00:00', last_synced_at: '2026-10-12T00:00:00+00:00' }, true, NOW)).toBe(false)
    expect(shouldAskForEnrichment({ last_enriched_at: null, last_synced_at: '2026-10-11T23:59:59+00:00' }, true, NOW)).toBe(true)
  })

  it('reads every enabled account through the route, persists, emits and answers the window', async () => {
    const { supabase, calls } = stub({
      bank_connections: [{ data: row(), error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [{ id: 't1' }, { id: 't2' }], error: null }],
    })
    const result = await run(supabase, { trigger: 'manual', signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' } })
    expect(result).toEqual({ ok: true, connection_id: 'conn-1', bank: 'Swedbank', imported: 2, duplicates: 1, from_date: '2026-10-05', to_date: '2026-10-12', last_synced_at: expect.any(String), enriched_updated: 0, window_enriched: null })
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'eq', args: ['aggregator', 'open_payments'] })
    // No enrichment reported: the connection's last_enriched_at is left alone.
    expect(calls.filter((c) => c.table === 'bank_connections' && c.method === 'update')).toEqual([])
    expect(mocks.claimLease).toHaveBeenCalledWith(supabase, 'conn-1', NOW)
    // The PSU is the connection's owner, whoever pressed Synka nu.
    expect(mocks.party).toHaveBeenCalledWith(supabase, expect.objectContaining({ bic: 'SWEDSESS', affiliatedAspspId: null, psuType: 'business', userId: 'owner-1', signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' } }))
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'conn-1', fromDate: '2026-10-05', toDate: '2026-10-12', options: {} }))
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'conn-1', sessionId: 'consent-1', initialSync: undefined }))
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
  })

  it('announces a first import of thousands of rows in chunked reads, and logs a failed read instead of swallowing it', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: `tx-${i}` }))
    mocks.syncAccount.mockResolvedValue({ imported: 1500, duplicates: 0, errors: 0, transactionIds: many.map((r) => r.id), returnedMinBookingDate: '2026-10-05', returnedMaxBookingDate: '2026-10-11', requestedFromDate: '2026-10-03', historyNarrowed: false, truncated: false })
    const ok = stub({
      bank_connections: [{ data: row(), error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [(chain: { method: string; args: unknown[] }[]) => {
        const ids = chain.find((c) => c.method === 'in')?.args[1] as string[]
        return { data: many.filter((r) => ids.includes(r.id)), error: null }
      }],
    })
    expect(await run(ok.supabase, { trigger: 'manual', signer: PRESENT })).toMatchObject({ ok: true, imported: 1500 })
    const reads = ok.calls.filter((c) => c.table === 'transactions' && c.method === 'in').map((c) => (c.args[1] as string[]).length)
    expect(reads).toEqual([200, 200, 200, 200, 200, 200, 200, 100])
    expect(mocks.emit).toHaveBeenCalledTimes(1)
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({ type: 'transaction.synced', payload: { transactions: many } })

    mocks.emit.mockClear()
    const failing = stub({
      bank_connections: [{ data: row(), error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: null, error: { message: 'URI too long' } }],
    })
    // The rows are stored and the sync persisted: the sync still answers ok.
    expect(await run(failing.supabase, { trigger: 'manual', signer: PRESENT })).toMatchObject({ ok: true, imported: 1500 })
    expect(mocks.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not announced'), expect.objectContaining({ connectionId: 'conn-1', message: 'URI too long' }))
  })

  it('gives a never-synced connection the extended window, no cooldown, and records the first import', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: new Date(NOW - 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'viewer' }, error: null }],
      transactions: [{ data: { date: '2026-10-01' }, error: null }],
      sie_imports: [{ data: { id: 'sie' }, error: null }],
    })
    const result = await run(supabase, { trigger: 'initial', signer: PRESENT })
    expect(result).toMatchObject({ ok: true, from_date: '2026-09-24', history_window: 'extended' })
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ fromDate: '2026-09-24', options: { rawInsertOnly: true, skipAutoCategorization: true } }))
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ initialSync: expect.objectContaining({ requestedFrom: '2026-09-24', returnedMin: '2026-10-05', lookbackDays: 18 }) }))
    // Viewers get raw inserts: no synced event and no sweep for them.
    expect(mocks.emit).not.toHaveBeenCalled()
    expect(mocks.sweep).not.toHaveBeenCalled()
  })

  // PH 195: a first import the bank had not finished is not the first
  // import: the rows that came are stored, and the next sync asks again.
  it('leaves a first import owed when the service read stopped before the bank ran out of pages', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    mocks.syncAccount.mockResolvedValue({ imported: 0, duplicates: 0, errors: 0, transactionIds: [], requestedFromDate: '2024-09-15', historyNarrowed: false, truncated: true })
    const result = await run(supabase, { trigger: 'initial' })
    expect(result).toMatchObject({ ok: true })
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'conn-1', initialSync: undefined }))
  })

  it('treats an unanswered SIE overlap check as an overlap: no auto-categorization, the sweep runs, and it is an error', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }],
    })
    mocks.syncAccount.mockResolvedValue({ imported: 12, duplicates: 0, errors: 0, transactionIds: ['t1'], returnedMinBookingDate: '2026-08-01', returnedMaxBookingDate: '2026-10-01', requestedFromDate: '2026-07-01', historyNarrowed: false, truncated: false })
    const result = await run(supabase, { trigger: 'cron', unattended: true })
    expect(result).toMatchObject({ ok: true })
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ options: expect.objectContaining({ skipAutoCategorization: true }) }))
    expect(mocks.sweep).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith('SIE overlap check failed: treating the window as covered by an import', expect.objectContaining({ connectionId: 'conn-1', code: '57014' }))
  })

  it('links a first import over SIE-imported books to the existing verifikat (crm#1282)', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: { id: 'sie' }, error: null }],
    })
    mocks.syncAccount.mockResolvedValue({ imported: 327, duplicates: 0, errors: 0, transactionIds: ['t1'], returnedMinBookingDate: '2024-09-23', returnedMaxBookingDate: '2026-05-29', requestedFromDate: '2024-09-15', historyNarrowed: false, truncated: false })
    const result = await run(supabase, { trigger: 'cron', unattended: true })
    expect(result).toMatchObject({ ok: true })
    expect(mocks.sweep).toHaveBeenCalledWith(supabase, expect.objectContaining({
      companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', ledgerAccounts: ['1930'], returnedMin: '2024-09-23',
    }))
  })

  it('does not sweep when no completed SIE import covers the window', async () => {
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    await run(supabase, { trigger: 'cron', unattended: true })
    expect(mocks.sweep).not.toHaveBeenCalled()
  })

  it('a first import the cron retries after the extended window closed asks for the ordinary window and says so', async () => {
    const bank = connectWithBank({ transactionHistoryMaxDays: 88, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    const { supabase } = stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, created_at: new Date(NOW - 3 * 60 * 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    const result = await run(supabase, { trigger: 'cron', unattended: true, connect: bank })
    expect(result).toMatchObject({ ok: true, from_date: '2026-07-16', to_date: '2026-10-12', history_window: 'ordinary' })
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ fromDate: '2026-07-16' }))
    expect(mocks.persistResult).toHaveBeenCalledWith(supabase, expect.objectContaining({ initialSync: expect.objectContaining({ requestedFrom: '2026-07-16', lookbackDays: 88 }) }))
    expect(bank.getBankDetails).toHaveBeenCalledWith('co-1', 'SWEDSESS')

    // Inside the window the extended range stands for the person present only.
    const soon = () => stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, created_at: new Date(NOW - 20 * 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    // Three days off the bank's listed edge (760): a dateFrom exactly on it is refused by some banks.
    expect(await run(soon().supabase, { trigger: 'initial', signer: PRESENT, connect: bank })).toMatchObject({ ok: true, from_date: '2024-09-15', history_window: 'extended' })
  })

  it('a first import nobody is present for asks for the ordinary window even while the extended one is open', async () => {
    // Swedbank, 2026-10-26: the cron retried a refused first import 15 minutes
    // after the consent, asked for 757 days unattended and was refused with
    // "Mandatory header is missing: PSU-User-Agent".
    const bank = connectWithBank({ transactionHistoryMaxDays: 88, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    const fresh = () => stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, created_at: new Date(NOW - 15 * 60_000).toISOString(), consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      transactions: [{ data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    const cron = fresh()
    expect(await run(cron.supabase, { trigger: 'cron', unattended: true, connect: bank })).toMatchObject({ ok: true, from_date: '2026-07-16', history_window: 'ordinary' })
    expect(mocks.syncAccount).toHaveBeenLastCalledWith(cron.supabase, expect.objectContaining({ fromDate: '2026-07-16' }))
    // An agent's sync carries no IP address: nobody is at the bank either.
    const agent = fresh()
    expect(await run(agent.supabase, { trigger: 'agent', connect: bank })).toMatchObject({ ok: true, from_date: '2026-07-16', history_window: 'ordinary' })
    // The person at the screen still gets the extended range.
    const person = fresh()
    expect(await run(person.supabase, { trigger: 'manual', signer: PRESENT, connect: bank })).toMatchObject({ ok: true, from_date: '2024-09-15', history_window: 'extended' })
  })

  // crm#1647: a company whose books in Accounted start 2026-01-01 got two
  // years of earlier bank rows into the to-book list from the first import.
  it('starts a first import at the books\' start, never short of the ordinary window, and unchanged without a fiscal period', async () => {
    const firstImport = (period: string | null, imported: Array<{ entry_date: string; created_at: string }> = []) => stub({
      bank_connections: [{ data: row({ initial_sync_completed_at: null, last_synced_at: null, consent_attempt: { selection: { extended_history_days: 760 } } }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      transactions: [{ data: null, error: null }],
      fiscal_periods: [{ data: period ? { period_start: period } : null, error: null }],
      journal_entries: [{ data: imported, error: null }, { data: null, error: null }],
      sie_imports: [{ data: null, error: null }],
    })
    const opened = firstImport('2026-01-01')
    expect(await run(opened.supabase, { trigger: 'initial', signer: PRESENT })).toMatchObject({ ok: true, from_date: '2026-01-01', history_window: 'extended' })
    expect(mocks.syncAccount).toHaveBeenLastCalledWith(opened.supabase, expect.objectContaining({ fromDate: '2026-01-01' }))
    expect(mocks.persistResult).toHaveBeenLastCalledWith(opened.supabase, expect.objectContaining({ initialSync: expect.objectContaining({ requestedFrom: '2026-01-01' }) }))

    // A migration through 2026-09-14: the start is inside the ordinary window, which still comes whole.
    const migrated = firstImport('2025-01-01', [{ entry_date: '2026-09-14', created_at: '2026-10-01T08:00:00Z' }])
    expect(await run(migrated.supabase, { trigger: 'initial', signer: PRESENT })).toMatchObject({ ok: true, from_date: '2026-07-16' })

    // Onboarding, no fiscal period yet: the whole extended range, as before.
    expect(await run(firstImport(null).supabase, { trigger: 'initial', signer: PRESENT })).toMatchObject({ ok: true, from_date: '2024-09-15' })
  })

  it('clamps the incremental window to the bank\'s transactionHistoryMaxDays', async () => {
    const bank = connectWithBank({ transactionHistoryMaxDays: 30, extendedTransactionHistoryAvailableWindowMinutes: 60 })
    const { supabase } = stub({
      bank_connections: [{ data: row({ last_synced_at: new Date(NOW - 400 * DAY).toISOString() }), error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [], error: null }],
    })
    const result = await run(supabase, { trigger: 'cron', unattended: true, connect: bank })
    expect(result).toMatchObject({ ok: true, from_date: '2026-09-12', to_date: '2026-10-12' })
    expect(result).not.toHaveProperty('history_window')
    expect(mocks.syncAccount).toHaveBeenCalledWith(supabase, expect.objectContaining({ fromDate: '2026-09-12' }))
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

  it('lets a person at the screen read through a budget or failure hold, puts the hold back when that read fails, and keeps an agent away', async () => {
    const person = { trigger: 'manual', signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' } }
    const heldUntil = new Date(NOW + 10 * 60 * 60_000).toISOString()
    const held = () => stub({
      bank_connections: [{ data: row({ sync_lease_until: heldUntil }), error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [], error: null }],
    })

    const ok = held()
    expect(await run(ok.supabase, person)).toMatchObject({ ok: true })
    expect(mocks.takeOverHold).toHaveBeenCalledWith(ok.supabase, 'conn-1', heldUntil, NOW)
    expect(mocks.claimLease).not.toHaveBeenCalled()
    expect(mocks.holdLease).not.toHaveBeenCalled()

    mocks.syncAccount.mockRejectedValueOnce(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
    const failed = held()
    expect(await run(failed.supabase, person)).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
    expect(mocks.holdLease).toHaveBeenCalledWith(failed.supabase, 'conn-1', new Date(heldUntil).getTime())

    // A concurrent claim or a newer hold changed the lease: the take-over loses, nothing is read.
    mocks.syncAccount.mockClear()
    mocks.takeOverHold.mockResolvedValueOnce(false)
    const raced = held()
    expect(await run(raced.supabase, person)).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN' })
    expect(mocks.syncAccount).not.toHaveBeenCalled()

    // No person present (an agent, the cron): the hold stands.
    const agent = held()
    expect(await run(agent.supabase, { trigger: 'agent' })).toMatchObject({ ok: false, code: 'BANK_RATE_LIMITED' })
    expect(mocks.syncAccount).not.toHaveBeenCalled()
  })

  it('skips the membership check for the cron and refuses a stranger otherwise', async () => {
    const cron = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    expect(await run(cron.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: true })
    expect(cron.from).not.toHaveBeenCalledWith('company_members')
    // Unattended, but never anonymous: the PSU-ID the consent was created with (by connection), else the owner's number on file.
    expect(mocks.party).toHaveBeenCalledWith(cron.supabase, expect.objectContaining({ userId: 'owner-1', connectionId: 'conn-1', signer: { personalNumber: null, ipAddress: null, userAgent: null } }))
    const stranger = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: null, error: null }] })
    expect(await run(stranger.supabase)).toEqual({ ok: false, code: 'NOT_FOUND', connection_id: 'conn-1' })
  })

  it('checks the cron deadline before each account: the unread one leaves the connection due, the rows read are announced', async () => {
    // One account read can wait 120 s at Connect; the budget used to be checked only before a connection.
    const deadlineMs = Date.now() + 60_000
    const clock = vi.spyOn(Date, 'now')
    try {
      const accounts = [
        { uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' },
        { uid: 'B', currency: 'SEK', enabled: true, ledger_account: '1930' },
      ]
      const { supabase } = stub({
        bank_connections: [{ data: row({ accounts_data: accounts }), error: null }],
        sie_imports: [{ data: null, error: null }],
        transactions: [{ data: [{ id: 't1' }, { id: 't2' }], error: null }],
      })
      mocks.syncAccount.mockImplementationOnce(async () => {
        // The first account used up the budget.
        clock.mockReturnValue(deadlineMs + 1)
        return { imported: 2, duplicates: 0, errors: 0, transactionIds: ['t1', 't2'], returnedMinBookingDate: '2026-10-05', returnedMaxBookingDate: '2026-10-11', requestedFromDate: '2026-10-03', historyNarrowed: false, truncated: false }
      })

      const result = await run(supabase, { trigger: 'cron', unattended: true, deadlineMs })

      expect(result).toMatchObject({ ok: false, code: 'BANK_SYNC_COOLDOWN', connection_id: 'conn-1', deadline_reached: true })
      expect(mocks.syncAccount).toHaveBeenCalledTimes(1)
      // Not stamped as synced, and not a failure on the row.
      expect(mocks.persistResult).not.toHaveBeenCalled()
      expect(mocks.persistFailure).not.toHaveBeenCalled()
      expect(mocks.holdLease).not.toHaveBeenCalled()
      // The rows of the account that was read are announced now: the next read finds them as duplicates.
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
    } finally {
      clock.mockRestore()
    }
  })

  it('gives its claim back when the deadline stops it, so a person\'s Synka nu is not answered with a cooldown', async () => {
    const { supabase, calls } = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase, { trigger: 'cron', unattended: true, deadlineMs: Date.now() - 1 })).toMatchObject({ deadline_reached: true })
    const updates = calls.filter((c) => c.table === 'bank_connections' && c.method === 'update')
    expect(updates.map((c) => c.args[0])).toEqual([{ sync_lease_until: new Date(NOW).toISOString() }])
    // Only the claim this sync wrote: a hold written meanwhile stays.
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'eq', args: ['sync_lease_until', new Date(NOW + SYNC_COOLDOWN_MS).toISOString()] })
  })

  it('reads nothing when the deadline has passed before the first account, and a sync without a deadline is never stopped', async () => {
    const past = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(past.supabase, { trigger: 'cron', unattended: true, deadlineMs: Date.now() - 1 })).toMatchObject({ ok: false, deadline_reached: true })
    expect(mocks.syncAccount).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()

    const none = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    expect(await run(none.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: true })
  })

  describe('a first import over several accounts', () => {
    const accountA = { uid: 'A', iban: 'SE4550000000058398257466', currency: 'SEK', enabled: true, ledger_account: '1930' }
    const accountB = { uid: 'B', iban: 'SE3550000000054910000003', currency: 'SEK', enabled: true, ledger_account: '1930' }
    const read = (rows: string[]) => ({ imported: rows.length, duplicates: 0, errors: 0, transactionIds: rows, returnedMinBookingDate: '2026-07-20', returnedMaxBookingDate: '2026-10-12', requestedFromDate: '2026-07-16', historyNarrowed: false, truncated: false })
    const firstImportRow = () => row({ initial_sync_completed_at: null, last_synced_at: null, created_at: new Date(NOW - 3 * 60 * 60_000).toISOString(), accounts_data: [accountA, accountB] })

    /**
     * The transactions table as the window reads ask it: the newest row an
     * account stored (by its key's start), the newest row the connection
     * took over (stored before it was made), and the announcement's read.
     */
    function transactions(own: Record<string, string | null>, takenOver: string | null = null): TableMockResolver {
      return (chain) => {
        if (chain.some((c) => c.method === 'in')) return { data: [{ id: 'a1' }] }
        const like = chain.find((c) => c.method === 'like')
        if (like) {
          const head = String(like.args[1])
          const uid = Object.keys(own).find((key) => head.includes(key === 'A' ? accountA.iban : accountB.iban))
          const date = uid ? own[uid] : null
          return { data: date ? { date } : null }
        }
        if (chain.some((c) => c.method === 'lt' && c.args[0] === 'created_at')) return { data: takenOver ? { date: takenOver } : null }
        // The connection's newest row, whichever account stored it: what the window was read from before.
        const newest = [takenOver, ...Object.values(own)].filter((d): d is string => Boolean(d)).sort().pop()
        return { data: newest ? { date: newest } : null }
      }
    }

    it('cut after one account by the deadline, the next attempt still asks the other for its whole history', async () => {
      // Account A's rows were stored up to today; the window used to start at
      // the connection's newest row, so B was asked for one week and the
      // import was then marked done: B's history was short for good.
      const clock = vi.spyOn(Date, 'now')
      try {
        const deadlineMs = Date.now() + 60_000
        const first = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: null, B: null }) })
        mocks.syncAccount.mockImplementationOnce(async () => {
          clock.mockReturnValue(deadlineMs + 1)
          return read(['a1'])
        })
        expect(await run(first.supabase, { trigger: 'cron', unattended: true, deadlineMs })).toMatchObject({ deadline_reached: true })
        expect(mocks.syncAccount).toHaveBeenCalledTimes(1)
        expect(mocks.persistResult).not.toHaveBeenCalled()
        clock.mockRestore()

        // The next attempt: A has stored rows through today, B none.
        mocks.syncAccount.mockReset().mockResolvedValue(read([]))
        const second = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: '2026-10-12', B: null }) })
        const result = await run(second.supabase, { trigger: 'cron', unattended: true })

        const fromOf = (uid: string) => (mocks.syncAccount.mock.calls.find((c) => (c[1] as { account: { uid: string } }).account.uid === uid)![1] as { fromDate: string }).fromDate
        // A overlaps its own rows by a week; B gets the whole ordinary window.
        expect(fromOf('A')).toBe('2026-10-05')
        expect(fromOf('B')).toBe('2026-07-16')
        expect(result).toMatchObject({ ok: true, from_date: '2026-07-16' })
        expect(mocks.persistResult).toHaveBeenCalledWith(second.supabase, expect.objectContaining({ initialSync: expect.objectContaining({ requestedFrom: '2026-07-16', lookbackDays: 88 }) }))
        // Each account's rows are found by the start of its own keys.
        expect(second.calls.filter((c) => c.table === 'transactions' && c.method === 'like').map((c) => c.args)).toEqual([
          ['external_id', 'eb\\_SE4550000000058398257466\\_%'],
          ['external_id', 'eb\\_SE3550000000054910000003\\_%'],
        ])
      } finally {
        clock.mockRestore()
      }
    })

    it('a failure on the second account leaves its history whole too, and the rows the first stored are announced', async () => {
      const first = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: null, B: null }) })
      mocks.syncAccount
        .mockResolvedValueOnce(read(['a1']))
        .mockRejectedValueOnce(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
      expect(await run(first.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
      // Before, A's rows stayed unannounced: matching and the forecast never saw them.
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced', payload: expect.objectContaining({ transactions: [{ id: 'a1' }] }) }))

      mocks.syncAccount.mockReset().mockResolvedValue(read([]))
      const second = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: '2026-10-12', B: null }) })
      await run(second.supabase, { trigger: 'cron', unattended: true })
      const callOf = (uid: string) => mocks.syncAccount.mock.calls.find((c) => (c[1] as { account: { uid: string } }).account.uid === uid)![1] as { fromDate: string }
      expect(callOf('B').fromDate).toBe('2026-07-16')
      expect(callOf('A').fromDate).toBe('2026-10-05')
    })

    it('reads the accounts that have stored nothing first, so a retry spends no account\'s reads twice before the rest', async () => {
      // A cut first import read A; its retry read A again first, one of A's
      // four unattended reads a day, and a connection that kept landing late
      // could spend A's budget while B was never read.
      const clock = vi.spyOn(Date, 'now')
      try {
        const deadlineMs = Date.now() + 60_000
        const { supabase } = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: '2026-10-12', B: null }) })
        mocks.syncAccount.mockImplementationOnce(async () => {
          clock.mockReturnValue(deadlineMs + 1)
          return read(['b1'])
        })
        expect(await run(supabase, { trigger: 'cron', unattended: true, deadlineMs })).toMatchObject({ deadline_reached: true })
        expect(mocks.syncAccount.mock.calls.map((c) => (c[1] as { account: { uid: string } }).account.uid)).toEqual(['B'])
      } finally {
        clock.mockRestore()
      }
      // Without the deadline both are read, B first.
      mocks.syncAccount.mockReset().mockResolvedValue(read([]))
      const whole = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: '2026-10-12', B: null }) })
      await run(whole.supabase, { trigger: 'cron', unattended: true })
      expect(mocks.syncAccount.mock.calls.map((c) => (c[1] as { account: { uid: string } }).account.uid)).toEqual(['B', 'A'])
    })

    it('overlaps the history the connection took over by a week, for an account with no rows of its own', async () => {
      // A switch from Enable Banking: the old connection's rows were moved over, stored before this connection was made.
      const { supabase, calls } = stub({ bank_connections: [{ data: firstImportRow(), error: null }], sie_imports: [{ data: null, error: null }], transactions: transactions({ A: null, B: null }, '2026-10-01') })
      mocks.syncAccount.mockResolvedValue(read([]))
      expect(await run(supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: true, from_date: '2026-09-24' })
      expect(mocks.syncAccount.mock.calls.map((c) => (c[1] as { fromDate: string }).fromDate)).toEqual(['2026-09-24', '2026-09-24'])
      expect(calls).toContainEqual({ table: 'transactions', method: 'lt', args: ['created_at', new Date(NOW - 3 * 60 * 60_000).toISOString()] })
    })
  })

  it('announces the rows the failing account itself stored: beside rejected rows, and before a consent that ended on the balance read', async () => {
    // Both throws came after ingest had stored rows, and their ids were lost:
    // the next read found them as duplicates, so they were never announced.
    const accounts = [
      { uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' },
      { uid: 'B', currency: 'SEK', enabled: true, ledger_account: '1930' },
    ]
    const failures = [
      Object.assign(new Error('Bank transaction persistence failed: duplicate key'), { code: '23505' }),
      new ConsentOverError('over'),
    ]
    for (const failure of failures) {
      mocks.emit.mockClear()
      mocks.syncAccount.mockReset()
        .mockResolvedValueOnce({ imported: 1, duplicates: 0, errors: 0, transactionIds: ['a1'], returnedMinBookingDate: '2026-10-05', returnedMaxBookingDate: '2026-10-11', requestedFromDate: '2026-10-05', historyNarrowed: false, truncated: false })
        .mockImplementationOnce(async (_s: unknown, input: { onStored?: (ids: readonly string[]) => void }) => {
          input.onStored?.(['b1', 'b2'])
          throw failure
        })
      const { supabase, calls } = stub({
        bank_connections: [{ data: row({ accounts_data: accounts }), error: null }],
        sie_imports: [{ data: null, error: null }],
        transactions: [{ data: [{ id: 'a1' }, { id: 'b1' }, { id: 'b2' }], error: null }],
      })
      expect(await run(supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false })
      expect(calls.filter((c) => c.table === 'transactions' && c.method === 'in').map((c) => c.args)).toEqual([['id', ['a1', 'b1', 'b2']]])
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'transaction.synced' }))
    }
  })

  it('announces what an earlier account stored when a later one fails on an ordinary sync too', async () => {
    const accounts = [
      { uid: 'A', currency: 'SEK', enabled: true, ledger_account: '1930' },
      { uid: 'B', currency: 'SEK', enabled: true, ledger_account: '1930' },
    ]
    const { supabase } = stub({
      bank_connections: [{ data: row({ accounts_data: accounts }), error: null }],
      sie_imports: [{ data: null, error: null }],
      transactions: [{ data: [{ id: 't1' }, { id: 't2' }], error: null }],
    })
    mocks.syncAccount
      .mockResolvedValueOnce({ imported: 2, duplicates: 0, errors: 0, transactionIds: ['t1', 't2'], returnedMinBookingDate: '2026-10-05', returnedMaxBookingDate: '2026-10-11', requestedFromDate: '2026-10-05', historyNarrowed: false, truncated: false })
      .mockRejectedValueOnce(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
    expect(await run(supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false })
    expect(mocks.emit.mock.calls.filter((c) => (c[0] as { type: string }).type === 'transaction.synced')).toHaveLength(1)
  })

  it('an unattended read sends the PSU-ID the consent was created with, and no IP address or user agent', async () => {
    const kept = { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: '198001019879', psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null }
    mocks.party.mockResolvedValueOnce({ ok: true, source: 'signatory_link', party: kept })
    const cron = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }], transactions: [{ data: [], error: null }] })
    expect(await run(cron.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: true })
    expect(mocks.party).toHaveBeenCalledWith(cron.supabase, expect.objectContaining({ connectionId: 'conn-1', signer: { personalNumber: null, ipAddress: null, userAgent: null } }))
    expect(mocks.syncAccount).toHaveBeenCalledWith(cron.supabase, expect.objectContaining({ party: kept }))
  })

  it('flips the row to expired when the consent is over', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new ConsentOverError('over', { status: 410 }))
    const { supabase } = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase)).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ status: 'expired', message: CONSENT_EXPIRED_MESSAGE }))
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.sync_failed', payload: expect.objectContaining({ provider: 'open_payments', errorClass: 'session_expired', status: 'expired', httpStatus: 410 }) }))
  })

  // crm#1355: the bank refused every unattended read with PSU_CREDENTIALS_INVALID
  // and the row sat in 'error' ("try again in a while") while the cron asked
  // again every six hours. A permanent code needs a renewal, once.
  it('flips the row to expired with the code\'s own sentence when the bank refuses the consent for good, and does not hold the lease for another try', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode: 'PSU_CREDENTIALS_INVALID' }))
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'error' }), error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    const message = consentRefusedMessage('PSU_CREDENTIALS_INVALID')
    expect(message).toBe('Det valda avtalet överensstämmer inte med företagets organisationsnummer. Kontrollera uppgifterna. Förnya kopplingen med BankID för att fortsätta synka.')
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ status: 'expired', message }))
    expect(mocks.holdLease).not.toHaveBeenCalled()
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.sync_failed', payload: expect.objectContaining({ errorClass: 'consent_refused', status: 'expired', ebCode: 'PSU_CREDENTIALS_INVALID' }) }))
    expect(log.error).not.toHaveBeenCalled()
  })

  // A read refused as AUTHENTICATION_FAILED never passed again without a
  // renewal in production, while the row sat in 'error' and the cron asked
  // every six hours. It needs a renewal, once, with a sentence that says so.
  it('flips the row to expired when the bank refuses a read as AUTHENTICATION_FAILED, and stops asking', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode: 'AUTHENTICATION_FAILED' }))
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'error' }), error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    expect(consentRefusedMessage('AUTHENTICATION_FAILED')).toBe(READ_AUTHENTICATION_REFUSED_MESSAGE)
    expect(READ_AUTHENTICATION_REFUSED_MESSAGE).not.toContain('Försök igen')
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ status: 'expired', message: READ_AUTHENTICATION_REFUSED_MESSAGE }))
    expect(mocks.holdLease).not.toHaveBeenCalled()
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.sync_failed', payload: expect.objectContaining({ errorClass: 'consent_refused', status: 'expired', ebCode: 'AUTHENTICATION_FAILED' }) }))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('treats a lower-case permanent code the same, and leaves a refusal without a permanent code in error for the next run', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode: 'psu_rights_missing' }))
    const rights = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(rights.supabase)).toMatchObject({ ok: false, code: 'BANK_SESSION_EXPIRED', status: 'expired' })
    expect(mocks.persistFailure).toHaveBeenCalledWith(rights.supabase, expect.objectContaining({ status: 'expired', message: consentRefusedMessage('PSU_RIGHTS_MISSING') }))

    mocks.persistFailure.mockClear()
    mocks.syncAccount.mockRejectedValueOnce(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode: 'FORMAT_ERROR' }))
    const format = stub({ bank_connections: [{ data: row(), error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(format.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED', status: 'error' })
    expect(mocks.persistFailure).toHaveBeenCalledWith(format.supabase, expect.objectContaining({ status: 'error', message: SYNC_FAILED_MESSAGE }))
    expect(mocks.holdLease).toHaveBeenCalledWith(format.supabase, 'conn-1', NOW + 6 * 60 * 60 * 1000)
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

  it('holds the lease for the bank\'s short throttle only, never the budget hold, and leaves the row alone', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new BankThrottledError('busy', { retryAfterSeconds: 45 }))
    const { supabase } = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(supabase)).toMatchObject({ ok: false, code: 'BANK_THROTTLED', status: 'active', retry_after_seconds: 60, next_allowed_at: new Date(NOW + 60_000).toISOString() })
    expect(mocks.holdLease).toHaveBeenCalledWith(supabase, 'conn-1', NOW + 60_000)
    expect(mocks.persistFailure).not.toHaveBeenCalled()
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.sync_failed', payload: expect.objectContaining({ errorClass: 'throttled', cooldownSeconds: 60 }) }))

    // A longer Retry-After is honoured up to an ordinary claim: the hold still reads as a cooldown, not a spent budget.
    mocks.syncAccount.mockRejectedValueOnce(new BankThrottledError('busy', { retryAfterSeconds: 3600 }))
    const long = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(long.supabase)).toMatchObject({ code: 'BANK_THROTTLED', retry_after_seconds: SYNC_COOLDOWN_MS / 1000 })
    expect(rateLimitHoldUntil({ sync_lease_until: new Date(NOW + SYNC_COOLDOWN_MS).toISOString() }, NOW)).toBeNull()
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

  it('holds a failed unattended read for six hours, so a failing connection makes at most four attempts a day and never holds a person\'s Synka nu', async () => {
    mocks.syncAccount.mockRejectedValueOnce(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
    const night = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    expect(await run(night.supabase, { trigger: 'cron', unattended: true })).toMatchObject({ ok: false, code: 'BANK_SYNC_FAILED' })
    expect(mocks.holdLease).toHaveBeenCalledWith(night.supabase, 'conn-1', NOW + 6 * 60 * 60 * 1000)

    mocks.holdLease.mockClear()
    mocks.syncAccount.mockRejectedValueOnce(new Error('refused'))
    const refused = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    await run(refused.supabase, { trigger: 'cron', unattended: true })
    expect(mocks.holdLease).toHaveBeenCalledWith(refused.supabase, 'conn-1', NOW + 6 * 60 * 60 * 1000)

    mocks.holdLease.mockClear()
    mocks.syncAccount.mockRejectedValueOnce(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }))
    const person = stub({ bank_connections: [{ data: row(), error: null }], company_members: [{ data: { role: 'owner' }, error: null }], sie_imports: [{ data: null, error: null }] })
    await run(person.supabase, { trigger: 'manual' })
    expect(mocks.holdLease).not.toHaveBeenCalled()
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
