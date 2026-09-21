import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const otherAccountHintMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({
  ENABLED_EXTENSION_IDS: new Set(['cloud-backup', 'skatteverket']),
}))
vi.mock('@/lib/company/other-account-hint', () => ({
  shouldShowOtherAccountHint: otherAccountHintMock,
}))

import {
  detectBackupFailing,
  detectBrokenBankConnections,
  detectExpiringBankConnections,
  detectNoFiscalYear,
  detectOtherAccountHint,
  detectSkvDisconnected,
  detectSkvUnexplained,
  expiringBankConnectionsFrom,
  skvAuthErrorNeedsReconnect,
  skvDataIsStale,
  skvStatusNeedsReconnect,
} from '../categories'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'
const USER = 'user-1'
const NOW = new Date('2026-08-19T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('expiringBankConnectionsFrom (pure day-math)', () => {
  const conn = (days: number | null) => ({
    id: 'c1',
    bank_name: 'SEB',
    consent_expires:
      days === null ? null : new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
  })

  it('includes a consent expiring in exactly 14 days', () => {
    expect(expiringBankConnectionsFrom([conn(14)], NOW)).toEqual([
      { id: 'c1', bank_name: 'SEB', days_left: 14 },
    ])
  })

  it('excludes a consent expiring in 15 days', () => {
    expect(expiringBankConnectionsFrom([conn(15)], NOW)).toEqual([])
  })

  it('excludes an already-expired consent (days_left <= 0): that is broken, not expiring', () => {
    expect(expiringBankConnectionsFrom([conn(-1)], NOW)).toEqual([])
  })

  it('excludes rows without a consent date', () => {
    expect(expiringBankConnectionsFrom([conn(null)], NOW)).toEqual([])
  })

  it('rounds partial days up (1 hour left = 1 day)', () => {
    const row = {
      id: 'c1',
      bank_name: 'SEB',
      consent_expires: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    }
    expect(expiringBankConnectionsFrom([row], NOW)).toEqual([
      { id: 'c1', bank_name: 'SEB', days_left: 1 },
    ])
  })
})

describe('skvStatusNeedsReconnect (pure)', () => {
  it('fires on needsReconsent', () => {
    expect(skvStatusNeedsReconnect({ connected: true, needsReconsent: true })).toBe(true)
  })
  it('fires on expired without refresh capability', () => {
    expect(skvStatusNeedsReconnect({ connected: true, expired: true, canRefresh: false })).toBe(true)
  })
  it('stays quiet when expired but refreshable', () => {
    expect(skvStatusNeedsReconnect({ connected: true, expired: true, canRefresh: true })).toBe(false)
  })
  it('stays quiet when not connected', () => {
    expect(skvStatusNeedsReconnect({ connected: false, needsReconsent: true })).toBe(false)
  })
  it('stays quiet when env-disabled', () => {
    expect(
      skvStatusNeedsReconnect({ connected: true, disabled: true, needsReconsent: true }),
    ).toBe(false)
  })
})

describe('skvDataIsStale (pure)', () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

  it('is false for data fetched within the week', () => {
    expect(skvDataIsStale(daysAgo(6), NOW)).toBe(false)
    expect(skvDataIsStale(daysAgo(0), NOW)).toBe(false)
  })
  it('is true past a week', () => {
    expect(skvDataIsStale(daysAgo(8), NOW)).toBe(true)
  })
  it('accepts ISO strings and epoch ms', () => {
    expect(skvDataIsStale(daysAgo(8).toISOString(), NOW)).toBe(true)
    expect(skvDataIsStale(daysAgo(8).getTime(), NOW)).toBe(true)
  })
  it('never invents a complaint from an unknown timestamp', () => {
    expect(skvDataIsStale(null, NOW)).toBe(false)
    expect(skvDataIsStale(undefined, NOW)).toBe(false)
    expect(skvDataIsStale('not a date', NOW)).toBe(false)
  })
})

describe('skvAuthErrorNeedsReconnect (pure)', () => {
  it('treats 401 with a non-NOT_CONNECTED code as reconnect', () => {
    expect(skvAuthErrorNeedsReconnect(401, 'SESSION_EXPIRED')).toBe(true)
    expect(skvAuthErrorNeedsReconnect(401, undefined)).toBe(true)
  })
  it('treats 401 NOT_CONNECTED as not-connected, not reconnect', () => {
    expect(skvAuthErrorNeedsReconnect(401, 'NOT_CONNECTED')).toBe(false)
  })
  it('never fires on non-401 statuses', () => {
    expect(skvAuthErrorNeedsReconnect(500, 'SESSION_EXPIRED')).toBe(false)
  })
})

describe('detectBrokenBankConnections', () => {
  it('returns null when no connection is broken', async () => {
    enqueue({ data: [] })
    await expect(detectBrokenBankConnections(supabase, COMPANY)).resolves.toBeNull()
    expect(findCall('bank_connections', 'in')).toEqual(['status', ['expired', 'error']])
  })

  it('shapes a single broken connection with its bank name', async () => {
    enqueue({ data: [{ id: 'c1', status: 'expired', bank_name: 'SEB' }] })
    const notice = await detectBrokenBankConnections(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: 'bank_connection_broken:c1=expired',
      category: 'bank_connection_broken',
      severity: 'error',
      messageKey: 'bank_broken_one',
      messageParams: { bank: 'SEB' },
      actionHref: '/settings/banking',
    })
  })

  it('uses the unnamed message variant when the single broken connection has no bank name', async () => {
    enqueue({ data: [{ id: 'c1', status: 'expired', bank_name: null }] })
    const notice = await detectBrokenBankConnections(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: 'bank_connection_broken:c1=expired',
      messageKey: 'bank_broken_one_unnamed',
    })
    expect(notice?.messageParams).toBeUndefined()
  })

  it('folds several broken connections into one counted notice with a bounded, stable id', async () => {
    const digest = createHash('sha256').update('c1=expired,c2=error').digest('hex').slice(0, 8)
    enqueue({
      data: [
        { id: 'c2', status: 'error', bank_name: 'Nordea' },
        { id: 'c1', status: 'expired', bank_name: 'SEB' },
      ],
    })
    const notice = await detectBrokenBankConnections(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: `bank_connection_broken:2@${digest}`,
      messageKey: 'bank_broken_many',
      messageParams: { count: 2 },
    })
  })

  it('keeps the id under 200 chars for 30 broken connections, stable across orderings', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `3f8b2c1a-0000-4000-8000-${String(i).padStart(12, '0')}`,
      status: i % 2 === 0 ? 'expired' : 'error',
      bank_name: null,
    }))
    enqueue({ data: rows })
    enqueue({ data: [...rows].reverse() })
    const first = await detectBrokenBankConnections(supabase, COMPANY)
    const second = await detectBrokenBankConnections(supabase, COMPANY)
    expect(first?.id).toBeDefined()
    expect(first?.id.length).toBeLessThan(200)
    expect(first?.id).toMatch(/^bank_connection_broken:30@[0-9a-f]{8}$/)
    expect(second?.id).toBe(first?.id)
  })

  it('soft-fails to null on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectBrokenBankConnections(supabase, COMPANY)).resolves.toBeNull()
  })
})

describe('detectExpiringBankConnections', () => {
  const expires = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString()

  it('only considers active connections (broken supersedes expiring)', async () => {
    enqueue({ data: [] })
    await detectExpiringBankConnections(supabase, COMPANY, NOW)
    expect(findCalls('bank_connections', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'active'],
    ])
  })

  it('discriminates the id on the consent date, not the ticking countdown', async () => {
    enqueue({ data: [{ id: 'c1', bank_name: 'SEB', consent_expires: expires }] })
    const notice = await detectExpiringBankConnections(supabase, COMPANY, NOW)
    expect(notice).toMatchObject({
      id: `bank_connection_expiring:c1=${expires}`,
      category: 'bank_connection_expiring',
      severity: 'warning',
      messageKey: 'bank_expiring_one',
      messageParams: { bank: 'SEB', days: 10 },
    })
  })

  it('collapses several expiring consents into a bounded digest id', async () => {
    enqueue({
      data: [
        { id: 'c1', bank_name: 'SEB', consent_expires: expires },
        { id: 'c2', bank_name: 'Nordea', consent_expires: expires },
      ],
    })
    const notice = await detectExpiringBankConnections(supabase, COMPANY, NOW)
    expect(notice?.id).toMatch(/^bank_connection_expiring:2@[0-9a-f]{8}$/)
    expect(notice).toMatchObject({ messageKey: 'bank_expiring_many', messageParams: { count: 2 } })
  })

  it('returns null when every consent is further out than 14 days', async () => {
    const far = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    enqueue({ data: [{ id: 'c1', bank_name: 'SEB', consent_expires: far }] })
    await expect(detectExpiringBankConnections(supabase, COMPANY, NOW)).resolves.toBeNull()
  })

  it('soft-fails to null on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectExpiringBankConnections(supabase, COMPANY, NOW)).resolves.toBeNull()
  })
})

describe('detectSkvDisconnected', () => {
  // The token row, plus (for the merely-expired path) the extension_data row
  // carrying the last successful skattekonto sync.
  function enqueueToken(row: Record<string, unknown>) {
    enqueue({
      data: {
        status: 'active',
        refresh_token: 'ciphertext',
        refresh_count: 0,
        last_error_at: null,
        last_error_code: null,
        ...row,
      },
    })
  }
  function enqueueLastSync(value: string | null) {
    enqueue({ data: value === null ? null : { value } })
  }
  const daysAgo = (days: number) =>
    new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  it('returns null when no token row exists (not connected)', async () => {
    enqueue({ data: null })
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('fires on a terminal needs_reconsent row, discriminated by the error timestamp', async () => {
    enqueueToken({
      status: 'needs_reconsent',
      expires_at: '2026-08-19T10:00:00Z',
      refresh_count: 1,
      last_error_at: '2026-08-18T03:00:00Z',
      last_error_code: 'MISSING_SCOPE',
    })
    const notice = await detectSkvDisconnected(supabase, USER, COMPANY, NOW)
    expect(notice).toMatchObject({
      id: 'skv_disconnected:needs_reconsent@2026-08-18T03:00:00Z',
      category: 'skv_disconnected',
      severity: 'warning',
      messageKey: 'skv_disconnected',
      actionHref: '/settings/tax',
    })
    expect(findCall('skatteverket_tokens', 'eq')).toEqual(['user_id', USER])
  })

  it('stays quiet on the hourly expiry while the data is fresh: the #2567 case', async () => {
    // Every connected company sits here between consents. Saying "the
    // connection needs renewing" about it daily is what made three reporters
    // think the integration was broken.
    enqueueToken({ expires_at: '2026-08-19T10:00:00Z', refresh_token: null })
    enqueueLastSync(daysAgo(1))
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('fires once the data has actually gone stale, with the honest message', async () => {
    enqueueToken({ expires_at: '2026-08-19T10:00:00Z', refresh_token: null })
    enqueueLastSync(daysAgo(9))
    const notice = await detectSkvDisconnected(supabase, USER, COMPANY, NOW)
    expect(notice).toMatchObject({
      id: `skv_disconnected:stale@${daysAgo(9)}`,
      category: 'skv_disconnected',
      severity: 'warning',
      messageKey: 'skv_session_expired',
      actionKey: 'skv_disconnected_action',
    })
  })

  it('falls back to the end of the last session when nothing ever synced', async () => {
    enqueueToken({ expires_at: daysAgo(30) })
    enqueueLastSync(null)
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toMatchObject({
      id: `skv_disconnected:stale@${daysAgo(30)}`,
      messageKey: 'skv_session_expired',
    })
  })

  it('reads a legacy SESSION_EXPIRED latch as an expired session, not a fault', async () => {
    // 97 of the 101 token rows touched in 30 days carried this latch on
    // 2026-08-26, all of them from ordinary hourly expiry.
    enqueueToken({
      status: 'needs_reconsent',
      expires_at: '2026-08-19T10:00:00Z',
      last_error_at: '2026-08-18T03:00:00Z',
      last_error_code: 'SESSION_EXPIRED',
    })
    enqueueLastSync(daysAgo(1))
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('fires on an expired token whose refresh budget is exhausted and whose data is stale', async () => {
    enqueueToken({ expires_at: '2026-08-19T10:00:00Z', refresh_count: 10 })
    enqueueLastSync(daysAgo(8))
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toMatchObject({
      category: 'skv_disconnected',
      messageKey: 'skv_session_expired',
    })
  })

  it('stays quiet while the token is expired but inside the refresh window', async () => {
    // Three minutes past access-token expiry: the 65-minute refresh token still works.
    enqueueToken({ expires_at: '2026-08-19T11:57:00Z', refresh_count: 3 })
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('stays quiet on a healthy, unexpired token', async () => {
    enqueueToken({ expires_at: '2026-08-19T14:00:00Z' })
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('soft-fails to null on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })

  it('does not invent staleness when the last-sync lookup fails', async () => {
    // The session ended 30 days ago, so the fallback WOULD read as stale. A
    // failed lookup is not evidence that nothing synced since, so the
    // detector soft-fails to no notice instead of warning on a guess.
    enqueueToken({ expires_at: daysAgo(30) })
    enqueue({ error: { message: 'boom' } })
    await expect(detectSkvDisconnected(supabase, USER, COMPANY, NOW)).resolves.toBeNull()
  })
})

describe('detectBackupFailing', () => {
  it('returns null when nothing is connected', async () => {
    enqueue({ data: [] })
    await expect(detectBackupFailing(supabase, COMPANY)).resolves.toBeNull()
  })

  it('returns null when connected backups are healthy', async () => {
    enqueue({
      data: [
        { key: 'google_drive_connection', value: { status: 'active' } },
        { key: 'google_drive_schedule', value: { last_auto_sync_status: 'success' } },
      ],
    })
    await expect(detectBackupFailing(supabase, COMPANY)).resolves.toBeNull()
  })

  it('fires the reauth message when every failing provider needs reauth', async () => {
    enqueue({
      data: [
        {
          key: 'google_drive_connection',
          value: { status: 'needs_reauth', needs_reauth_at: '2026-08-17T00:00:00Z' },
        },
      ],
    })
    const notice = await detectBackupFailing(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: 'backup_failing:google_drive=reauth',
      category: 'backup_failing',
      severity: 'error',
      messageKey: 'backup_reauth',
      messageParams: { provider: 'Google Drive' },
      actionHref: '/import#cloud-backup',
    })
  })

  it('keeps the id stable while the cron re-stamps last_auto_sync_at on the SAME incident', async () => {
    const failingRun = (stampedAt: string) => [
      { key: 'google_drive_connection', value: { status: 'active' } },
      {
        key: 'google_drive_schedule',
        value: { last_auto_sync_status: 'error', last_auto_sync_at: stampedAt },
      },
    ]
    enqueue({ data: failingRun('2026-08-18T02:00:00Z') })
    enqueue({ data: failingRun('2026-08-19T02:00:00Z') })
    const first = await detectBackupFailing(supabase, COMPANY)
    const second = await detectBackupFailing(supabase, COMPANY)
    expect(first?.id).toBe('backup_failing:google_drive=sync_error')
    expect(second?.id).toBe(first?.id)
  })

  it('folds two failing providers into ONE notice with both names and a sorted id', async () => {
    enqueue({
      data: [
        { key: 'google_drive_connection', value: { status: 'needs_reauth' } },
        { key: 'dropbox_connection', value: { status: 'active' } },
        {
          key: 'dropbox_schedule',
          value: { last_auto_sync_status: 'error', last_auto_sync_at: '2026-08-18T02:00:00Z' },
        },
      ],
    })
    const notice = await detectBackupFailing(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: 'backup_failing:dropbox=sync_error,google_drive=reauth',
      messageKey: 'backup_failing',
      messageParams: { provider: 'Google Drive + Dropbox' },
    })
  })

  it('ignores an errored schedule for a provider without a connection', async () => {
    enqueue({
      data: [{ key: 'dropbox_schedule', value: { last_auto_sync_status: 'error' } }],
    })
    await expect(detectBackupFailing(supabase, COMPANY)).resolves.toBeNull()
  })

  it('soft-fails to null on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectBackupFailing(supabase, COMPANY)).resolves.toBeNull()
  })
})

describe('detectOtherAccountHint', () => {
  it('shapes the hint as the lowest-priority notice when the detector fires', async () => {
    otherAccountHintMock.mockResolvedValue(true)
    await expect(detectOtherAccountHint(supabase, COMPANY)).resolves.toMatchObject({
      id: 'other_account_hint',
      category: 'other_account_hint',
      severity: 'warning',
    })
  })

  it('returns null when the detector stays quiet', async () => {
    otherAccountHintMock.mockResolvedValue(false)
    await expect(detectOtherAccountHint(supabase, COMPANY)).resolves.toBeNull()
  })

  it('soft-fails to null when the detector throws', async () => {
    otherAccountHintMock.mockRejectedValue(new Error('boom'))
    await expect(detectOtherAccountHint(supabase, COMPANY)).resolves.toBeNull()
  })
})

describe('never-throws contract', () => {
  it('every predicate resolves null when the client itself throws', async () => {
    const throwing = {
      from: () => {
        throw new Error('client exploded')
      },
    } as unknown as SupabaseClient
    otherAccountHintMock.mockRejectedValue(new Error('client exploded'))
    await expect(detectBrokenBankConnections(throwing, COMPANY)).resolves.toBeNull()
    await expect(detectExpiringBankConnections(throwing, COMPANY, NOW)).resolves.toBeNull()
    await expect(detectSkvDisconnected(throwing, USER, COMPANY, NOW)).resolves.toBeNull()
    await expect(detectBackupFailing(throwing, COMPANY)).resolves.toBeNull()
    await expect(detectOtherAccountHint(throwing, COMPANY)).resolves.toBeNull()
    await expect(detectNoFiscalYear(throwing, COMPANY)).resolves.toBeNull()
  })
})

describe('detectNoFiscalYear', () => {
  // The state a migration reset leaves behind: the replacement company has a
  // chart and its settings but no fiscal period, and its owner may book by
  // hand instead of importing again.
  it('points a company without any fiscal period at the fiscal year settings', async () => {
    enqueue({ data: null, count: 0 })
    await expect(detectNoFiscalYear(supabase, COMPANY)).resolves.toEqual({
      id: 'no_fiscal_year:0',
      category: 'no_fiscal_year',
      severity: 'warning',
      messageKey: 'no_fiscal_year',
      actionKey: 'no_fiscal_year_action',
      actionHref: '/settings/bookkeeping',
    })
    expect(findCall('fiscal_periods', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('stays quiet once any fiscal period exists', async () => {
    enqueue({ data: null, count: 1 })
    await expect(detectNoFiscalYear(supabase, COMPANY)).resolves.toBeNull()
  })

  it('never reads a failed or missing count as "no fiscal year"', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectNoFiscalYear(supabase, COMPANY)).resolves.toBeNull()
    reset()
    enqueue({ data: null, count: null })
    await expect(detectNoFiscalYear(supabase, COMPANY)).resolves.toBeNull()
  })
})

describe('detectSkvUnexplained', () => {
  const latest = (unexplained: number | null, external: number | null = 1000) => ({
    key: 'skattekonto_reconciliation_latest',
    value: {
      as_of: '2026-08-19T04:00:00Z',
      computed_at: '2026-08-19T04:00:05Z',
      external_balance: external,
      ledger_balance: 900,
      unexplained_difference: unexplained,
      counts: { proposed: 0, unmatched_external: 1, unmatched_ledger: 0 },
    },
  })

  it('returns null without a persisted summary or within tolerance', async () => {
    enqueue({ data: [] })
    await expect(detectSkvUnexplained(supabase, COMPANY)).resolves.toBeNull()
    reset()
    enqueue({ data: [latest(0.4)] })
    await expect(detectSkvUnexplained(supabase, COMPANY)).resolves.toBeNull()
  })

  it('surfaces the unexplained amount with a whole-krona discriminator and the reconciliation link', async () => {
    enqueue({ data: [latest(-1234.56)] })
    const notice = await detectSkvUnexplained(supabase, COMPANY)
    expect(notice).toMatchObject({
      id: 'skv_unexplained:-1235',
      category: 'skv_unexplained',
      severity: 'warning',
      messageKey: 'skv_unexplained',
      actionKey: 'skv_unexplained_action',
      actionHref: '/reconciliation?account=skattekonto',
    })
    expect(String(notice?.messageParams?.amount)).toMatch(/1.?234/)
    expect(mockSupabase.from).toHaveBeenCalledWith('extension_data')
  })

  it('honours the configured drift tolerance', async () => {
    enqueue({ data: [latest(40), { key: 'skattekonto_drift_tolerance', value: 50 }] })
    await expect(detectSkvUnexplained(supabase, COMPANY)).resolves.toBeNull()
  })

  it('soft-fails to null on a query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(detectSkvUnexplained(supabase, COMPANY)).resolves.toBeNull()
  })
})
