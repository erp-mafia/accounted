import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

import {
  buildCutoffLines,
  buildCutoffNote,
  distributeOre,
  postKontantmetodCutoff,
  nextDay,
  reverseLines,
  VILANDE_INPUT_VAT_ACCOUNT,
  VILANDE_OUTPUT_VAT_ACCOUNTS,
} from '../kontantmetod-cutoff'
import type { CutoffPayable, CutoffReceivable } from '../kontantmetod-cutoff'
import { roundOre } from '@/lib/money'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'

const sum = (lines: Array<{ debit_amount: number; credit_amount: number }>) => ({
  debit: roundOre(lines.reduce((s, l) => s + l.debit_amount, 0)),
  credit: roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)),
})

const receivable = (over: Partial<CutoffReceivable> = {}): CutoffReceivable => ({
  id: 'inv-1',
  reference: 'F-1',
  vatTreatment: 'standard_25',
  outstanding: 1250,
  vat: 250,
  ...over,
})

const payable = (over: Partial<CutoffPayable> = {}): CutoffPayable => ({
  id: 'si-1',
  reference: 'L-1',
  outstanding: 1250,
  vat: 250,
  netByAccount: [{ account: '5410', amount: 1000 }],
  ...over,
})

describe('distributeOre', () => {
  it('splits exactly, with no öre lost or invented', () => {
    // 100 öre over three equal buckets cannot divide evenly: the largest
    // remainders must absorb the leftovers rather than the total drifting.
    const parts = distributeOre(100, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(parts).toEqual([34, 33, 33])
  })

  it('weights proportionally', () => {
    expect(distributeOre(1000, [3, 1])).toEqual([750, 250])
  })

  it('handles degenerate input without emitting NaN', () => {
    expect(distributeOre(500, [0, 0])).toEqual([500, 0])
    expect(distributeOre(500, [])).toEqual([])
    expect(distributeOre(500, [7])).toEqual([500])
  })
})

describe('buildCutoffLines: fordringar', () => {
  it('books the receivable against revenue and VILANDE output moms', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])

    const debit = receivableLines.find((l) => l.debit_amount > 0)
    expect(debit?.account_number).toBe('1510')
    expect(debit?.debit_amount).toBe(1250)

    // The whole point: moms parks on 2618, NOT 2611, so it stays out of the
    // momsdeklaration until the invoice is actually paid.
    const vatLine = receivableLines.find((l) => l.account_number === '2618')
    expect(vatLine?.credit_amount).toBe(250)
    expect(receivableLines.some((l) => l.account_number === '2611')).toBe(false)

    expect(receivableLines.find((l) => l.account_number === '3001')?.credit_amount).toBe(1000)
  })

  it('balances', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', outstanding: 1250, vat: 250 }),
        receivable({ id: 'b', outstanding: 560, vat: 60, vatTreatment: 'reduced_12' }),
        receivable({ id: 'c', outstanding: 106, vat: 6, vatTreatment: 'reduced_6' }),
      ],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.debit).toBe(1916)
  })

  it('balances on amounts that do not divide evenly', () => {
    // 33.33 % style residue: net is derived as outstanding - vat precisely so
    // the two legs always add back to the receivable.
    const { receivableLines } = buildCutoffLines(
      [receivable({ outstanding: 1000.01, vat: 200.003 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('uses one vilande account per rate', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', vatTreatment: 'standard_25' }),
        receivable({ id: 'b', outstanding: 1120, vat: 120, vatTreatment: 'reduced_12' }),
      ],
      [],
    )
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.standard_25)).toBeDefined()
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.reduced_12)).toBeDefined()
  })

  it('treats a zero-moms treatment as pure revenue', () => {
    // Export carries no Swedish output moms, so nothing may land on a vilande
    // account: the full outstanding is revenue.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 0 })],
      [],
    )
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expect(receivableLines.find((l) => l.account_number === '3305')?.credit_amount).toBe(5000)
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still balances if a stray moms amount reaches buildCutoffLines directly', () => {
    // The collector now excludes these rows and the posting step refuses them,
    // so this is the last-resort path. It must never invent a moms account and
    // must never unbalance the verifikat.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 100 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  })

  it('emits nothing when there is nothing outstanding', () => {
    expect(buildCutoffLines([], []).receivableLines).toEqual([])
    expect(buildCutoffLines([receivable({ outstanding: 0, vat: 0 })], []).receivableLines).toEqual([])
  })
})

describe('buildCutoffLines: skulder', () => {
  it('books the payable against expense and VILANDE input moms', () => {
    const { payableLines } = buildCutoffLines([], [payable()])

    const credit = payableLines.find((l) => l.credit_amount > 0)
    expect(credit?.account_number).toBe('2440')
    expect(credit?.credit_amount).toBe(1250)

    // 2648, not 2641: the deduction is not claimable until payment.
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
    expect(payableLines.some((l) => l.account_number === '2641')).toBe(false)

    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(1000)
  })

  it('splits the net across several expense accounts and still balances', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 1250,
          vat: 250,
          netByAccount: [
            { account: '5410', amount: 700 },
            { account: '6110', amount: 300 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(700)
    expect(payableLines.find((l) => l.account_number === '6110')?.debit_amount).toBe(300)
  })

  it('balances when the account split cannot divide evenly', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 100.01,
          vat: 0,
          netByAccount: [
            { account: '5410', amount: 1 },
            { account: '6110', amount: 1 },
            { account: '6210', amount: 1 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.credit).toBe(100.01)
  })

  it('falls back to a generic expense account when item detail is missing', () => {
    const { payableLines } = buildCutoffLines([], [payable({ netByAccount: [] })])
    expect(payableLines.find((l) => l.account_number === '6990')?.debit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })
})

describe('reverseLines', () => {
  it('swaps every debit and credit so the vändning nets to zero', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])
    const reversed = reverseLines(receivableLines)

    const original = sum(receivableLines)
    const back = sum(reversed)
    expect(back.debit).toBe(original.credit)
    expect(back.credit).toBe(original.debit)

    // Net effect of cut-off + vändning on 1510 is exactly zero.
    const net = [...receivableLines, ...reversed]
      .filter((l) => l.account_number === '1510')
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
    expect(net).toBe(0)
  })

  it('labels the reversal so the verifikat is self-explanatory', () => {
    expect(reverseLines([{ account_number: '1510', debit_amount: 10, credit_amount: 0, line_description: 'X' }])[0]
      .line_description).toBe('Vändning: X')
  })
})

describe('nextDay', () => {
  it('rolls over year end', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  it('handles a broken fiscal year and a leap day', () => {
    expect(nextDay('2026-06-30')).toBe('2026-07-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })
})

describe('buildCutoffNote (BFL 5 kap 6-7 §: traceability)', () => {
  it('names the invoices an aggregate verifikat covers', () => {
    expect(buildCutoffNote('Kundfordringar', ['F-1', 'F-2'])).toBe(
      'Kundfordringar (2 st): F-1, F-2',
    )
  })

  it('truncates a long list to a pointer rather than an unbounded note', () => {
    const refs = Array.from({ length: 60 }, (_, i) => `F-${i + 1}`)
    const note = buildCutoffNote('Kundfordringar', refs)
    expect(note).toContain('(60 st)')
    expect(note).toContain('och 10 till')
  })

  it('is explicit when no invoice numbers exist', () => {
    expect(buildCutoffNote('Skulder', ['', '  '])).toBe('Skulder: inga fakturanummer registrerade')
  })
})

describe('postKontantmetodCutoff', () => {
  const OPEN_NEXT = {
    id: 'fp-next',
    period_start: '2027-01-01',
    period_end: '2027-12-31',
    is_closed: false,
    locked_at: null,
  }

  const makeSupabase = (next: Record<string, unknown> | null) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: next, error: next ? null : { message: 'x' } }) }),
        }),
      }),
    }),
  }) as never

  const baseOpts = {
    fiscalPeriodId: 'fp-1',
    nextFiscalPeriodId: 'fp-next',
    periodEnd: '2026-12-31',
    receivables: [receivable()],
    payables: [],
  }

  beforeEach(() => {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
  })

  it('posts the cut-off and its vändning, carrying invoice refs into notes', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockResolvedValueOnce({ id: 'je-reversal' } as never)

    const result = await postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts)

    expect(result.receivableEntry?.id).toBe('je-cutoff')
    expect(result.receivableReversal?.id).toBe('je-reversal')

    const cutoffCall = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(cutoffCall.entry_date).toBe('2026-12-31')
    expect(cutoffCall.notes).toContain('F-1')
    const reversalCall = vi.mocked(createJournalEntry).mock.calls[1][3]
    expect(reversalCall.entry_date).toBe('2027-01-01')
    expect(reversalCall.fiscal_period_id).toBe('fp-next')
  })

  it('refuses before posting anything when the next period does not exist', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase(null), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/nästa räkenskapsår/i)
    // The critical assertion: nothing was posted, so no un-reversed cut-off.
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses before posting anything when the next period is closed or locked', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase({ ...OPEN_NEXT, is_closed: true }), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/stängt eller låst/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()

    await expect(
      postKontantmetodCutoff(makeSupabase({ ...OPEN_NEXT, locked_at: '2027-02-01' }), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/stängt eller låst/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when the vändning date falls outside the next period', async () => {
    await expect(
      postKontantmetodCutoff(
        makeSupabase({ ...OPEN_NEXT, period_start: '2027-03-01' }),
        'co-1', 'user-1', baseOpts,
      ),
    ).rejects.toThrow(/utanför nästa räkenskapsår/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when an invoice carries moms on a momsfri treatment', async () => {
    // Absorbing it into revenue would balance the verifikat and swallow a real
    // invoicing error: the netting the swedish-vat reference prohibits.
    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
        ...baseOpts,
        strayVatOnZeroRate: ['F-7'],
      }),
    ).rejects.toThrow(/momsfri momsinställning/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when any invoice lacks a vat_treatment', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
        ...baseOpts,
        unknownVatTreatment: ['F-9'],
      }),
    ).rejects.toThrow(/saknar momsinställning/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('stornoes the cut-off when its vändning fails, leaving no inflated 1510', async () => {
    // The failure mode the module exists to prevent: a committed cut-off with
    // no vändning inflates 1510/2440 permanently and double-books every
    // new-year payment.
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    vi.mocked(reverseEntry).mockResolvedValue({ id: 'je-storno' } as never)

    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow('period locked')

    expect(vi.mocked(reverseEntry)).toHaveBeenCalledWith(
      expect.anything(), 'co-1', 'user-1', 'je-cutoff', '2026-12-31',
    )
  })

  it('still rethrows the original error when the compensating storno also fails', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    vi.mocked(reverseEntry).mockRejectedValue(new Error('storno failed'))

    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow('period locked')
  })

  it('posts nothing at all when there is nothing outstanding', async () => {
    const result = await postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
      ...baseOpts,
      receivables: [],
      payables: [],
    })
    expect(result.receivableEntry).toBeNull()
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })
})

describe('buildCutoffLines: omvänd betalningsskyldighet', () => {
  it('never routes reverse-charge moms into the single vilande bucket', () => {
    // A one-sided reverse charge is prohibited: the self-assessed output/input
    // pair belongs to the payment entry, not to a deferred 2648 balance.
    const { payableLines } = buildCutoffLines(
      [],
      [payable({ outstanding: 1000, vat: 250, reverseCharge: true, netByAccount: [{ account: '4056', amount: 1000 }] })],
    )
    expect(payableLines.some((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)).toBe(false)
    // The full outstanding is expense against 2440.
    expect(payableLines.find((l) => l.account_number === '4056')?.debit_amount).toBe(1000)
    expect(payableLines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still books vilande moms for ordinary (non-RC) supplier invoices', () => {
    const { payableLines } = buildCutoffLines([], [payable({ reverseCharge: false })])
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
  })
})
