import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({ loadCompanyCapabilities: vi.fn() }))
vi.mock('@/lib/modules/capabilities', () => ({
  loadCompanyCapabilities: (...args: unknown[]) => mocks.loadCompanyCapabilities(...args),
}))

import { createLogger } from '@/lib/logger'
import { runScheduledSuggestions, weekdayBucket } from '../sweep'
import type { Detector } from '../types'

const NOW = new Date('2026-10-16T02:30:00.000Z') // a Friday: bucket 5

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('runScheduledSuggestions', () => {
  it('reads nothing while SUGGESTIONS_HIDE_UNUSED is unset (the default)', async () => {
    vi.stubEnv('SUGGESTIONS_HIDE_UNUSED', '')
    const mock = createTableMockSupabase()
    expect(await runScheduledSuggestions(mock.supabase as never, createLogger('test'), { now: NOW })).toEqual({
      ran: false,
      companies: 0,
      staged: 0,
      skipped_full: 0,
      stopped_early: false,
    })
    expect(mock.calls).toHaveLength(0)
  })

  it('takes today\'s bucket only, skips companies already showing three, and stages at most one per company', async () => {
    const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10', 'k11', 'l12', 'm13', 'n14']
    const todays = ids.filter((id) => weekdayBucket(id) === NOW.getUTCDay())
    expect(todays.length).toBeGreaterThan(0)
    const mock = createTableMockSupabase({
      companies: { data: ids.map((id) => ({ id })) },
      company_suggestions: (chain) => {
        const companyId = chain.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1]
        return { count: companyId === todays[0] ? 3 : 0 }
      },
      company_members: { data: [{ user_id: 'owner-1' }] },
      'rpc:stage_company_suggestion': { data: { staged: true, suggestion_id: 's', pending_operation_id: 'p' } },
    })
    const proposals: Detector<{ n: number }> = {
      id: 'hide-unused',
      trigger: { kind: 'schedule', cadence: 'daily' },
      subjects: () => [{ n: 1 }, { n: 2 }],
      condition: async () => true,
      propose: (s) => ({ key: `disable_package:p${s.n}`, operationType: 'disable_package', params: { package_id: 'assets' }, title: 't', reason: 'r', rank: 10 }),
    }
    const summary = await runScheduledSuggestions(mock.supabase as never, createLogger('test'), {
      now: NOW,
      detectors: [proposals as Detector<unknown>],
    })
    expect(summary).toEqual({ ran: true, companies: todays.length, staged: todays.length - 1, skipped_full: 1, stopped_early: false })
    const staged = mock.findCalls('rpc:stage_company_suggestion', 'rpc').map((args) => (args[0] as { p_company_id: string }).p_company_id)
    expect(staged).toEqual(todays.slice(1))
    expect(mock.findCall('companies', 'is')).toEqual(['archived_at', null])
  })

  it('stops at the time budget and says so', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `company-${i}`)
    const mock = createTableMockSupabase({
      companies: { data: ids.map((id) => ({ id })) },
      company_suggestions: { count: 0 },
      company_members: { data: [{ user_id: 'owner-1' }] },
    })
    let now = 0
    const detector: Detector<number> = {
      id: 'hide-unused',
      trigger: { kind: 'schedule', cadence: 'daily' },
      subjects: () => {
        now += 10_000
        return []
      },
      condition: async () => false,
      propose: () => { throw new Error('never') },
    }
    const summary = await runScheduledSuggestions(mock.supabase as never, createLogger('test'), {
      now: NOW,
      detectors: [detector as Detector<unknown>],
      timeBudgetMs: 25_000,
      clock: () => now,
    })
    expect(summary.stopped_early).toBe(true)
    expect(summary.companies).toBe(3)
  })

  it('gives every company one stable weekday', () => {
    expect(weekdayBucket('c0000000-0000-4000-8000-000000000001')).toBe(weekdayBucket('c0000000-0000-4000-8000-000000000001'))
    const buckets = new Set(Array.from({ length: 200 }, (_, i) => weekdayBucket(`company-${i}`)))
    expect([...buckets].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
