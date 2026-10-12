import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  persistFailure: vi.fn(),
  notify: vi.fn(),
  entitled: vi.fn(),
  connect: vi.fn(),
}))
vi.mock('../feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../feed')>()),
  runOpenPaymentsSync: (...a: unknown[]) => mocks.run(...a),
}))
vi.mock('@/lib/bank-sync/persist-sync-result', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bank-sync/persist-sync-result')>()),
  persistBankSyncFailure: (...a: unknown[]) => mocks.persistFailure(...a),
}))
vi.mock('@/lib/bank-sync/consent-expiry-notification', () => ({ sendConsentExpiryNotification: (...a: unknown[]) => mocks.notify(...a) }))
vi.mock('@/lib/entitlements/has-capability', () => ({ getCompanyIdsWithCapability: (...a: unknown[]) => mocks.entitled(...a) }))
vi.mock('../connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connect')>()),
  getBankFeedConnect: () => mocks.connect(),
}))

import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { CONSENT_EXPIRED_MESSAGE } from '../feed'
import {
  CATCHUP_PER_RUN,
  isScheduledNow,
  nextScheduledTime,
  RENEWAL_NOTICE_DAYS,
  renewalDeepLink,
  runOpenPaymentsCron,
  SYNC_SLOTS,
  SYNC_WINDOW_MS,
  syncSlotOf,
  syncWindowOf,
} from '../cron'

const NOW = Date.parse('2026-10-12T10:20:00Z')
const HOUR = 60 * 60 * 1000
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

/** The shared per-table Supabase mock (tests/helpers.ts), keyed by table, answers consumed in call order. */
function stub(answers: Record<string, unknown[]>) {
  const mock = createTableMockSupabase(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value as TableMockResult[]])))
  return { supabase: mock.supabase as never, calls: mock.calls, from: mock.supabase.from }
}

/** A connection last synced 12 hours before `at` (due by age), consent valid, lease free. */
function connection(overrides: Record<string, unknown> = {}, at = NOW) {
  return {
    id: 'conn-1', company_id: 'co-1', user_id: 'owner-1', bank_name: 'Swedbank', bic: 'SWEDSESS', status: 'active', session_id: 'consent-1',
    consent_expires: new Date(at + 30 * 24 * HOUR).toISOString(), last_synced_at: new Date(at - 12 * HOUR).toISOString(),
    last_expiry_notification_at: null, sync_lease_until: '1970-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
    accounts_data: [{ uid: 'A', enabled: true }], consent_attempt: null, ...overrides,
  }
}

/** An id whose window is NOT open at `at`, from a few candidates. */
function offSlotId(at: number): string {
  const id = ['off-1', 'off-2', 'off-3', 'off-4'].find((candidate) => !isScheduledNow(candidate, at))
  if (!id) throw new Error('no off-slot id')
  return id
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.run.mockResolvedValue({ ok: true })
  mocks.persistFailure.mockResolvedValue(true)
  mocks.notify.mockResolvedValue(undefined)
  mocks.entitled.mockResolvedValue(new Set(['co-1']))
  mocks.connect.mockReturnValue({})
  vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '*')
})
afterEach(() => vi.unstubAllEnvs())

describe('the sync schedule', () => {
  it('gives every connection a fixed slot and two windows a day, twelve hours apart', () => {
    const slot = syncSlotOf('d3b07384-d9a0-4c2a-9f1e-000000000001')
    expect(slot).toBe(syncSlotOf('d3b07384-d9a0-4c2a-9f1e-000000000001'))
    expect(slot).toBeGreaterThanOrEqual(0)
    expect(slot).toBeLessThan(SYNC_SLOTS)
    const first = nextScheduledTime('conn-1', NOW)
    expect(first).toBeGreaterThanOrEqual(NOW)
    expect(first - NOW).toBeLessThan(SYNC_SLOTS * SYNC_WINDOW_MS)
    expect(isScheduledNow('conn-1', first)).toBe(true)
    expect(isScheduledNow('conn-1', first + 12 * HOUR)).toBe(true)
    expect(isScheduledNow('conn-1', first + SYNC_WINDOW_MS)).toBe(false)
    expect(syncWindowOf(Date.parse('2026-10-12T00:05:00Z'))).toBe(0)
    expect(syncWindowOf(Date.parse('2026-10-12T23:55:00Z'))).toBe(143)
  })

  it('spreads real ids across the slots instead of piling them up', () => {
    const slots = new Set<number>()
    for (let i = 0; i < 200; i++) slots.add(syncSlotOf(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))
    expect(slots.size).toBeGreaterThan(SYNC_SLOTS / 2)
  })
})

describe('runOpenPaymentsCron', () => {
  it('removes attempts abandoned for an hour, keeping one a second signatory still has to sign', async () => {
    const { supabase, calls } = stub({
      bank_connections: [
        { data: [
          { id: 'old', created_at: new Date(NOW - 2 * HOUR).toISOString(), consent_attempt: { state: 'pending', started_at: new Date(NOW - 90 * 60_000).toISOString() } },
          { id: 'restarted', created_at: new Date(NOW - 3 * HOUR).toISOString(), consent_attempt: { state: 'pending', started_at: new Date(NOW - 10 * 60_000).toISOString() } },
          { id: 'joint', created_at: new Date(NOW - 20 * HOUR).toISOString(), consent_attempt: { state: 'partially_authorised', started_at: new Date(NOW - 20 * HOUR).toISOString() } },
          { id: 'legacy', created_at: new Date(NOW - 2 * HOUR).toISOString(), consent_attempt: null },
        ], error: null },
        { data: [{ id: 'old' }, { id: 'legacy' }], error: null },
        { data: [], error: null },
      ],
    })
    const result = await runOpenPaymentsCron(supabase, log, { now: NOW })
    expect(result.staleAttemptsRemoved).toBe(2)
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'in', args: ['id', ['old', 'legacy']] })
  })

  it('expires consents that have run out, through the sync-failure writer for synced rows, and sends the mail once each', async () => {
    const now = nextScheduledTime('conn-1', NOW)
    const expired = connection({ id: 'gone', consent_expires: new Date(now - HOUR).toISOString() }, now)
    const waiting = connection({ id: 'picker', status: 'pending_selection', consent_expires: new Date(now - HOUR).toISOString() }, now)
    const { supabase, calls } = stub({
      bank_connections: [
        { data: [], error: null },
        { data: [expired, waiting, connection({}, now)], error: null },
        { data: [{ id: 'picker' }], error: null },
      ],
    })
    const result = await runOpenPaymentsCron(supabase, log, { now, baseUrl: 'https://app.test' })
    expect(result.expired).toBe(2)
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'gone', status: 'expired', message: CONSENT_EXPIRED_MESSAGE }))
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'update', args: [{ status: 'expired', error_message: CONSENT_EXPIRED_MESSAGE }] })
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(supabase, expect.objectContaining({ id: 'gone' }), 0, true, 'https://app.test')
    expect(result.synced).toBe(1)
  })

  it('mails the renewal notice once, inside the last 14 days, with the renew deep link, and not when a renewal is in flight', async () => {
    const now = NOW
    const soon = (overrides: Record<string, unknown>) => connection({ consent_expires: new Date(now + 10 * 24 * HOUR).toISOString(), last_synced_at: new Date(now - HOUR).toISOString(), created_at: '2026-04-15T00:00:00Z', ...overrides }, now)
    const rows = [
      soon({ id: 'due-notice' }),
      // Told already: last_expiry_notification_at is the once.
      soon({ id: 'told', last_expiry_notification_at: new Date(now - 5 * 24 * HOUR).toISOString() }),
      // A younger row of the same company at the same bank is its renewal: nothing to ask for.
      soon({ id: 'renewing', company_id: 'co-2' }),
      connection({ id: 'renewal', company_id: 'co-2', created_at: new Date(now - HOUR).toISOString(), consent_expires: new Date(now + 170 * 24 * HOUR).toISOString(), last_synced_at: new Date(now - HOUR).toISOString() }, now),
      // Same company, another bank: its own lineage.
      soon({ id: 'other-bank', company_id: 'co-2', bic: 'ESSESESS', bank_name: 'SEB' }),
      // Far from expiry, and a picker that never synced: no notice.
      connection({ id: 'far', company_id: 'co-4', last_synced_at: new Date(now - HOUR).toISOString() }, now),
      soon({ id: 'picker', status: 'pending_selection' }),
    ]
    // A pending renewal (signing right now) also counts as in flight.
    const pendingRenewal = { id: 'signing', company_id: 'co-3', bic: 'SWEDSESS', bank_name: 'Swedbank', created_at: new Date(now - 10 * 60_000).toISOString(), consent_attempt: { state: 'pending', started_at: new Date(now - 10 * 60_000).toISOString() } }
    rows.push(soon({ id: 'renewing-pending', company_id: 'co-3' }))
    const { supabase } = stub({ bank_connections: [{ data: [pendingRenewal], error: null }, { data: rows, error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now, baseUrl: 'https://app.test' })
    expect(result.renewalNoticed).toBe(2)
    expect(result.expired).toBe(0)
    const noticed = mocks.notify.mock.calls.map((c) => [(c[1] as { id: string }).id, c[2], c[3], c[4], c[5]])
    expect(noticed).toEqual([
      ['due-notice', 10, false, 'https://app.test', { renewalUrl: 'https://app.test/settings/connections?bank_connect=due-notice&renew=1' }],
      ['other-bank', 10, false, 'https://app.test', { renewalUrl: 'https://app.test/settings/connections?bank_connect=other-bank&renew=1' }],
    ])
    expect(renewalDeepLink('https://app.test', 'a b')).toBe('https://app.test/settings/connections?bank_connect=a%20b&renew=1')
    expect(RENEWAL_NOTICE_DAYS).toBe(14)
  })

  it('syncs the connections whose window is open, catches up the ones that waited too long, and skips the rest for a reason', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', 'co-1,co-listed')
    const now = nextScheduledTime('due', NOW)
    const offslot = offSlotId(now)
    const rows = [
      connection({ id: 'due' }, now),
      connection({ id: 'listed-no-plan', company_id: 'co-listed', last_synced_at: new Date(now - 15 * HOUR).toISOString() }, now),
      connection({ id: offslot }, now),
      connection({ id: 'fresh', last_synced_at: new Date(now - 10 * HOUR).toISOString() }, now),
      connection({ id: 'leased', sync_lease_until: new Date(now + HOUR).toISOString() }, now),
      connection({ id: 'empty', accounts_data: [{ uid: 'A', enabled: false }] }, now),
      connection({ id: 'stranger', company_id: 'co-other' }, now),
      connection({ id: 'picker', status: 'pending_selection' }, now),
      connection({ id: 'never', last_synced_at: null, status: 'error' }, now),
    ]
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: rows, error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now })
    expect(result).toMatchObject({
      connector: true, due: 3, synced: 3, failed: 0, caughtUp: 2,
      skipped: { notAdmitted: 1, notEntitled: 0, noAccounts: 1, fresh: 1, leased: 1, notScheduled: 1, budget: 0 },
    })
    expect(mocks.run.mock.calls.map((c) => (c[1] as { connectionId: string }).connectionId).sort()).toEqual(['due', 'listed-no-plan', 'never'])
    expect(mocks.run).toHaveBeenCalledWith(supabase, expect.objectContaining({ trigger: 'cron', unattended: true, userId: 'owner-1' }))
  })

  it('caps the catch-ups per run so a recovery stays spread, and runs one connection at a time per bank (by BIC: every sparbank is Swedbank)', async () => {
    const now = NOW
    // Sparbanker carry their own names but one BIC; SEB is its own bank; a legacy row without a BIC falls back to its name.
    const banks: Array<{ bank_name: string; bic: string | null }> = [
      { bank_name: 'Sparbanken Nord', bic: 'SWEDSESS' },
      { bank_name: 'Swedbank', bic: 'SWEDSESS' },
      { bank_name: 'Bjursås Sparbank', bic: 'SWEDSESS' },
      { bank_name: 'SEB', bic: 'ESSESESS' },
      { bank_name: 'Nordea', bic: null },
    ]
    const rows = Array.from({ length: CATCHUP_PER_RUN + 2 }, (_, i) =>
      connection({ id: `late-${i}`, ...banks[i % banks.length], last_synced_at: new Date(now - 20 * HOUR).toISOString() }, now),
    ).filter((row) => !isScheduledNow(row.id, now))
    const inFlight: string[] = []
    let maxPerBank = 0
    const bankOf = new Map(rows.map((row) => [row.id, row.bic ?? row.bank_name]))
    mocks.run.mockImplementation(async (_s: unknown, input: { connectionId: string }) => {
      inFlight.push(input.connectionId)
      const bank = bankOf.get(input.connectionId)
      maxPerBank = Math.max(maxPerBank, inFlight.filter((id) => bankOf.get(id) === bank).length)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight.splice(inFlight.indexOf(input.connectionId), 1)
      return { ok: true }
    })
    const { supabase, calls } = stub({ bank_connections: [{ data: [], error: null }, { data: rows, error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now })
    expect(result.caughtUp).toBe(Math.min(CATCHUP_PER_RUN, rows.length))
    expect(result.skipped.notScheduled).toBe(Math.max(0, rows.length - CATCHUP_PER_RUN))
    expect(maxPerBank).toBe(1)
    expect(calls.some((c) => c.table === 'bank_connections' && c.method === 'select' && String(c.args[0]).includes(' bic,'))).toBe(true)
  })

  it('never reads two sparbank connections at Swedbank at once, whatever their names', async () => {
    const now = NOW
    const rows = ['Sparbanken Nord', 'Bjursås Sparbank', 'Sparbanken Skåne', 'Swedbank']
      .map((bank_name, i) => connection({ id: `sb-${i}`, bank_name, bic: 'SWEDSESS', last_synced_at: new Date(now - 20 * HOUR).toISOString() }, now))
      .filter((row) => !isScheduledNow(row.id, now))
    let inFlight = 0
    let maxInFlight = 0
    mocks.run.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return { ok: true }
    })
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: rows, error: null }] })
    await runOpenPaymentsCron(supabase, log, { now })
    expect(mocks.run).toHaveBeenCalledTimes(rows.length)
    expect(maxInFlight).toBe(1)
  })

  it('with * asks the paid plan and counts a sync that answered a failure', async () => {
    const now = nextScheduledTime('conn-1', NOW)
    mocks.entitled.mockResolvedValue(new Set(['co-1']))
    mocks.run.mockResolvedValueOnce({ ok: false, code: 'BANK_SYNC_FAILED' })
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: [connection({}, now), connection({ id: 'unpaid', company_id: 'co-free' }, now)], error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now })
    expect(result).toMatchObject({ due: 1, synced: 0, failed: 1, skipped: expect.objectContaining({ notEntitled: 1 }) })
  })

  it('is a truthful no-op on syncs without a connector key, after the sweep and the expiry pass', async () => {
    mocks.connect.mockReturnValue(null)
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: [connection()], error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now: NOW })
    expect(result).toMatchObject({ connector: false, due: 0, synced: 0 })
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
