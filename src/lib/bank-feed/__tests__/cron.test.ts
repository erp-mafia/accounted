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
import { runOpenPaymentsCron } from '../cron'

const NOW = Date.parse('2026-10-12T10:20:00Z')
const HOUR = 60 * 60 * 1000
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

/** The shared per-table Supabase mock (tests/helpers.ts), keyed by table, answers consumed in call order. */
function stub(answers: Record<string, unknown[]>) {
  const mock = createTableMockSupabase(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value as TableMockResult[]])))
  return { supabase: mock.supabase as never, calls: mock.calls, from: mock.supabase.from }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', company_id: 'co-1', user_id: 'owner-1', bank_name: 'Swedbank', status: 'active', session_id: 'consent-1',
    consent_expires: new Date(NOW + 30 * 24 * HOUR).toISOString(), last_synced_at: new Date(NOW - 12 * HOUR).toISOString(),
    last_expiry_notification_at: null, sync_lease_until: '1970-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
    accounts_data: [{ uid: 'A', enabled: true }], consent_attempt: null, ...overrides,
  }
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
    const expired = connection({ id: 'gone', consent_expires: new Date(NOW - HOUR).toISOString() })
    const waiting = connection({ id: 'picker', status: 'pending_selection', consent_expires: new Date(NOW - HOUR).toISOString() })
    const { supabase, calls } = stub({
      bank_connections: [
        { data: [], error: null },
        { data: [expired, waiting, connection()], error: null },
        { data: [{ id: 'picker' }], error: null },
      ],
    })
    const result = await runOpenPaymentsCron(supabase, log, { now: NOW, baseUrl: 'https://app.test' })
    expect(result.expired).toBe(2)
    expect(mocks.persistFailure).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: 'gone', status: 'expired', message: CONSENT_EXPIRED_MESSAGE }))
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'update', args: [{ status: 'expired', error_message: CONSENT_EXPIRED_MESSAGE }] })
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(supabase, expect.objectContaining({ id: 'gone' }), 0, true, 'https://app.test')
    expect(result.synced).toBe(1)
  })

  it('syncs what is due every 11 hours for admitted companies, four at a time, and skips the rest for a reason', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', 'co-1,co-listed')
    const rows = [
      connection({ id: 'due' }),
      connection({ id: 'listed-no-plan', company_id: 'co-listed' }),
      connection({ id: 'fresh', last_synced_at: new Date(NOW - 10 * HOUR).toISOString() }),
      connection({ id: 'leased', sync_lease_until: new Date(NOW + HOUR).toISOString() }),
      connection({ id: 'empty', accounts_data: [{ uid: 'A', enabled: false }] }),
      connection({ id: 'stranger', company_id: 'co-other' }),
      connection({ id: 'picker', status: 'pending_selection' }),
      connection({ id: 'never', last_synced_at: null, status: 'error' }),
    ]
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: rows, error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now: NOW })
    expect(result).toMatchObject({ connector: true, due: 3, synced: 3, failed: 0, skipped: { notAdmitted: 1, notEntitled: 0, noAccounts: 1, fresh: 1, leased: 1, budget: 0 } })
    expect(mocks.run.mock.calls.map((c) => (c[1] as { connectionId: string }).connectionId).sort()).toEqual(['due', 'listed-no-plan', 'never'])
    expect(mocks.run).toHaveBeenCalledWith(supabase, expect.objectContaining({ trigger: 'cron', unattended: true, userId: 'owner-1' }))
  })

  it('with * asks the paid plan and counts a sync that answered a failure', async () => {
    mocks.entitled.mockResolvedValue(new Set(['co-1']))
    mocks.run.mockResolvedValueOnce({ ok: false, code: 'BANK_SYNC_FAILED' })
    const { supabase } = stub({ bank_connections: [{ data: [], error: null }, { data: [connection(), connection({ id: 'unpaid', company_id: 'co-free' })], error: null }] })
    const result = await runOpenPaymentsCron(supabase, log, { now: NOW })
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
