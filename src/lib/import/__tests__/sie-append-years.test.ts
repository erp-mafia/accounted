/**
 * The years a top-up of files from one program can add vouchers to
 * (appendableSIEYears): a year whose append base, the newest completed
 * import of it, came from a file of that program, and that is neither closed
 * nor locked. The books are a scripted Supabase double.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { appendableSIEYears } from '../sie-append'

type Row = Record<string, unknown>

const year = (id: string, start: string, overrides: Row = {}): Row => ({
  id, name: start.slice(0, 4), period_start: start, period_end: `${start.slice(0, 4)}-12-31`,
  is_closed: false, locked_at: null, closed_externally: null, closing_entry_id: null, ...overrides,
})

const base = (id: string, periodId: string, program: string | null, sourceYear: Row | null = null): Row =>
  ({ id, fiscal_period_id: periodId, program, source_year: sourceYear })

function books(bases: Row[], periods: Row[]) {
  const mock = createTableMockSupabase({
    sie_imports: { data: bases },
    // The periods asked for by id, as the real query does.
    fiscal_periods: (calls) => {
      const ids = (calls.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
      return { data: periods.filter((p) => ids.includes(p.id as string)) }
    },
  })
  return { ...mock, supabase: mock.supabase as unknown as SupabaseClient }
}

describe('appendableSIEYears', () => {
  it('names each open year whose import came from a file of the program, oldest first', async () => {
    const { supabase, findCalls } = books(
      [base('b-2026', 'p-2026', 'Fortnox', { start: '2026-01-01', end: '2026-12-31' }), base('b-2025', 'p-2025', 'Fortnox')],
      [year('p-2026', '2026-01-01'), year('p-2025', '2025-01-01')],
    )
    expect(await appendableSIEYears(supabase, 'company-1', 'Fortnox')).toEqual([
      { fiscalPeriodId: 'p-2025', name: '2025', start: '2025-01-01', end: '2025-12-31', baseImportId: 'b-2025', sourceYear: null },
      { fiscalPeriodId: 'p-2026', name: '2026', start: '2026-01-01', end: '2026-12-31', baseImportId: 'b-2026',
        sourceYear: { start: '2026-01-01', end: '2026-12-31' } },
    ])
    // The base is the one an append adds to: a durable import that
    // completed, never an append itself, of this company only.
    expect(findCalls('sie_imports', 'eq')).toEqual(expect.arrayContaining([
      ['company_id', 'company-1'], ['job_kind', 'import'], ['job_state', 'completed'],
    ]))
    expect(findCalls('sie_imports', 'is')).toEqual([['base_import_id', null]])
    expect(findCalls('fiscal_periods', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('leaves out a closed year, a locked year and one marked closed in an earlier program', async () => {
    const { supabase } = books(
      [base('b-2026', 'p-2026', 'Fortnox'), base('b-2025', 'p-2025', 'Fortnox'), base('b-2024', 'p-2024', 'Fortnox'),
        base('b-2023', 'p-2023', 'Fortnox')],
      [
        year('p-2026', '2026-01-01'),
        year('p-2025', '2025-01-01', { is_closed: true, closing_entry_id: 'closing-2025' }),
        year('p-2024', '2024-01-01', { locked_at: '2025-03-01T10:00:00Z' }),
        year('p-2023', '2023-01-01', { is_closed: true, closed_externally: true }),
      ],
    )
    expect((await appendableSIEYears(supabase, 'company-1', 'Fortnox')).map((y) => y.fiscalPeriodId)).toEqual(['p-2026'])
  })

  it('leaves out a year imported from another program, whose vouchers the plan cannot match', async () => {
    const { supabase, tables } = books([base('b-2026', 'p-2026', 'Bokio')], [year('p-2026', '2026-01-01')])
    expect(await appendableSIEYears(supabase, 'company-1', 'Fortnox')).toEqual([])
    // Nothing from the program: the years are never read.
    expect(tables()).not.toContain('fiscal_periods')
  })

  it('reads the newest import of a year, as the append does', async () => {
    // Newest first, as the query orders them: the year's base is from Visma now.
    const { supabase } = books(
      [base('b-new', 'p-2026', 'Spiris Bokföring & Fakturering'), base('b-old', 'p-2026', 'Fortnox')],
      [year('p-2026', '2026-01-01')],
    )
    expect(await appendableSIEYears(supabase, 'company-1', 'Fortnox')).toEqual([])
  })

  it('throws when the years cannot be read, rather than answer none', async () => {
    const mock = createTableMockSupabase({
      sie_imports: { data: [base('b-2026', 'p-2026', 'Fortnox')] },
      fiscal_periods: { error: { message: 'connection reset' } },
    })
    await expect(appendableSIEYears(mock.supabase as unknown as SupabaseClient, 'company-1', 'Fortnox'))
      .rejects.toThrow('connection reset')
  })
})
