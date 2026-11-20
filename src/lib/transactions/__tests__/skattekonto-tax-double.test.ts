import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { SKATTEKONTO_LEDGER_ACCOUNTS } from '@/lib/skatteverket/skattekonto-account'
import { SKATTEKONTO_LEDGER_ACCOUNT_SET } from '../skattekonto-tax-accounts'
import {
  calendarMonthOf,
  detectSkattekontoTaxDouble,
  directTaxCounterLines,
  isSkattekontoTaxCandidateFor,
  isSkattekontoTaxDouble,
  pickSkattekontoTaxTwin,
  skattekontoTaxDoubleAgentMessage,
  type MonthEntryLine,
} from '../skattekonto-tax-double'

/**
 * Issue #50: a skattekonto row booked first (D 2650 / K 1630), then the bank
 * payment categorised straight to the tax account (D 2650 / K 1930) clears
 * the moms twice. The guard's skattekonto half warns before the second
 * verifikat is made.
 */

const COMPANY = 'company-1'

function entry(id: string, date: string, over: Partial<MonthEntryLine['journal_entry']> = {}) {
  return {
    id,
    entry_date: date,
    description: `Verifikat ${id}`,
    voucher_series: 'A',
    voucher_number: 12,
    source_type: 'system',
    reverses_id: null,
    ...over,
  }
}

function lines(e: ReturnType<typeof entry>, ls: Array<[string, number, number]>): MonthEntryLine[] {
  return ls.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount, journal_entry: e }))
}

// The skattekonto row "Moms juni" booked through 1630.
const MOMS = entry('je-moms', '2026-07-12')
const MOMS_LINES = lines(MOMS, [
  ['2650', 12225, 0],
  ['1630', 0, 12225],
])
// The bank payment categorised straight to 2650.
const DIRECT = [
  { account_number: '2650', net: 12225 },
  { account_number: '1930', net: -12225 },
]

describe('directTaxCounterLines', () => {
  it('keeps a tax account on the cash leg\'s other side', () => {
    expect(directTaxCounterLines(-12225, DIRECT)).toEqual([{ account_number: '2650', net: 12225 }])
  })

  it('is empty when the kontering goes through the skattekonto (1630 or 2012)', () => {
    expect(directTaxCounterLines(-12225, [{ account_number: '1630', net: 12225 }, { account_number: '1930', net: -12225 }])).toEqual([])
    expect(directTaxCounterLines(-500, [{ account_number: '2012', net: 500 }, { account_number: '2650', net: 0.01 }, { account_number: '1930', net: -500.01 }])).toEqual([])
  })

  it('ignores a salary payout that withholds tax on 2710 (credit beside the cash credit)', () => {
    const salary = [
      { account_number: '7210', net: 55000 },
      { account_number: '2710', net: -12951 },
      { account_number: '1930', net: -42049 },
    ]
    expect(directTaxCounterLines(-42049, salary)).toEqual([])
  })

  it('nets a split per account and keeps several tax accounts (an AGI paid as 2710 + 2731)', () => {
    const agi = [
      { account_number: '2710', net: 6000 },
      { account_number: '2710', net: 6951 },
      { account_number: '2731', net: 17281 },
      { account_number: '1930', net: -30232 },
    ]
    expect(directTaxCounterLines(-30232, agi)).toEqual([
      { account_number: '2710', net: 12951 },
      { account_number: '2731', net: 17281 },
    ])
  })

  it('takes money in the other way: a refund credited straight to 2650', () => {
    expect(directTaxCounterLines(800, [{ account_number: '1930', net: 800 }, { account_number: '2650', net: -800 }])).toEqual([
      { account_number: '2650', net: -800 },
    ])
  })

  it('leaves out F-skatt on 2013 and an ordinary cost', () => {
    expect(directTaxCounterLines(-3000, [{ account_number: '2013', net: 3000 }, { account_number: '1930', net: -3000 }])).toEqual([])
    expect(directTaxCounterLines(-300, [{ account_number: '6200', net: 300 }, { account_number: '1930', net: -300 }])).toEqual([])
  })
})

describe('pickSkattekontoTaxTwin', () => {
  const probes = [{ account_number: '2650', net: 12225 }]

  it('finds the skattekonto verifikat that clears the same tax by the same amount', () => {
    const pick = pickSkattekontoTaxTwin('2026-07-10', probes, MOMS_LINES)
    expect(pick?.entry.id).toBe('je-moms')
    expect(pick?.skattekontoAccount).toBe('1630')
  })

  it('needs the skattekonto line: a bank payment to 2650 is the forward guard\'s business', () => {
    const bank = entry('je-bank', '2026-07-10', { source_type: 'bank_transaction' })
    expect(pickSkattekontoTaxTwin('2026-07-10', probes, lines(bank, [['2650', 12225, 0], ['1930', 0, 12225]]))).toBeNull()
  })

  it('needs the exact amount and side', () => {
    expect(pickSkattekontoTaxTwin('2026-07-10', [{ account_number: '2650', net: 12224 }], MOMS_LINES)).toBeNull()
    expect(pickSkattekontoTaxTwin('2026-07-10', [{ account_number: '2650', net: -12225 }], MOMS_LINES)).toBeNull()
  })

  it('skips a storno, the opening balance and the excluded verifikat', () => {
    const storno = entry('je-storno', '2026-07-20', { reverses_id: 'je-x', source_type: 'storno' })
    const ib = entry('je-ib', '2026-07-01', { source_type: 'opening_balance' })
    expect(pickSkattekontoTaxTwin('2026-07-10', probes, lines(storno, [['2650', 12225, 0], ['1630', 0, 12225]]))).toBeNull()
    expect(pickSkattekontoTaxTwin('2026-07-10', probes, lines(ib, [['2650', 12225, 0], ['1630', 0, 12225]]))).toBeNull()
    expect(pickSkattekontoTaxTwin('2026-07-10', probes, MOMS_LINES, new Set(['je-moms']))).toBeNull()
  })

  it('skips an imported annulment pair (one verifikat undone by another of the month)', () => {
    const annul = entry('je-annul', '2026-07-12', { source_type: 'import' })
    const pair = [...MOMS_LINES, ...lines(annul, [['2650', 0, 12225], ['1630', 12225, 0]])]
    expect(pickSkattekontoTaxTwin('2026-07-10', probes, pair)).toBeNull()
  })

  it('picks the nearest date, then the lowest id', () => {
    const early = entry('je-b', '2026-07-01')
    const near = entry('je-c', '2026-07-12')
    const tie = entry('je-a', '2026-07-12')
    const all = [
      ...lines(early, [['2650', 12225, 0], ['1630', 0, 12225]]),
      ...lines(near, [['2650', 12225, 0], ['1630', 0, 12225]]),
      ...lines(tie, [['2650', 12225, 0], ['1630', 0, 12225]]),
    ]
    expect(pickSkattekontoTaxTwin('2026-07-11', probes, all)?.entry.id).toBe('je-a')
  })
})

describe('calendarMonthOf', () => {
  it('returns the first and last day', () => {
    expect(calendarMonthOf('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(calendarMonthOf('2028-02-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(calendarMonthOf('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(calendarMonthOf('nope')).toBeNull()
  })
})

describe('the skattekonto accounts', () => {
  it('are the ones the skattekonto may run on', () => {
    expect([...SKATTEKONTO_LEDGER_ACCOUNT_SET].sort()).toEqual([...SKATTEKONTO_LEDGER_ACCOUNTS].sort())
  })
})

describe('detectSkattekontoTaxDouble', () => {
  const target = {
    id: 'tx-1',
    date: '2026-07-10',
    amount: -12225,
    currency: 'SEK',
    counter_lines: DIRECT,
  }

  it('returns the skattekonto verifikat as a candidate, read over the calendar month only', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ ...MOMS }] })
    enqueue({
      data: MOMS_LINES.map((l, i) => ({
        id: `l-${i}`,
        journal_entry_id: MOMS.id,
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
      })),
    })

    const candidate = await detectSkattekontoTaxDouble(supabase as never, COMPANY, target)

    expect(candidate).toMatchObject({
      transaction_id: null,
      journal_entry_id: 'je-moms',
      voucher_label: 'A12',
      entry_date: '2026-07-12',
      amount: 12225,
      account_number: null,
      amount_verified: true,
      skattekonto: { tax_account: '2650', skattekonto_account: '1630' },
    })
    expect(isSkattekontoTaxDouble(candidate)).toBe(true)
    expect(findCalls('journal_entries', 'gte')).toEqual([['entry_date', '2026-07-01']])
    expect(findCalls('journal_entries', 'lte')).toEqual([['entry_date', '2026-07-31']])
    expect(findCalls('journal_entries', 'in')).toContainEqual(['status', ['draft', 'posted']])
    expect(findCalls('journal_entry_lines', 'in')).toContainEqual(['account_number', ['2650', '1630', '2012']])
  })

  it('reads nothing for a kontering through the skattekonto, or without counter lines', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    const via1630 = [{ account_number: '1630', net: 12225 }, { account_number: '1930', net: -12225 }]
    expect(await detectSkattekontoTaxDouble(supabase as never, COMPANY, { ...target, counter_lines: via1630 })).toBeNull()
    expect(await detectSkattekontoTaxDouble(supabase as never, COMPANY, { ...target, counter_lines: undefined })).toBeNull()
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('stays silent when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    expect(await detectSkattekontoTaxDouble(supabase as never, COMPANY, target)).toBeNull()
  })

  it('tells the agent to book on the skattekonto account, and keeps allow_duplicate as the way past', () => {
    const message = skattekontoTaxDoubleAgentMessage({
      transaction_id: null,
      journal_entry_id: 'je-moms',
      voucher_label: 'A12',
      entry_date: '2026-07-12',
      description: null,
      amount: 12225,
      account_number: null,
      currency: null,
      amount_in_currency: null,
      amount_verified: true,
      unverified_reason: null,
      skattekonto: { tax_account: '2650', skattekonto_account: '1630' },
    })
    expect(message).toContain('verifikat A12 (2026-07-12)')
    expect(message).toContain('på 2650 mot skattekontot (1630)')
    expect(message).toContain('bokför transaktionen mot 1630 i stället')
    expect(message).toContain('allow_duplicate=true')
  })
})

describe('isSkattekontoTaxCandidateFor', () => {
  const read = async (row: unknown) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row })
    return isSkattekontoTaxCandidateFor(supabase as never, COMPANY, '2026-07-10', 'je-moms')
  }
  const base = {
    id: 'je-moms',
    entry_date: '2026-07-12',
    status: 'posted',
    reverses_id: null,
    source_type: 'system',
    journal_entry_lines: [{ account_number: '2650' }, { account_number: '1630' }],
  }

  it('accepts a live skattekonto verifikat of the month with a tax line', async () => {
    expect(await read(base)).toBe(true)
  })

  it('refuses another month, a storno, a reversed one, one without the skattekonto, and a missing one', async () => {
    expect(await read({ ...base, entry_date: '2026-08-12' })).toBe(false)
    expect(await read({ ...base, reverses_id: 'je-x' })).toBe(false)
    expect(await read({ ...base, status: 'reversed' })).toBe(false)
    expect(await read({ ...base, journal_entry_lines: [{ account_number: '2650' }, { account_number: '1930' }] })).toBe(false)
    expect(await read(null)).toBe(false)
  })
})
