import { describe, expect, it } from 'vitest'
import { daysUntilConsentExpiry, getChipState } from '../bank-sync-chip-state'
import { isSyncedAccount } from '@/lib/bank-sync/mirror-card-account'

const NOW = Date.parse('2026-09-02T08:00:00Z')
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString()

function row(overrides: Partial<Parameters<typeof getChipState>[0][number]> = {}) {
  return {
    id: 'conn-1',
    status: 'active',
    last_synced_at: at(-2 * HOUR_MS),
    consent_expires: at(60 * DAY_MS),
    fetchesAccounts: true,
    ...overrides,
  }
}

describe('daysUntilConsentExpiry', () => {
  it('rounds a partial day up so "1 day left" never reads as 0', () => {
    expect(daysUntilConsentExpiry(at(0.4 * DAY_MS), NOW)).toBe(1)
    expect(daysUntilConsentExpiry(at(6.5 * DAY_MS), NOW)).toBe(7)
  })

  it('floors at zero once the consent has passed', () => {
    expect(daysUntilConsentExpiry(at(-3 * DAY_MS), NOW)).toBe(0)
  })

  it('is null without a usable timestamp', () => {
    expect(daysUntilConsentExpiry(null, NOW)).toBeNull()
    expect(daysUntilConsentExpiry(undefined, NOW)).toBeNull()
    expect(daysUntilConsentExpiry('nope', NOW)).toBeNull()
  })
})

describe('getChipState', () => {
  it('is hidden without connections', () => {
    expect(getChipState([], { now: NOW })).toEqual({ kind: 'none' })
  })

  it('reads healthy for a recent sync with a distant consent', () => {
    expect(getChipState([row()], { now: NOW })).toEqual({ kind: 'healthy', mostRecent: at(-2 * HOUR_MS) })
  })

  it('warns when a live consent ends within seven days', () => {
    expect(getChipState([row({ consent_expires: at(7 * DAY_MS) })], { now: NOW })).toEqual({
      kind: 'expiring',
      daysLeft: 7,
      count: 1,
    })
  })

  it('stays quiet at eight days', () => {
    expect(getChipState([row({ consent_expires: at(8 * DAY_MS) })], { now: NOW }).kind).toBe('healthy')
  })

  it('reports the soonest expiry and how many are affected', () => {
    const state = getChipState(
      [
        row({ id: 'a', consent_expires: at(5 * DAY_MS) }),
        row({ id: 'b', consent_expires: at(2 * DAY_MS) }),
        row({ id: 'c', consent_expires: at(30 * DAY_MS) }),
      ],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'expiring', daysLeft: 2, count: 2 })
  })

  it('ranks a dead connection above an expiring one', () => {
    const state = getChipState(
      [
        row({ id: 'a', status: 'expired' }),
        row({ id: 'b', consent_expires: at(1 * DAY_MS) }),
      ],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'attention', count: 1 })
  })

  it('ranks expiring above stale: the deadline matters more than the age', () => {
    const state = getChipState(
      [row({ last_synced_at: at(-3 * DAY_MS), consent_expires: at(3 * DAY_MS) })],
      { now: NOW },
    )
    expect(state.kind).toBe('expiring')
  })

  it('ignores the consent on rows that are not live yet', () => {
    const state = getChipState(
      [row({ status: 'pending_selection', consent_expires: at(1 * DAY_MS), last_synced_at: null })],
      { now: NOW },
    )
    // Never 'expiring': the consent of a row that syncs nothing is not the
    // thing to warn about. It is not 'healthy' either (see below).
    expect(state.kind).not.toBe('expiring')
  })

  it('says accounts must be chosen when a connection waits for account selection', () => {
    // Authorized at the bank, picker never saved: the cron and the sync route
    // both skip the row, so it used to read as 'healthy' while syncing nothing.
    const state = getChipState(
      [row({ id: 'waiting', status: 'pending_selection', last_synced_at: null })],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'selection', connectionId: 'waiting', aggregator: null, count: 1 })
  })

  it('ignores revoked rows next to the waiting one (a superseded earlier attempt)', () => {
    const state = getChipState(
      [
        row({ id: 'old', status: 'revoked', last_synced_at: null }),
        row({ id: 'waiting', status: 'pending_selection', last_synced_at: null }),
      ],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'selection', connectionId: 'waiting', aggregator: null, count: 1 })
  })

  it('keeps a dead connection ahead of a waiting one: only BankID fixes that', () => {
    const state = getChipState(
      [row({ id: 'dead', status: 'expired' }), row({ id: 'waiting', status: 'pending_selection' })],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'attention', count: 1 })
  })

  it('carries the waiting row\'s aggregator, so the chip links an Open Payments row to Koppla banken', () => {
    const state = getChipState(
      [row({ id: 'op', status: 'pending_selection', last_synced_at: null, aggregator: 'open_payments' })],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'selection', connectionId: 'op', aggregator: 'open_payments', count: 1 })
  })

  it('does not ask for account selection on a consent that already lapsed', () => {
    const state = getChipState(
      [row({ status: 'pending_selection', consent_expires: at(-1 * DAY_MS), last_synced_at: null })],
      { now: NOW },
    )
    expect(state.kind).not.toBe('selection')
  })

  it('stays paused without the bank_sync capability even with a waiting row', () => {
    const state = getChipState(
      [row({ status: 'pending_selection', last_synced_at: null })],
      { now: NOW, hasBankSync: false },
    )
    expect(state).toEqual({ kind: 'paused' })
  })

  it('reads stale after 36 hours without a sync', () => {
    expect(getChipState([row({ last_synced_at: at(-37 * HOUR_MS) })], { now: NOW })).toEqual({
      kind: 'stale',
      lastSynced: at(-37 * HOUR_MS),
    })
  })

  it('reads stale when one active connection has stopped, although another syncs', () => {
    // The newest sync across all rows used to decide: a connection stuck on a
    // bank that keeps answering unavailable stayed hidden behind a healthy one.
    const state = getChipState(
      [
        row({ id: 'healthy', last_synced_at: at(-2 * HOUR_MS) }),
        row({ id: 'stuck', last_synced_at: at(-5 * DAY_MS) }),
        row({ id: 'stuck-longer', last_synced_at: at(-9 * DAY_MS) }),
      ],
      { now: NOW },
    )
    // The age shown is the one that has waited longest.
    expect(state).toEqual({ kind: 'stale', lastSynced: at(-9 * DAY_MS) })
  })

  it('never reads a revoked or superseded row as stale: its last sync time is frozen for good', () => {
    const state = getChipState(
      [
        row({ id: 'old', status: 'revoked', last_synced_at: at(-40 * DAY_MS) }),
        row({ id: 'new', last_synced_at: at(-2 * HOUR_MS) }),
      ],
      { now: NOW },
    )
    expect(state).toEqual({ kind: 'healthy', mostRecent: at(-2 * HOUR_MS) })
  })

  it('never reads a connection the syncs skip by design as stale: nothing to fetch, so its last sync never moves', () => {
    // Every account switched off, or only a mirror card account (the caller
    // works it out with isSyncedAccount): the chip would stay on for good
    // beside a connection that syncs.
    const healthy = row({ id: 'healthy', last_synced_at: at(-2 * HOUR_MS) })
    const idle = row({ id: 'idle', last_synced_at: at(-27 * DAY_MS), fetchesAccounts: false })
    expect(getChipState([healthy, idle], { now: NOW })).toEqual({ kind: 'healthy', mostRecent: at(-2 * HOUR_MS) })
    const fetching = row({ id: 'fetching', last_synced_at: at(-27 * DAY_MS), fetchesAccounts: true })
    expect(getChipState([healthy, fetching], { now: NOW })).toEqual({ kind: 'stale', lastSynced: at(-27 * DAY_MS) })
  })

  it('works out what to fetch with the rule the syncs and crons use', () => {
    // The chip passes fetchesAccounts from this rule (BankSyncStatusChip).
    expect([{ uid: 'A', enabled: false }].some(isSyncedAccount)).toBe(false)
    expect([{ uid: 'M', name: 'BOKIO_Debit_Business', iban: null, bban: null }].some(isSyncedAccount)).toBe(false)
    expect([{ uid: 'A', enabled: false }, { uid: 'B' }].some(isSyncedAccount)).toBe(true)
  })

  it('does not call a connection that has not synced yet stale', () => {
    const state = getChipState(
      [row({ id: 'new', last_synced_at: null }), row({ id: 'healthy', last_synced_at: at(-2 * HOUR_MS) })],
      { now: NOW },
    )
    expect(state.kind).toBe('healthy')
  })

  it('reads paused when the company lacks the bank_sync entitlement', () => {
    // 56 of 191 active connections on prod sat in this state on 2026-09-01:
    // the cron skips them, so they are neither dead nor merely stale.
    const state = getChipState([row({ last_synced_at: at(-20 * DAY_MS) })], {
      now: NOW,
      hasBankSync: false,
    })
    expect(state).toEqual({ kind: 'paused' })
  })

  it('ranks paused above a dead connection: renewing without a subscription changes nothing', () => {
    const state = getChipState([row({ status: 'expired' })], { now: NOW, hasBankSync: false })
    expect(state).toEqual({ kind: 'paused' })
  })

  it('stays hidden without connections even when unentitled', () => {
    expect(getChipState([], { now: NOW, hasBankSync: false })).toEqual({ kind: 'none' })
  })

  it('tolerates rows without the consent column', () => {
    const state = getChipState([{ id: 'x', status: 'active', last_synced_at: at(-HOUR_MS) }], { now: NOW })
    expect(state.kind).toBe('healthy')
  })
})
