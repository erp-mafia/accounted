import { describe, expect, it } from 'vitest'
import { planBankSyncRun, SYNC_DUE_AFTER_MS } from '../cron-plan'

const NOW = Date.parse('2026-09-02T05:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const ENTITLED = new Set(['paid'])

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'paid',
    last_synced_at: null as string | null,
    sync_lease_until: '1970-01-01T00:00:00.000Z',
    accounts_data: [{ uid: 'acc', enabled: true }],
    ...overrides,
  }
}

describe('planBankSyncRun', () => {
  it('takes never-synced connections first, then the oldest sync', () => {
    const plan = planBankSyncRun(
      [
        row('old', { last_synced_at: ago(30 * HOUR_MS) }),
        row('never-b'),
        row('oldest', { last_synced_at: ago(80 * HOUR_MS) }),
        row('never-a'),
      ],
      ENTITLED,
      NOW,
      300,
    )

    expect(plan.selected.map(c => c.id)).toEqual(['never-a', 'never-b', 'oldest', 'old'])
  })

  it('keeps a connection on its hour: due one hour short of a day', () => {
    // Synced at 05:03 yesterday, the 05:00 run must take it. A 24h threshold
    // would push it to 06:00, and an hour later again every day after.
    const syncedYesterday = ago(24 * HOUR_MS - 3 * 60 * 1000)
    const plan = planBankSyncRun([row('daily', { last_synced_at: syncedYesterday })], ENTITLED, NOW, 300)

    expect(plan.stats).toMatchObject({ due: 1, fresh: 0 })
    expect(SYNC_DUE_AFTER_MS).toBeLessThan(24 * HOUR_MS)
  })

  it('does not take a connection twice in a day', () => {
    const plan = planBankSyncRun([row('fresh', { last_synced_at: ago(22 * HOUR_MS) })], ENTITLED, NOW, 300)

    expect(plan.selected).toEqual([])
    expect(plan.stats).toMatchObject({ fresh: 1, due: 0 })
  })

  it('excludes companies without the bank_sync grant, and says so', () => {
    const plan = planBankSyncRun([row('free', { company_id: 'free' }), row('paid')], ENTITLED, NOW, 300)

    expect(plan.selected.map(c => c.id)).toEqual(['paid'])
    expect(plan.stats).toMatchObject({ eligible: 1, notEntitled: 1 })
  })

  it('applies the batch limit after every exclusion and counts what it deferred', () => {
    const rows = [
      row('free', { company_id: 'free' }),
      row('a', { last_synced_at: ago(50 * HOUR_MS) }),
      row('b', { last_synced_at: ago(40 * HOUR_MS) }),
      row('c', { last_synced_at: ago(30 * HOUR_MS) }),
    ]
    const plan = planBankSyncRun(rows, ENTITLED, NOW, 2)

    expect(plan.selected.map(c => c.id)).toEqual(['a', 'b'])
    expect(plan.stats).toMatchObject({ due: 3, selected: 2, deferredByBatchLimit: 1 })
  })

  it('keeps a held lease out of the batch but in the overdue age', () => {
    const plan = planBankSyncRun(
      [row('cooling', { last_synced_at: ago(47 * HOUR_MS), sync_lease_until: ago(-2 * HOUR_MS) })],
      ENTITLED,
      NOW,
      300,
    )

    expect(plan.selected).toEqual([])
    expect(plan.stats).toMatchObject({ coolingDown: 1, due: 0, oldestOverdueHours: 24 })
  })

  it('puts every connection in exactly one bucket', () => {
    const rows = [
      row('free', { company_id: 'free' }),
      row('no-accounts', { accounts_data: [{ uid: 'acc', enabled: false }] }),
      row('fresh', { last_synced_at: ago(HOUR_MS) }),
      row('cooling', { sync_lease_until: ago(-HOUR_MS) }),
      row('due'),
    ]
    const { stats } = planBankSyncRun(rows, ENTITLED, NOW, 300)

    expect(stats.notEntitled + stats.noAccounts + stats.fresh + stats.coolingDown + stats.due).toBe(rows.length)
  })
})
