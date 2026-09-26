import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  findCancelledEntryIds,
  loadCancelledEntryIds,
  type EntryForCancellation,
} from '../skattekonto-cancelled-entries'

function entry(
  id: string,
  voucher: number,
  date: string,
  lines: Array<[string, number, number]>,
  extra: Partial<EntryForCancellation> = {},
): EntryForCancellation {
  return {
    id,
    entry_date: date,
    status: 'posted',
    voucher_series: 'A',
    voucher_number: voucher,
    description: `Verifikat ${voucher}`,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({
      account_number,
      debit_amount,
      credit_amount,
    })),
    ...extra,
  }
}

describe('findCancelledEntryIds', () => {
  it('flags an imported storno pair: same date, same accounts, opposite amounts (crm#128)', () => {
    const original = entry('a177', 177, '2026-07-13', [['1630', 0, 7704], ['2940', 7704, 0]])
    const storno = entry('a178', 178, '2026-07-13', [['1630', 7704, 0], ['2940', 0, 7704]])
    const real = entry('a157', 157, '2026-07-13', [['1630', 0, 12225], ['2710', 4521, 0], ['2731', 7704, 0]])
    expect(findCancelledEntryIds([real, storno, original])).toEqual(new Set(['a177', 'a178']))
  })

  it('flags a later correction that names the original voucher', () => {
    const original = entry('a177', 177, '2026-07-13', [['1630', 0, 7704], ['2940', 7704, 0]])
    const correction = entry('a190', 190, '2026-07-30', [['1630', 7704, 0], ['2940', 0, 7704]], {
      description: 'Korrigering av ver.nr. A177, Arbetsgivaravgift',
    })
    expect(findCancelledEntryIds([original, correction])).toEqual(new Set(['a177', 'a190']))
  })

  it('does not flag a payment and a later refund of the same amount (mirror without an anchor)', () => {
    const payment = entry('p', 10, '2026-03-01', [['1630', 5000, 0], ['1930', 0, 5000]])
    const refund = entry('r', 20, '2026-03-20', [['1630', 0, 5000], ['1930', 5000, 0]], {
      description: 'Utbetalning från skattekontot',
    })
    expect(findCancelledEntryIds([payment, refund]).size).toBe(0)
  })

  it('does not treat a voucher number that is only a prefix of another as a reference', () => {
    const original = entry('a17', 17, '2026-03-01', [['1630', 0, 100], ['2940', 100, 0]])
    const other = entry('x', 30, '2026-03-05', [['1630', 100, 0], ['2940', 0, 100]], {
      description: 'Se A170',
    })
    expect(findCancelledEntryIds([original, other]).size).toBe(0)
  })

  it('flags in-app storno by its markers and pairs one to one', () => {
    const reversed = entry('orig', 1, '2026-01-10', [['1630', 0, 300], ['2710', 300, 0]], {
      status: 'reversed',
      reversed_by_id: 'st',
    })
    const stornoEntry = entry('st', 2, '2026-01-20', [['1630', 300, 0], ['2710', 0, 300]], {
      reverses_id: 'orig',
    })
    const twinA = entry('t1', 3, '2026-02-12', [['1630', 0, 900], ['2731', 900, 0]])
    const twinB = entry('t2', 4, '2026-02-12', [['1630', 0, 900], ['2731', 900, 0]])
    const twinStorno = entry('t3', 5, '2026-02-12', [['1630', 900, 0], ['2731', 0, 900]])
    const result = findCancelledEntryIds([reversed, stornoEntry, twinA, twinB, twinStorno])
    expect(result.has('orig')).toBe(true)
    expect(result.has('st')).toBe(true)
    expect(result.has('t3')).toBe(true)
    // Two identical bookings, one storno: exactly one of them is cancelled.
    expect(Number(result.has('t1')) + Number(result.has('t2'))).toBe(1)
  })
})

describe('loadCancelledEntryIds', () => {
  it('reads 1630 entries around the window, then all their lines', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'a177', entry_date: '2026-07-13', status: 'posted', voucher_series: 'A', voucher_number: 177, description: 'x', reverses_id: null, reversed_by_id: null },
        { id: 'a178', entry_date: '2026-07-13', status: 'posted', voucher_series: 'A', voucher_number: 178, description: 'y', reverses_id: null, reversed_by_id: null },
      ],
    })
    enqueue({
      data: [
        { id: 'l1', journal_entry_id: 'a177', debit_amount: 0, credit_amount: 7704 },
        { id: 'l2', journal_entry_id: 'a178', debit_amount: 7704, credit_amount: 0 },
      ],
    })
    enqueue({
      data: [
        { id: 'l1', journal_entry_id: 'a177', account_number: '1630', debit_amount: 0, credit_amount: 7704 },
        { id: 'l3', journal_entry_id: 'a177', account_number: '2940', debit_amount: 7704, credit_amount: 0 },
        { id: 'l2', journal_entry_id: 'a178', account_number: '1630', debit_amount: 7704, credit_amount: 0 },
        { id: 'l4', journal_entry_id: 'a178', account_number: '2940', debit_amount: 0, credit_amount: 7704 },
      ],
    })
    const result = await loadCancelledEntryIds(supabase as never, 'company-1', '2026-06-29', '2026-07-27')
    expect(result).toEqual(new Set(['a177', 'a178']))
    expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-05-29'])
    expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-08-27'])
  })
})
