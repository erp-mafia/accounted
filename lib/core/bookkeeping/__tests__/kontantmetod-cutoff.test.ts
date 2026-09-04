import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

import {
  buildCutoffLines,
  buildCutoffNote,
  cutoffCollectionsEqual,
  cutoffPreviewFingerprint,
  collectKontantmetodCutoff,
  distributeOre,
  inspectKontantmetodCutoffPostings,
  KONTANTMETOD_CUTOFF_DESCRIPTIONS,
  postKontantmetodCutoff,
  nextDay,
  reverseLines,
  VILANDE_INPUT_VAT_ACCOUNT,
  VILANDE_OUTPUT_VAT_ACCOUNTS,
} from '../kontantmetod-cutoff'
import type { CutoffPayable, CutoffReceivable } from '../kontantmetod-cutoff'
import type { Invoice } from '@/types'
import { roundOre } from '@/lib/money'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { makeInvoice } from '@/tests/helpers'

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

  it('preserves the sign of a credit amount', () => {
    expect(distributeOre(-100, [1, 1, 1])).toEqual([-34, -33, -33])
  })
})

describe('buildCutoffLines: fordringar', () => {
  it('books the receivable against revenue and VILANDE output moms', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])

    const debit = receivableLines.find((l) => l.debit_amount > 0)
    expect(debit?.account_number).toBe('1510')
    expect(debit?.debit_amount).toBe(1250)

    // Year-end output VAT uses the dedicated BAS account. The final-period
    // declaration maps 2618, while its day-one reversal is excluded.
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

    // Year-end input VAT uses the dedicated BAS account and is claimed in the
    // final VAT period under bokslutsmetoden.
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

  it('books customer and supplier credit notes with opposite polarity', () => {
    const lines = buildCutoffLines(
      [receivable({ outstanding: -1250, vat: -250 })],
      [payable({ outstanding: -1250, vat: -250 })],
    )
    expect(lines.receivableLines.find((line) => line.account_number === '1510')).toMatchObject({
      debit_amount: 0,
      credit_amount: 1250,
    })
    expect(lines.receivableLines.find((line) => line.account_number === '3001')).toMatchObject({
      debit_amount: 1000,
      credit_amount: 0,
    })
    expect(lines.payableLines.find((line) => line.account_number === '2440')).toMatchObject({
      debit_amount: 1250,
      credit_amount: 0,
    })
    expect(lines.payableLines.find((line) => line.account_number === '5410')).toMatchObject({
      debit_amount: 0,
      credit_amount: 1000,
    })
    expect(sum(lines.receivableLines)).toEqual({ debit: 1250, credit: 1250 })
    expect(sum(lines.payableLines)).toEqual({ debit: 1250, credit: 1250 })
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

describe('cut-off snapshot and posting inspection', () => {
  const makeJournalSupabase = (rows: unknown[], error: { message: string } | null = null) => ({
    from: () => {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.in = () => query
      query.then = (resolve: (value: unknown) => unknown) => resolve({
        data: (rows as Array<Record<string, unknown>>).map((row) => ({
          entry_date: row.fiscal_period_id === 'fp-2' ? '2027-01-01' : '2026-12-31',
          ...row,
        })),
        error,
      })
      return query
    },
  }) as never

  it('treats collection order as irrelevant but catches changed source data', () => {
    const first = {
      receivables: [receivable({ id: 'b' }), receivable({ id: 'a' })],
      payables: [payable({ id: 'p' })],
      unknownVatTreatment: [],
      strayVatOnZeroRate: [],
    }
    const reordered = {
      ...first,
      receivables: [...first.receivables].reverse(),
    }
    expect(cutoffCollectionsEqual(first, reordered)).toBe(true)
    expect(
      cutoffCollectionsEqual(first, {
        ...reordered,
        receivables: [receivable({ id: 'a', outstanding: 1300 }), receivable({ id: 'b' })],
      }),
    ).toBe(false)
  })

  it('fingerprints the exact preview and all derivation inputs canonically', () => {
    const first = {
      receivables: [receivable({ id: 'b' }), receivable({ id: 'a' })],
      payables: [payable({ id: 'p' })],
      unknownVatTreatment: [],
      strayVatOnZeroRate: [],
    }
    const reordered = { ...first, receivables: [...first.receivables].reverse() }
    const fingerprint = cutoffPreviewFingerprint({
      collection: first,
      lines: buildCutoffLines(first.receivables, first.payables, 'aktiebolag'),
      entityType: 'aktiebolag',
      periodEnd: '2026-12-31',
    })
    expect(cutoffPreviewFingerprint({
      collection: reordered,
      lines: buildCutoffLines(reordered.receivables, reordered.payables, 'aktiebolag'),
      entityType: 'aktiebolag',
      periodEnd: '2026-12-31',
    })).toBe(fingerprint)
    expect(cutoffPreviewFingerprint({
      collection: first,
      lines: buildCutoffLines(first.receivables, first.payables, 'enskild_firma'),
      entityType: 'enskild_firma',
      periodEnd: '2026-12-31',
    })).not.toBe(fingerprint)
    expect(cutoffPreviewFingerprint({
      collection: first,
      lines: buildCutoffLines(first.receivables, first.payables, 'aktiebolag'),
      entityType: 'aktiebolag',
      periodEnd: '2027-06-30',
    })).not.toBe(fingerprint)
  })

  it('requires exact cut-off lines and exact next-period reversals', async () => {
    const lines = buildCutoffLines([receivable()], [payable()])
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: lines.receivableLines,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
        lines: reverseLines(lines.receivableLines),
      },
      {
        id: 'ap', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable,
        lines: lines.payableLines,
      },
      {
        id: 'ap-rev', fiscal_period_id: 'fp-2',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal,
        lines: reverseLines(lines.payableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeJournalSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status).toMatchObject({
      complete: true,
      hasAny: true,
      receivableEntryId: 'ar',
      receivableReversalId: 'ar-rev',
      payableEntryId: 'ap',
      payableReversalId: 'ap-rev',
      missing: [],
    })
  })

  it('treats a single stale immutable marker as a conflict', async () => {
    const lines = buildCutoffLines([receivable()], [])
    const stale = lines.receivableLines.map((line) =>
      line.account_number === '1510' ? { ...line, debit_amount: 999 } : line,
    )
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: stale,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
        lines: reverseLines(lines.receivableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeJournalSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('treats an otherwise exact marker on the wrong date as a conflict', async () => {
    const lines = buildCutoffLines([receivable()], [])
    const status = await inspectKontantmetodCutoffPostings(
      makeJournalSupabase([{
        id: 'ar',
        fiscal_period_id: 'fp-1',
        entry_date: '2026-12-30',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: lines.receivableLines,
      }]),
      'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('treats multiple exact markers as a duplicate conflict', async () => {
    const lines = buildCutoffLines([receivable()], [])
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: lines.receivableLines,
      },
      {
        id: 'ar-duplicate', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: lines.receivableLines,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
        lines: reverseLines(lines.receivableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeJournalSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('fails closed when the immutable journal cannot be inspected', async () => {
    await expect(
      inspectKontantmetodCutoffPostings(
        makeJournalSupabase([], { message: 'connection lost' }),
        'co-1', 'fp-1', 'fp-2', '2026-12-31', buildCutoffLines([], []),
      ),
    ).rejects.toThrow(/kunde inte kontrolleras/i)
  })
})

describe('collectKontantmetodCutoff', () => {
  function makePagedSupabase(rows: Record<string, Array<Record<string, unknown>>>) {
    return {
      from: (table: string) => {
        let range = { from: 0, to: 999 }
        const query: Record<string, unknown> = {}
        for (const name of ['select', 'eq', 'lte', 'in', 'order']) query[name] = () => query
        query.range = (from: number, to: number) => {
          range = { from, to }
          return query
        }
        query.then = (resolve: (value: unknown) => unknown) => resolve({
          data: (rows[table] ?? []).slice(range.from, range.to + 1),
          error: null,
        })
        return query
      },
    }
  }

  it('fails closed when either reskontra query fails', async () => {
    const supabase = {
      from: (table: string) => {
        const query: Record<string, unknown> = {}
        for (const name of ['select', 'eq', 'lte', 'in', 'order', 'range']) query[name] = () => query
        query.then = (resolve: (value: unknown) => unknown) => resolve({
          data: table === 'supplier_invoices' ? [] : null,
          error: table === 'invoices' ? { message: 'read failed' } : null,
        })
        return query
      },
    }
    await expect(
      collectKontantmetodCutoff(supabase as never, 'co-1', '2026-01-01', '2026-12-31'),
    ).rejects.toThrow(/kunde inte läsa reskontran/i)
  })

  it('fails closed when payment history cannot be reconstructed', async () => {
    const rows: Record<string, unknown[]> = {
      invoices: [{
        id: 'inv-1', invoice_number: 'F-1', invoice_date: '2026-12-01', status: 'sent',
        total: 1250, vat_amount: 250, vat_treatment: 'standard_25', document_type: 'invoice',
      }],
      supplier_invoices: [],
    }
    const supabase = {
      from: (table: string) => {
        const query: Record<string, unknown> = {}
        for (const name of ['select', 'eq', 'lte', 'in', 'order', 'range']) query[name] = () => query
        query.then = (resolve: (value: unknown) => unknown) => resolve({
          data: rows[table] ?? [],
          error: table === 'invoice_payments' ? { message: 'payment read failed' } : null,
        })
        return query
      },
    }
    await expect(
      collectKontantmetodCutoff(supabase as never, 'co-1', '2026-01-01', '2026-12-31'),
    ).rejects.toThrow(/kunde inte läsa betalningar/i)
  })

  it('keeps payments in invoice currency until the SEK balance is scaled', async () => {
    const supabase = makePagedSupabase({
      invoices: [{
        id: 'inv-eur', invoice_number: 'F-EUR', invoice_date: '2026-12-01', status: 'partially_paid',
        total: 1000, total_sek: 11500, vat_amount: 200, vat_amount_sek: 2300,
        vat_treatment: 'standard_25', document_type: 'invoice', currency: 'EUR', exchange_rate: 11.5,
      }],
      invoice_payments: [{ id: 'ip-1', invoice_id: 'inv-eur', amount: 200, payment_date: '2026-12-15' }],
      supplier_invoices: [{
        id: 'si-eur', supplier_invoice_number: 'L-EUR', invoice_date: '2026-12-01', status: 'partially_paid',
        total: 1000, total_sek: 11500, vat_amount: 200, vat_amount_sek: 2300,
        reverse_charge: false, is_credit_note: false, currency: 'EUR', exchange_rate: 11.5,
        items: [{ account_number: '5410', line_total: 800 }],
      }],
      supplier_invoice_payments: [{ id: 'sp-1', supplier_invoice_id: 'si-eur', amount: 200, payment_date: '2026-12-15' }],
    })
    const result = await collectKontantmetodCutoff(
      supabase as never, 'co-1', '2026-01-01', '2026-12-31',
    )
    expect(result.receivables[0]).toMatchObject({ outstanding: 9200, vat: 1840 })
    expect(result.payables[0]).toMatchObject({ outstanding: 9200, vat: 1840 })
  })

  // Issue #2019: a manual "Markera som betald" payment carries no bank
  // transaction. The cut-off keys on payment DATE alone, so such a row must
  // retire the fordran exactly like a bank-matched one.
  it('treats a transaction-less manual payment as settling the fordran', async () => {
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      invoices: [{
        id: 'inv-manual', invoice_number: '001', invoice_date: '2026-08-01', status: 'paid',
        total: 12500, vat_amount: 2500, vat_treatment: 'standard_25', document_type: 'invoice',
        currency: 'SEK',
      }],
      invoice_payments: [{
        id: 'ip-manual', invoice_id: 'inv-manual', amount: 12500, payment_date: '2026-08-28',
        transaction_id: null, journal_entry_id: 'je-cash',
      }],
      supplier_invoices: [],
      supplier_invoice_payments: [],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.receivables).toEqual([])
  })

  // Issue #2248: ROT/RUT under fakturamodellen. The skattereduktion is a
  // fordran on Skatteverket (1513) booked by the payment voucher itself, and
  // every settlement path records the CUSTOMER share as the payment row
  // amount, so the cut-off must measure the outstanding against
  // total - deduction_total, never the gross total.
  describe('ROT/RUT deduction (fakturamodellen, #2248)', () => {
    // Arbetskostnad 20 000 + moms 5 000 = 25 000, ROT 30 % of labor incl.
    // moms = 7 500, customer share 17 500.
    const rotInvoice = (over: Partial<Invoice> = {}) => ({
      ...makeInvoice({
        id: 'inv-rot', invoice_number: 'F-ROT', invoice_date: '2026-08-01', status: 'paid',
        subtotal: 20000, vat_amount: 5000, total: 25000, deduction_total: 7500,
        remaining_amount: 0, vat_treatment: 'standard_25',
        ...over,
      }),
    })
    const paymentOf = (amount: number) => [{
      id: 'ip-rot', invoice_id: 'inv-rot', amount, payment_date: '2026-08-28',
    }]

    it('books nothing for a ROT invoice the customer has settled in full', async () => {
      // Before the fix this produced Dr 1510 7 500 / Cr 3001 6 000 / Cr 2618
      // 1 500 while 1513 already carried the 7 500 and revenue + 2611 were
      // fully booked by the August payment voucher.
      const result = await collectKontantmetodCutoff(makePagedSupabase({
        invoices: [rotInvoice()],
        invoice_payments: paymentOf(17500),
      }) as never, 'co-1', '2026-01-01', '2026-12-31')
      expect(result.receivables).toEqual([])
      expect(buildCutoffLines(result.receivables, []).receivableLines).toEqual([])
    })

    it('carries only the customer residual on a part-paid ROT invoice, moms scaled by the customer share', async () => {
      const result = await collectKontantmetodCutoff(makePagedSupabase({
        invoices: [rotInvoice({ status: 'partially_paid', remaining_amount: 7500 })],
        invoice_payments: paymentOf(10000),
      }) as never, 'co-1', '2026-01-01', '2026-12-31')
      // 17 500 - 10 000 = 7 500 still owed by the customer, carrying
      // 5 000 * (7 500 / 17 500) = 2 142,86 of the invoice moms.
      expect(result.receivables).toEqual([
        expect.objectContaining({ id: 'inv-rot', outstanding: 7500, vat: 2142.86 }),
      ])
      const { receivableLines } = buildCutoffLines(result.receivables, [])
      expect(receivableLines.find((l) => l.account_number === '1510')?.debit_amount).toBe(7500)
      expect(receivableLines.find((l) => l.account_number === '2618')?.credit_amount).toBe(2142.86)
      expect(receivableLines.find((l) => l.account_number === '3001')?.credit_amount).toBe(5357.14)
      expect(sum(receivableLines)).toEqual({ debit: 7500, credit: 7500 })
    })

    it('puts the whole invoice moms into the final period for an unpaid ROT invoice', async () => {
      // Nothing has been booked yet, so all 5 000 of moms is unreported at
      // year end; the fordran is the customer share only (1513 is not part
      // of this cut-off).
      const result = await collectKontantmetodCutoff(makePagedSupabase({
        invoices: [rotInvoice({ status: 'sent', remaining_amount: 17500 })],
      }) as never, 'co-1', '2026-01-01', '2026-12-31')
      expect(result.receivables).toEqual([
        expect.objectContaining({ outstanding: 17500, vat: 5000 }),
      ])
    })

    it('floors an over-collected customer share at zero instead of booking a negative fordran', async () => {
      // Bank-match paths store cash received; an öre of rounding above the
      // derived share is noise (same GREATEST(0, ...) as the DB guard).
      const result = await collectKontantmetodCutoff(makePagedSupabase({
        invoices: [rotInvoice()],
        invoice_payments: paymentOf(17500.4),
      }) as never, 'co-1', '2026-01-01', '2026-12-31')
      expect(result.receivables).toEqual([])
    })

    it('nets an unpaid ROT invoice and its credit note to zero as of period end', async () => {
      // A credit note keeps deduction_total as a positive magnitude (CHECK
      // >= 0) against a negative total, so the customer share must follow
      // the sign of the total for the pair to cancel.
      const result = await collectKontantmetodCutoff(makePagedSupabase({
        invoices: [
          rotInvoice({ status: 'credited', remaining_amount: 17500 }),
          rotInvoice({
            id: 'inv-rot-credit', invoice_number: 'K-ROT', invoice_date: '2026-12-01', status: 'sent',
            subtotal: -20000, vat_amount: -5000, total: -25000, remaining_amount: -17500,
            credited_invoice_id: 'inv-rot',
          }),
        ],
      }) as never, 'co-1', '2026-01-01', '2026-12-31')
      expect(result.receivables.map((r) => r.outstanding)).toEqual([17500, -17500])
      expect(result.receivables.map((r) => r.vat)).toEqual([5000, -5000])
      expect(buildCutoffLines(result.receivables, []).receivableLines).toEqual([])
    })

    it('leaves a plain invoice with the same figures exactly as before', async () => {
      // Same 25 000 / 5 000 invoice without a deduction and 17 500 paid:
      // 7 500 genuinely remains and carries 7 500 / 25 000 of the moms.
      for (const deduction of [0, null, undefined]) {
        const result = await collectKontantmetodCutoff(makePagedSupabase({
          invoices: [{
            ...rotInvoice({ status: 'partially_paid', remaining_amount: 7500 }),
            deduction_total: deduction,
          }],
          invoice_payments: paymentOf(17500),
        }) as never, 'co-1', '2026-01-01', '2026-12-31')
        expect(result.receivables).toEqual([
          expect.objectContaining({ id: 'inv-rot', outstanding: 7500, vat: 1500 }),
        ])
        const { receivableLines } = buildCutoffLines(result.receivables, [])
        expect(receivableLines.find((l) => l.account_number === '1510')?.debit_amount).toBe(7500)
        expect(receivableLines.find((l) => l.account_number === '3001')?.credit_amount).toBe(6000)
        expect(receivableLines.find((l) => l.account_number === '2618')?.credit_amount).toBe(1500)
      }
    })
  })

  it('collects reverse-charge rate, supplier type, and scaled declaration basis', async () => {
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      supplier_invoices: [{
        id: 'si-rc', supplier_invoice_number: 'L-RC', invoice_date: '2026-12-01',
        status: 'partially_paid', total: 1000, total_sek: 11500,
        vat_amount: 0, vat_amount_sek: 0, reverse_charge: true,
        is_credit_note: false, currency: 'EUR', exchange_rate: 11.5,
        supplier: { supplier_type: 'eu_business' },
        items: [{
          account_number: '6540', line_total: 1000, vat_rate: 0,
          reverse_charge_rate: 0.12,
        }],
      }],
      supplier_invoice_payments: [{
        id: 'sp-rc', supplier_invoice_id: 'si-rc', amount: 200, payment_date: '2026-12-15',
      }],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.payables[0]).toMatchObject({
      outstanding: 9200,
      vat: 0,
      reverseCharge: true,
      reverseChargeGroups: [{
        rate: 0.12,
        base: 9200,
        nonBasisBase: 9200,
        supplierType: 'eu_business',
      }],
    })
    const lines = buildCutoffLines([], result.payables).payableLines
    expect(lines.find((line) => line.account_number === '2624')?.credit_amount).toBe(1104)
    expect(lines.find((line) => line.account_number === '2645')?.debit_amount).toBe(1104)
    expect(lines.find((line) => line.account_number === '4536')?.debit_amount).toBe(9200)
  })

  it('reads every PostgREST page instead of silently stopping at 1000 rows', async () => {
    const invoices = Array.from({ length: 1001 }, (_, index) => ({
      id: `inv-${String(index).padStart(4, '0')}`,
      invoice_number: `F-${index}`,
      invoice_date: '2026-12-01',
      status: 'sent',
      total: 100,
      total_sek: 100,
      vat_amount: 0,
      vat_amount_sek: 0,
      vat_treatment: 'exempt',
      document_type: 'invoice',
      currency: 'SEK',
      exchange_rate: 1,
    }))
    const result = await collectKontantmetodCutoff(
      makePagedSupabase({ invoices }) as never,
      'co-1', '2026-01-01', '2026-12-31',
    )
    expect(result.receivables).toHaveLength(1001)
    expect(result.receivables.at(-1)?.id).toBe('inv-1000')
  })

  it('reconstructs customer and supplier credits as of period end', async () => {
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      invoices: [
        {
          id: 'inv-original', invoice_number: 'F-1', invoice_date: '2026-11-01', status: 'credited',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          vat_treatment: 'standard_25', document_type: 'invoice', currency: 'SEK',
        },
        {
          id: 'inv-credit', invoice_number: 'K-1', invoice_date: '2026-12-01', status: 'sent',
          total: -1250, total_sek: -1250, vat_amount: -250, vat_amount_sek: -250,
          vat_treatment: 'standard_25', document_type: 'invoice', currency: 'SEK',
          credited_invoice_id: 'inv-original',
        },
      ],
      supplier_invoices: [
        {
          id: 'si-original', supplier_invoice_number: 'L-1', invoice_date: '2026-11-01', status: 'credited',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          reverse_charge: false, is_credit_note: false, currency: 'SEK',
          items: [{ account_number: '5410', line_total: 1000 }],
        },
        {
          id: 'si-credit', supplier_invoice_number: 'LK-1', invoice_date: '2026-12-01', status: 'registered',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          reverse_charge: false, is_credit_note: true, currency: 'SEK',
          credited_invoice_id: 'si-original',
          items: [{ account_number: '5410', line_total: 1000 }],
        },
      ],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.receivables.map((item) => item.outstanding)).toEqual([1250, -1250])
    expect(result.payables.map((item) => item.outstanding)).toEqual([1250, -1250])
    const lines = buildCutoffLines(result.receivables, result.payables)
    expect(lines.receivableLines).toEqual([])
    expect(lines.payableLines).toEqual([])
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

  const makeSupabase = (next: Record<string, unknown> | null, journalRows: unknown[] = []) => ({
    from: (table: string) => {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.in = () => query
      query.maybeSingle = async () => ({
        data: table === 'fiscal_periods' ? next : null,
        error: table === 'fiscal_periods' && !next ? { message: 'x' } : null,
      })
      query.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data: table === 'journal_entries'
            ? journalRows.map((row) => {
                const entry = row as Record<string, unknown>
                return {
                  ...entry,
                  entry_date: entry.entry_date ?? (
                    entry.fiscal_period_id === 'fp-next' ? '2027-01-01' : '2026-12-31'
                  ),
                }
              })
            : null,
          error: null,
        })
      return query
    },
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

  it('refuses to post a second cut-off when an earlier marker exists', async () => {
    await expect(
      postKontantmetodCutoff(
        makeSupabase(OPEN_NEXT, [{
          id: 'existing',
          fiscal_period_id: 'fp-1',
          description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
          lines: buildCutoffLines([receivable()], []).receivableLines,
        }]),
        'co-1',
        'user-1',
        baseOpts,
      ),
    ).rejects.toThrow(/delvis eller dubbelt bokförd/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('resumes with the missing payable pair after a prior receivable pair succeeded', async () => {
    const receivableLines = buildCutoffLines([receivable()], []).receivableLines
    const existingRows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: receivableLines,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-next',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
        lines: reverseLines(receivableLines),
      },
    ]
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'ap' } as never)
      .mockResolvedValueOnce({ id: 'ap-rev' } as never)

    const result = await postKontantmetodCutoff(
      makeSupabase(OPEN_NEXT, existingRows),
      'co-1',
      'user-1',
      { ...baseOpts, payables: [payable()] },
    )

    expect(result.receivableEntry?.id).toBe('ar')
    expect(result.receivableReversal?.id).toBe('ar-rev')
    expect(result.payableEntry?.id).toBe('ap')
    expect(result.payableReversal?.id).toBe('ap-rev')
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createJournalEntry).mock.calls[0]?.[3].description).toBe(
      KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable,
    )
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
    ).rejects.toMatchObject({
      name: 'KontantmetodCutoffPartialError',
      postedIds: {
        receivable_entry_id: 'je-cutoff',
        receivable_storno_entry_id: 'je-storno',
      },
      cause: expect.objectContaining({ message: 'period locked' }),
    })

    expect(vi.mocked(reverseEntry)).toHaveBeenCalledWith(
      expect.anything(), 'co-1', 'user-1', 'je-cutoff', '2026-12-31',
    )
  })

  it('reports the immutable cut-off id when the compensating storno also fails', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    vi.mocked(reverseEntry).mockRejectedValue(new Error('storno failed'))

    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts),
    ).rejects.toMatchObject({
      name: 'KontantmetodCutoffPartialError',
      postedIds: { receivable_entry_id: 'je-cutoff' },
      cause: expect.objectContaining({ message: 'period locked' }),
    })
  })

  it('reports the completed receivable pair when the payable phase fails', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'ar' } as never)
      .mockResolvedValueOnce({ id: 'ar-rev' } as never)
      .mockRejectedValueOnce(new Error('payable failed'))

    await expect(postKontantmetodCutoff(
      makeSupabase(OPEN_NEXT),
      'co-1',
      'user-1',
      { ...baseOpts, payables: [payable()] },
    )).rejects.toMatchObject({
      name: 'KontantmetodCutoffPartialError',
      postedIds: {
        receivable_entry_id: 'ar',
        receivable_reversal_entry_id: 'ar-rev',
      },
      cause: expect.objectContaining({ message: 'payable failed' }),
    })
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
  it('books the complete self-assessed pair and declaration basis at year end', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [payable({
        outstanding: 1000,
        vat: 0,
        reverseCharge: true,
        reverseChargeGroups: [{
          rate: 0.25,
          base: 1000,
          nonBasisBase: 1000,
          supplierType: 'eu_business',
        }],
        netByAccount: [{ account: '6540', amount: 1000 }],
      })],
    )
    expect(payableLines.some((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)).toBe(false)
    expect(payableLines.find((l) => l.account_number === '2645')?.debit_amount).toBe(250)
    expect(payableLines.find((l) => l.account_number === '2614')?.credit_amount).toBe(250)
    expect(payableLines.find((l) => l.account_number === '4535')?.debit_amount).toBe(1000)
    expect(payableLines.find((l) => l.account_number === '4598')?.credit_amount).toBe(1000)
    expect(payableLines.find((l) => l.account_number === '6540')?.debit_amount).toBe(1000)
    expect(payableLines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still books vilande moms for ordinary (non-RC) supplier invoices', () => {
    const { payableLines } = buildCutoffLines([], [payable({ reverseCharge: false })])
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
  })
})
