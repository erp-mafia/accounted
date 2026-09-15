import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { assessLegacySIEImport } from '../sie-legacy-recovery'
import type { SupabaseClient } from '@supabase/supabase-js'

const db = createQueuedMockSupabase()
const legacy = {
  id: 'import-1', status: 'failed', job_state: null, fiscal_period_id: 'period-1',
  fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', file_storage_path: null,
}
const period = {
  id: 'period-1', period_start: '2026-01-01', period_end: '2026-12-31',
  is_closed: false, locked_at: null, import_hold: null,
}
const settings = { bookkeeping_locked_through: null }
const assess = () => assessLegacySIEImport(db.supabase as unknown as SupabaseClient, 'company-1', 'import-1')

describe('legacy SIE recovery assessment', () => {
  beforeEach(() => db.reset())

  it('returns no assessment for a missing or inaccessible import', async () => {
    db.enqueue({ data: null })
    expect(await assess()).toBeNull()
    expect(db.findCalls('sie_imports', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(db.calls.every(call => call.table === 'sie_imports')).toBe(true)
  })

  it('keeps tracked jobs on the existing job path', async () => {
    db.enqueue({ data: { ...legacy, job_state: 'failed' } })
    await expect(assess()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each(['failed', 'pending', 'mapped', 'completed', 'undone', 'replaced', 'timed_out'])(
    'does not infer voucher ownership or authorize recovery from status %s', async status => {
      db.enqueueMany([
        { data: { ...legacy, status } }, { data: period }, { data: settings },
        { count: 6_850 }, { count: 6_848 }, { count: 6_849 },
      ])
      const result = await assess()
      expect(result).toMatchObject({
        status, periodResolution: 'linked', hasArchiveReference: false,
        entries: { all: 6_850, posted: 6_848, importOrOpening: 6_849 },
      })
      expect(result).not.toHaveProperty('canUndo')
      expect(result).not.toHaveProperty('canReset')
      for (const table of ['sie_imports', 'fiscal_periods', 'company_settings', 'journal_entries']) {
        expect(db.findCalls(table, 'eq')).toContainEqual(['company_id', 'company-1'])
      }
      expect(db.findCalls('journal_entries', 'eq').filter(args => args[0] === 'company_id')).toHaveLength(3)
      expect(db.findCalls('journal_entries', 'select')).toEqual(Array(3).fill(['id', { count: 'exact', head: true }]))
      expect(db.calls.some(call => ['insert', 'update', 'delete', 'upsert'].includes(call.method))).toBe(false)
      expect(db.supabase.rpc).not.toHaveBeenCalled()
    },
  )

  it('resolves a null period ID only by exact company and year dates', async () => {
    db.enqueueMany([
      { data: { ...legacy, fiscal_period_id: null } }, { data: [period] }, { data: settings },
      { count: 0 }, { count: 0 }, { count: 0 },
    ])
    const result = await assess()
    expect(result).toMatchObject({ periodResolution: 'exact_dates', entries: { all: 0 } })
    expect(db.findCalls('fiscal_periods', 'eq')).toEqual([
      ['company_id', 'company-1'], ['period_start', '2026-01-01'], ['period_end', '2026-12-31'],
    ])
    expect(db.findCall('fiscal_periods', 'limit')).toEqual([2])
    expect(result).not.toHaveProperty('canRetry')
  })

  it.each([
    { matches: [], resolution: 'missing' },
    { matches: [period, { ...period, id: 'period-2' }], resolution: 'ambiguous' },
  ])('leaves $resolution period evidence unknown, not empty', async ({ matches, resolution }) => {
    db.enqueueMany([{ data: { ...legacy, fiscal_period_id: null } }, { data: matches }, { data: settings }])
    expect(await assess()).toMatchObject({ periodResolution: resolution, period: null, entries: null })
    expect(db.findCalls('journal_entries', 'select')).toHaveLength(0)
  })

  it('does not fall back to dates when a saved period ID is inaccessible', async () => {
    db.enqueueMany([{ data: legacy }, { data: null }, { data: settings }])
    expect(await assess()).toMatchObject({ periodResolution: 'missing', entries: null })
    expect(db.findCalls('fiscal_periods', 'select')).toHaveLength(1)
  })

  it('does not select a year when the saved ID contradicts the dates', async () => {
    db.enqueueMany([{ data: legacy }, { data: { ...period, period_end: '2027-06-30' } }, { data: settings }])
    expect(await assess()).toMatchObject({ periodResolution: 'conflicting', period: null, entries: null })
  })

  it('does not guess a year from an incomplete date range', async () => {
    db.enqueueMany([{ data: { ...legacy, fiscal_period_id: null, fiscal_year_end: null } }, { data: settings }])
    expect(await assess()).toMatchObject({ periodResolution: 'missing', entries: null })
    expect(db.findCalls('fiscal_periods', 'select')).toHaveLength(0)
  })

  it('preserves locks and holds as observations without declaring repair eligibility', async () => {
    db.enqueueMany([
      { data: { ...legacy, file_storage_path: 'archived.se' } },
      { data: { ...period, is_closed: true, locked_at: '2026-09-01', import_hold: 'another-job' } },
      { data: { bookkeeping_locked_through: '2026-08-31' } }, { count: 1 }, { count: 1 }, { count: 1 },
    ])
    expect(await assess()).toMatchObject({
      hasArchiveReference: true, period: { is_closed: true, locked_at: '2026-09-01', import_hold: 'another-job' },
      companyLock: { known: true, through: '2026-08-31' },
    })
  })

  it('does not interpret missing company settings as proof of no lock', async () => {
    db.enqueueMany([{ data: { ...legacy, fiscal_period_id: null, fiscal_year_end: null } }, { data: null }])
    expect(await assess()).toMatchObject({ companyLock: { known: false, through: null } })
  })

  it.each([0, 1, 2, 3, 4, 5])('fails closed when query %s fails', async failureIndex => {
    const results = [{ data: legacy }, { data: period }, { data: settings }, { count: 0 }, { count: 0 }, { count: 0 }]
    const error = { code: '57014', message: 'statement timeout' }
    db.enqueueMany(results.map((result, index) => index === failureIndex ? { error } : result))
    await expect(assess()).rejects.toEqual(error)
  })

  it('does not turn an unavailable count into zero', async () => {
    db.enqueueMany([{ data: legacy }, { data: period }, { data: settings }, { count: null }, { count: 0 }, { count: 0 }])
    await expect(assess()).rejects.toThrow('count is unavailable')
  })
})
