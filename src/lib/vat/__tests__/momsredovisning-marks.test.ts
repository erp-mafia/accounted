import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const periodStatus = vi.hoisted(() => ({ resolvePeriodStatusForDate: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/period-status', () => periodStatus)

const filings = vi.hoisted(() => ({ listVatFilings: vi.fn() }))
vi.mock('../filing-record-store', () => filings)

import { listMarkedInPeriod, markNotMomsredovisning, withdrawNotMomsredovisning } from '../momsredovisning-marks'

const ENTRY = { id: 'entry-1', status: 'posted', source_type: 'manual', entry_date: '2026-09-30', reverses_id: null }
const Q3_FILED = { period_start: '2026-07-01', period_end: '2026-09-30' }

/** The session reads (entry, latest mark); the service-role writer records the mark. */
function setup(options: {
  entry?: Record<string, unknown> | null
  latestMark?: 'not_momsredovisning' | 'withdrawn' | null
} = {}) {
  const session = createTableMockSupabase()
  session.setTable('journal_entries', { data: options.entry === undefined ? ENTRY : options.entry })
  session.setTable('vat_momsredovisning_marks', { data: options.latestMark ? [{ action: options.latestMark }] : [] })
  const writer = createTableMockSupabase()
  writer.setTable('vat_momsredovisning_marks', { data: null })
  return {
    supabase: session.supabase as unknown as SupabaseClient,
    writer: writer.supabase as unknown as SupabaseClient,
    sessionInserts: () => session.payloads('vat_momsredovisning_marks', 'insert'),
    inserts: () => writer.payloads('vat_momsredovisning_marks', 'insert'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  periodStatus.resolvePeriodStatusForDate.mockResolvedValue({ period_id: 'p1', status: 'open', lock_date: null })
  filings.listVatFilings.mockResolvedValue([])
})

describe('markNotMomsredovisning (crm#1849)', () => {
  it('records the mark through the server as the person, for a posted verifikat in an open, unfiled period', async () => {
    const s = setup()
    const result = await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')
    expect(result).toEqual({ ok: true, data: { journal_entry_id: 'entry-1', marked: true, changed: true } })
    expect(s.inserts()).toEqual([
      { company_id: 'company-1', journal_entry_id: 'entry-1', action: 'not_momsredovisning', actor: 'user-1' },
    ])
    // The person's session never writes the mark itself.
    expect(s.sessionInserts()).toEqual([])
  })

  it('writes nothing when the verifikat is already marked', async () => {
    const s = setup({ latestMark: 'not_momsredovisning' })
    const result = await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')
    expect(result).toEqual({ ok: true, data: { journal_entry_id: 'entry-1', marked: true, changed: false } })
    expect(s.inserts()).toEqual([])
  })

  it('marks again after a withdrawal: the latest row decides', async () => {
    const s = setup({ latestMark: 'withdrawn' })
    expect((await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')).ok).toBe(true)
    expect(s.inserts()).toHaveLength(1)
  })

  it('refuses a verifikat the company does not have', async () => {
    const s = setup({ entry: null })
    expect(await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')).toEqual({
      ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND',
    })
  })

  it('refuses a draft, the app\'s own momsredovisning and a storno', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...ENTRY, status: 'draft' }, 'VAT_MARK_NOT_POSTED'],
      [{ ...ENTRY, source_type: 'vat_settlement' }, 'VAT_MARK_TAGGED_SETTLEMENT'],
      [{ ...ENTRY, source_type: 'storno', reverses_id: 'entry-0' }, 'VAT_MARK_STORNO'],
      [{ ...ENTRY, source_type: 'manual', reverses_id: 'entry-0' }, 'VAT_MARK_STORNO'],
    ]
    for (const [entry, code] of cases) {
      const s = setup({ entry })
      expect(await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')).toEqual({ ok: false, code })
      expect(s.inserts()).toEqual([])
    }
  })

  it('refuses a closed or locked period, and a lookup that failed (it reads as locked)', async () => {
    for (const status of ['closed', 'locked'] as const) {
      periodStatus.resolvePeriodStatusForDate.mockResolvedValueOnce({ period_id: 'p1', status, lock_date: null })
      const s = setup()
      expect(await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1'))
        .toEqual({ ok: false, code: 'VAT_MARK_PERIOD_LOCKED' })
      expect(s.inserts()).toEqual([])
    }
  })

  it('refuses a verifikat in a VAT period already filed', async () => {
    filings.listVatFilings.mockResolvedValue([Q3_FILED])
    const s = setup()
    expect(await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1'))
      .toEqual({ ok: false, code: 'VAT_MARK_PERIOD_FILED' })
    expect(s.inserts()).toEqual([])
  })

  it('marks a verifikat dated outside every filed period', async () => {
    filings.listVatFilings.mockResolvedValue([{ period_start: '2026-04-01', period_end: '2026-06-30' }])
    const s = setup()
    expect((await markNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')).ok).toBe(true)
  })
})

describe('before the migration is applied (code ships first)', () => {
  it('reads no marks and answers VAT_MARK_NOT_READY for a write instead of throwing', async () => {
    const missing = { code: 'PGRST205', message: "Could not find the table 'public.vat_momsredovisning_marks' in the schema cache" }
    const session = createTableMockSupabase()
    session.setTable('journal_entries', { data: ENTRY })
    session.setTable('vat_momsredovisning_marks', { data: null, error: missing })
    const writer = createTableMockSupabase()
    writer.setTable('vat_momsredovisning_marks', { data: null, error: { code: '42P01', message: 'relation does not exist' } })
    const supabase = session.supabase as unknown as SupabaseClient
    expect(await markNotMomsredovisning(supabase, writer.supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'entry-1'))
      .toEqual({ ok: false, code: 'VAT_MARK_NOT_READY' })
    expect(await listMarkedInPeriod(supabase, 'company-1', { start: '2026-07-01', end: '2026-09-30' })).toEqual([])
  })
})

describe('withdrawNotMomsredovisning (crm#1849)', () => {
  it('records the withdrawal through the server as the person', async () => {
    const s = setup({ latestMark: 'not_momsredovisning' })
    const result = await withdrawNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1')
    expect(result).toEqual({ ok: true, data: { journal_entry_id: 'entry-1', marked: false, changed: true } })
    expect(s.inserts()).toEqual([
      { company_id: 'company-1', journal_entry_id: 'entry-1', action: 'withdrawn', actor: 'user-1' },
    ])
  })

  it('answers VAT_MARK_NOT_FOUND when nothing is marked', async () => {
    for (const latestMark of [null, 'withdrawn'] as const) {
      const s = setup({ latestMark })
      expect(await withdrawNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1'))
        .toEqual({ ok: false, code: 'VAT_MARK_NOT_FOUND' })
      expect(s.inserts()).toEqual([])
    }
  })

  it('refuses a withdrawal in a filed period, like the mark', async () => {
    filings.listVatFilings.mockResolvedValue([Q3_FILED])
    const s = setup({ latestMark: 'not_momsredovisning' })
    expect(await withdrawNotMomsredovisning(s.supabase, s.writer, 'company-1', 'user-1', 'entry-1'))
      .toEqual({ ok: false, code: 'VAT_MARK_PERIOD_FILED' })
  })
})

describe('listMarkedInPeriod (crm#1849)', () => {
  it('lists the posted verifikat whose latest mark is not_momsredovisning, in the period', async () => {
    const mock = createTableMockSupabase()
    // Newest first: entry-2 was marked and then withdrawn, entry-1 is marked.
    mock.setTable('vat_momsredovisning_marks', {
      data: [
        { journal_entry_id: 'entry-2', action: 'withdrawn' },
        { journal_entry_id: 'entry-1', action: 'not_momsredovisning' },
        { journal_entry_id: 'entry-2', action: 'not_momsredovisning' },
      ],
    })
    mock.setTable('journal_entries', {
      data: [{ id: 'entry-1', voucher_series: 'A', voucher_number: 158, entry_date: '2026-09-30' }],
    })
    const result = await listMarkedInPeriod(mock.supabase as unknown as SupabaseClient, 'company-1', { start: '2026-07-01', end: '2026-09-30' })
    expect(result).toEqual([{ journal_entry_id: 'entry-1', voucher_series: 'A', voucher_number: 158, entry_date: '2026-09-30' }])
    expect(mock.findCall('journal_entries', 'in')).toEqual(['id', ['entry-1']])
    // An annulled (reversed) one nets out with its storno and cannot be withdrawn: not offered.
    expect(mock.findCalls('journal_entries', 'eq')).toContainEqual(['status', 'posted'])
  })

  it('reads no verifikat when nothing is marked', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('vat_momsredovisning_marks', { data: [{ journal_entry_id: 'entry-1', action: 'withdrawn' }] })
    const result = await listMarkedInPeriod(mock.supabase as unknown as SupabaseClient, 'company-1', { start: '2026-07-01', end: '2026-09-30' })
    expect(result).toEqual([])
    expect(mock.findCall('journal_entries', 'in')).toBeUndefined()
  })
})
