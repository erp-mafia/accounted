import { describe, expect, it } from 'vitest'
import { daysUntilConsentExpiry, getChipState } from '../bank-sync-chip-state'

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
    expect(getChipState([], NOW)).toEqual({ kind: 'none' })
  })

  it('reads healthy for a recent sync with a distant consent', () => {
    expect(getChipState([row()], NOW)).toEqual({ kind: 'healthy', mostRecent: at(-2 * HOUR_MS) })
  })

  it('warns when a live consent ends within seven days', () => {
    expect(getChipState([row({ consent_expires: at(7 * DAY_MS) })], NOW)).toEqual({
      kind: 'expiring',
      daysLeft: 7,
      count: 1,
    })
  })

  it('stays quiet at eight days', () => {
    expect(getChipState([row({ consent_expires: at(8 * DAY_MS) })], NOW).kind).toBe('healthy')
  })

  it('reports the soonest expiry and how many are affected', () => {
    const state = getChipState(
      [
        row({ id: 'a', consent_expires: at(5 * DAY_MS) }),
        row({ id: 'b', consent_expires: at(2 * DAY_MS) }),
        row({ id: 'c', consent_expires: at(30 * DAY_MS) }),
      ],
      NOW,
    )
    expect(state).toEqual({ kind: 'expiring', daysLeft: 2, count: 2 })
  })

  it('ranks a dead connection above an expiring one', () => {
    const state = getChipState(
      [
        row({ id: 'a', status: 'expired' }),
        row({ id: 'b', consent_expires: at(1 * DAY_MS) }),
      ],
      NOW,
    )
    expect(state).toEqual({ kind: 'attention', count: 1 })
  })

  it('ranks expiring above stale: the deadline matters more than the age', () => {
    const state = getChipState(
      [row({ last_synced_at: at(-3 * DAY_MS), consent_expires: at(3 * DAY_MS) })],
      NOW,
    )
    expect(state.kind).toBe('expiring')
  })

  it('ignores the consent on rows that are not live yet', () => {
    const state = getChipState(
      [row({ status: 'pending_selection', consent_expires: at(1 * DAY_MS), last_synced_at: null })],
      NOW,
    )
    expect(state).toEqual({ kind: 'healthy', mostRecent: null })
  })

  it('reads stale after 36 hours without a sync', () => {
    expect(getChipState([row({ last_synced_at: at(-37 * HOUR_MS) })], NOW)).toEqual({
      kind: 'stale',
      mostRecent: at(-37 * HOUR_MS),
    })
  })

  it('tolerates rows without the consent column', () => {
    const state = getChipState([{ id: 'x', status: 'active', last_synced_at: at(-HOUR_MS) }], NOW)
    expect(state.kind).toBe('healthy')
  })
})
