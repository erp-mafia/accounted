import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  getLedgerMode,
  canPublishToHosted,
  isHybridLedgerMode,
} from '@/lib/obx/ledger-mode'
import {
  nextBusinessDay,
  endOfFollowingMonth,
  evaluateBflTiming,
  daysBetween,
} from '@/lib/bookkeeping/bfl-timing'

describe('ledger-mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to hosted when not self-hosted', () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    expect(getLedgerMode()).toBe('hosted')
  })

  it('defaults to local when self-hosted without mode', () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(getLedgerMode()).toBe('local')
  })

  it('respects explicit hybrid and publish config', () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', 'hybrid')
    vi.stubEnv('OMBRA_HOSTED_BOOKS_URL', 'https://books.example.com')
    vi.stubEnv('OMBRA_HOSTED_API_KEY', 'gnubok_sk_test')
    expect(isHybridLedgerMode()).toBe(true)
    expect(canPublishToHosted()).toBe(true)
  })

  it('requires both URL and key for publish', () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', 'hybrid')
    vi.stubEnv('OMBRA_HOSTED_BOOKS_URL', 'https://books.example.com')
    vi.stubEnv('OMBRA_HOSTED_API_KEY', '')
    expect(canPublishToHosted()).toBe(false)
  })
})

describe('bfl-timing', () => {
  it('computes next business day over weekends', () => {
    expect(nextBusinessDay('2026-07-17')).toBe('2026-07-20') // Fri → Mon
  })

  it('computes end of following month', () => {
    expect(endOfFollowingMonth('2026-01-15')).toBe('2026-02-28')
  })

  it('blocks late cash', () => {
    const issue = evaluateBflTiming({
      entryDate: '2026-07-14',
      bookedOn: '2026-07-17',
      kind: 'cash',
    })
    expect(issue?.severity).toBe('block')
    expect(issue?.code).toBe('CASH_LATE')
  })

  it('blocks other after 50 days', () => {
    expect(daysBetween('2026-01-01', '2026-03-01')).toBeGreaterThan(50)
    const issue = evaluateBflTiming({
      entryDate: '2026-01-01',
      bookedOn: '2026-03-01',
      kind: 'other',
    })
    expect(issue?.severity).toBe('block')
    expect(issue?.code).toBe('OTHER_OVER_50_DAYS')
  })

  it('warns when past following month but under 50 days', () => {
    const issue = evaluateBflTiming({
      entryDate: '2026-01-01',
      bookedOn: '2026-03-05',
      kind: 'other',
    })
    // 63 days → block takes precedence
    expect(issue?.code).toBe('OTHER_OVER_50_DAYS')

    const warn = evaluateBflTiming({
      entryDate: '2026-01-20',
      bookedOn: '2026-03-05',
      kind: 'other',
    })
    // Jan 20 → following month end Feb 28; Mar 5 is late but ~44 days
    expect(warn?.severity).toBe('warn')
    expect(warn?.code).toBe('OTHER_PAST_FOLLOWING_MONTH')
  })
})
