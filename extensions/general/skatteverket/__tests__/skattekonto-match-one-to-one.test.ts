import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findMatchSuggestionsBulk } from '../lib/skattekonto-match'

const COMPANY = 'company-1'

function lineRow(opts: {
  entryId: string
  debit?: number
  credit?: number
  entryDate?: string
  voucherNumber?: number
}) {
  return {
    debit_amount: opts.debit ?? 0,
    credit_amount: opts.credit ?? 0,
    journal_entries: {
      id: opts.entryId,
      voucher_number: opts.voucherNumber ?? 1,
      voucher_series: 'A',
      entry_date: opts.entryDate ?? '2026-08-11',
      description: `Verifikat ${opts.entryId}`,
      status: 'posted' as const,
      company_id: COMPANY,
    },
  }
}

/** Two-step entry-lines pages: parents first, then the lines keyed by entry id. */
function enqueueLines(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  rows: ReturnType<typeof lineRow>[],
) {
  const entries = [...new Map(rows.map((r) => [r.journal_entries.id, r.journal_entries])).values()]
  enqueue({ data: entries })
  if (entries.length === 0) return
  enqueue({
    data: rows.map((r, i) => ({
      id: `line-${String(i).padStart(4, '0')}`,
      journal_entry_id: r.journal_entries.id,
      debit_amount: r.debit_amount,
      credit_amount: r.credit_amount,
    })),
  })
}

function row(id: string, belopp: number, datum = '2026-08-12', text = 'Inbetalning bokförd') {
  return { id, transaktionsdatum: datum, transaktionstext: text, belopp_skatteverket: belopp, journal_entry_id: null }
}

describe('findMatchSuggestionsBulk: one-to-one assignment and split-line fallback', () => {
  it('never proposes the same verifikat to two rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [lineRow({ entryId: 'E1', debit: 5000 })])
    enqueue({ data: [] }) // already-linked check

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      row('r1', 5000),
      row('r2', 5000),
    ])

    expect(out.size).toBe(1)
    expect(out.get('r1')?.journal_entry_id).toBe('E1')
    expect(out.has('r2')).toBe(false)
  })

  it('assigns the nearer-dated row first when rows compete for one entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [lineRow({ entryId: 'E1', debit: 5000, entryDate: '2026-08-20' })])
    enqueue({ data: [] })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      row('r-early', 5000, '2026-08-10'),
      row('r-late', 5000, '2026-08-19'),
    ])

    // Rows are assigned in date order; the earlier row claims the only candidate.
    expect(out.get('r-early')?.journal_entry_id).toBe('E1')
    expect(out.has('r-late')).toBe(false)
  })

  it('proposes an entry whose 1630 lines net to the amount when no single line does', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [
      lineRow({ entryId: 'E2', debit: 3000 }),
      lineRow({ entryId: 'E2', debit: 2000 }),
    ])
    enqueue({ data: [] })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [row('r1', 5000)])

    expect(out.get('r1')).toMatchObject({
      journal_entry_id: 'E2',
      matched_via_entry_total: true,
      matched_amount: 5000,
      matched_side: 'debit',
    })
  })

  it('a single-line exact match outranks a split-line one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [
      lineRow({ entryId: 'E1', debit: 5000 }),
      lineRow({ entryId: 'E2', debit: 3000 }),
      lineRow({ entryId: 'E2', debit: 2000 }),
    ])
    enqueue({ data: [] })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [row('r1', 5000)])
    expect(out.get('r1')?.journal_entry_id).toBe('E1')
    expect(out.get('r1')?.matched_via_entry_total).toBe(false)
  })

  it('two exact candidates for one row stay ambiguous (no proposal)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [lineRow({ entryId: 'E1', debit: 5000 }), lineRow({ entryId: 'E2', debit: 5000 })])
    enqueue({ data: [] })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [row('r1', 5000)])
    expect(out.size).toBe(0)
  })

  it('a credit-side row matches credit lines only', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueLines(enqueue, [lineRow({ entryId: 'E1', debit: 5447 }), lineRow({ entryId: 'E2', credit: 5447 })])
    enqueue({ data: [] })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [row('r1', -5447)])
    expect(out.get('r1')?.journal_entry_id).toBe('E2')
    expect(out.get('r1')?.matched_side).toBe('credit')
  })
})
