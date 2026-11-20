import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

// The edge-case-1 rättelse goes through correctEntry; its own storno/rättelse
// mechanics are pinned by storno-service's tests.
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  correctEntry: vi.fn(),
}))

// The carry's underlag anchoring (best-effort, never throws): its own query
// shape is pinned by lib/core/documents/__tests__.
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({
  anchorCustomerInvoiceDocument: vi.fn(),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn(),
}))

import {
  assessKontantmetodCutoff,
  buildCutoffLines,
  buildCutoffNote,
  buildKontantmetodCarryLines,
  buildKontantmetodCarryPlan,
  carryBusinessEventFacts,
  cutoffPreviewFingerprint,
  collectKontantmetodCutoff,
  distributeOre,
  inspectKontantmetodCutoffPostings,
  KONTANTMETOD_CUTOFF_CHUNK_SIZE,
  KONTANTMETOD_CUTOFF_DESCRIPTIONS,
  KontantmetodCutoffPartialError,
  kontantmetodCarryDescription,
  postKontantmetodCutoff,
  buildPaidBeforePostingCorrectionLines,
  buildKontantmetodManualCarryPlan,
  isCarryClearingVerifikat,
  KontantmetodCorrectionError,
  KontantmetodManualCarryError,
  resolveKontantmetodManualCarries,
  paidBeforePostingCorrectionDescription,
  previewPaidBeforePostingCorrections,
  nextDay,
  reverseLines,
  VILANDE_INPUT_VAT_ACCOUNT,
  VILANDE_OUTPUT_VAT_ACCOUNTS,
} from '../kontantmetod-cutoff'
import type {
  CutoffPayable,
  CutoffReceivable,
  KontantmetodCarryDoc,
  KontantmetodCarryPlan,
  PaidBeforePosting,
} from '../kontantmetod-cutoff'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import type { Invoice, InvoiceItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { roundOre } from '@/lib/money'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import {
  buildCreditNoteLines,
  buildInvoiceRegistrationLines,
  headerToSekOrThrow,
} from '@/lib/bookkeeping/invoice-lines'
import { supplierInvoiceRegistrationLines } from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { anchorCustomerInvoiceDocument } from '@/lib/core/documents/customer-invoice-underlag'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { makeInvoice, makeSupplierInvoice } from '@/tests/helpers'

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

/** The per-invoice lists of a collection with nothing in them. */
const PER_INVOICE_EMPTY = {
  rowlessSupplierInvoices: [],
  carries: [],
  rotPartialManual: [],
  rotPartialManualInvoices: [],
  paidBeforePosting: [],
  paidBeforePostingManual: [],
  legacyCovered: [],
}

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
    const { receivableLines } = buildCutoffLines([receivable()], [], 'aktiebolag')

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
      'aktiebolag',
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
      'aktiebolag',
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
      'aktiebolag',
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
      'aktiebolag',
    )
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expect(receivableLines.find((l) => l.account_number === '3305')?.credit_amount).toBe(5000)
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('splits goods delivered abroad (#2906) from services on the same treatment', () => {
    // An unpaid goods export books its cut-off revenue where its own verifikat
    // will (3105, ruta 36); a services export stays on 3305 (ruta 40).
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'inv-goods', vatTreatment: 'export', goodsDeliveryCountry: 'NO', outstanding: 5000, vat: 0 }),
        receivable({ id: 'inv-svc', vatTreatment: 'export', outstanding: 2000, vat: 0 }),
      ],
      [],
      'aktiebolag',
    )
    expect(receivableLines.find((l) => l.account_number === '3105')?.credit_amount).toBe(5000)
    expect(receivableLines.find((l) => l.account_number === '3305')?.credit_amount).toBe(2000)
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('books an unpaid domestic reverse charge invoice on 3231 with no moms (crm#1007)', () => {
    // Construction services under omvänd betalningsskyldighet carry no output
    // moms for the seller: the whole outstanding amount is ruta 41 revenue.
    const { receivableLines } = buildCutoffLines(
      [receivable({ id: 'inv-bygg', vatTreatment: 'reverse_charge_domestic', outstanding: 8000, vat: 0 })],
      [],
      'enskild_firma',
    )
    expect(receivableLines.find((l) => l.account_number === '3231')?.credit_amount).toBe(8000)
    expect(receivableLines.find((l) => l.account_number === '1510')?.debit_amount).toBe(8000)
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
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
      'aktiebolag',
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  })

  it('emits nothing when there is nothing outstanding', () => {
    expect(buildCutoffLines([], [], 'aktiebolag').receivableLines).toEqual([])
    expect(buildCutoffLines([receivable({ outstanding: 0, vat: 0 })], [], 'aktiebolag').receivableLines).toEqual([])
  })
})

describe('buildCutoffLines: skulder', () => {
  it('books the payable against expense and VILANDE input moms', () => {
    const { payableLines } = buildCutoffLines([], [payable()], 'aktiebolag')

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
      'aktiebolag',
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
      'aktiebolag',
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.credit).toBe(100.01)
  })

  it('falls back to a generic expense account when item detail is missing', () => {
    const { payableLines } = buildCutoffLines([], [payable({ netByAccount: [] })], 'aktiebolag')
    expect(payableLines.find((l) => l.account_number === '6990')?.debit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('books customer and supplier credit notes with opposite polarity', () => {
    const lines = buildCutoffLines(
      [receivable({ outstanding: -1250, vat: -250 })],
      [payable({ outstanding: -1250, vat: -250 })],
      'aktiebolag',
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
    const { receivableLines } = buildCutoffLines([receivable()], [], 'aktiebolag')
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
  // The finder reads marker rows from kontantmetod_cutoff_entries with the
  // journal entry embedded, so fixtures declare a `kind` and never a
  // description: the grundbok text is display only.
  const makeMarkerSupabase = (
    rows: Array<Record<string, unknown>>,
    error: { message: string } | null = null,
  ) => ({
    from: () => {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.in = () => query
      query.then = (resolve: (value: unknown) => unknown) => resolve({
        data: rows.map(({ kind, ...entry }) => ({
          kind,
          entry: {
            status: 'posted',
            entry_date: entry.fiscal_period_id === 'fp-2' ? '2027-01-01' : '2026-12-31',
            ...entry,
          },
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
      undatedSettlements: ['F-9', 'F-8'],
      ...PER_INVOICE_EMPTY,
    }
    const reordered = {
      ...first,
      receivables: [...first.receivables].reverse(),
      undatedSettlements: [...first.undatedSettlements].reverse(),
    }
    const fingerprintOf = (collection: typeof first) => cutoffPreviewFingerprint({
      collection,
      lines: buildCutoffLines(collection.receivables, collection.payables, 'aktiebolag'),
      entityType: 'aktiebolag',
      periodEnd: '2026-12-31',
    })
    expect(fingerprintOf(reordered)).toBe(fingerprintOf(first))
    expect(
      fingerprintOf({
        ...reordered,
        receivables: [receivable({ id: 'a', outstanding: 1300 }), receivable({ id: 'b' })],
      }),
    ).not.toBe(fingerprintOf(first))
    // The disclosure is part of what the approver saw: a preview whose
    // assumed invoices changed is stale even when the lines did not move.
    expect(
      fingerprintOf({ ...reordered, undatedSettlements: ['F-9'] }),
    ).not.toBe(fingerprintOf(first))
  })

  it('fingerprints the exact preview and all derivation inputs canonically', () => {
    const first = {
      receivables: [receivable({ id: 'b' }), receivable({ id: 'a' })],
      payables: [payable({ id: 'p' })],
      unknownVatTreatment: [],
      strayVatOnZeroRate: [],
      undatedSettlements: [],
      ...PER_INVOICE_EMPTY,
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
    const lines = buildCutoffLines([receivable()], [payable()], 'aktiebolag')
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        kind: 'receivable',
        lines: lines.receivableLines,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        kind: 'receivable_reversal',
        lines: reverseLines(lines.receivableLines),
      },
      {
        id: 'ap', fiscal_period_id: 'fp-1',
        kind: 'payable',
        lines: lines.payableLines,
      },
      {
        id: 'ap-rev', fiscal_period_id: 'fp-2',
        kind: 'payable_reversal',
        lines: reverseLines(lines.payableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
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
    const lines = buildCutoffLines([receivable()], [], 'aktiebolag')
    const stale = lines.receivableLines.map((line) =>
      line.account_number === '1510' ? { ...line, debit_amount: 999 } : line,
    )
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        kind: 'receivable',
        lines: stale,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        kind: 'receivable_reversal',
        lines: reverseLines(lines.receivableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('treats an otherwise exact marker on the wrong date as a conflict', async () => {
    const lines = buildCutoffLines([receivable()], [], 'aktiebolag')
    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase([{
        id: 'ar',
        fiscal_period_id: 'fp-1',
        entry_date: '2026-12-30',
        kind: 'receivable',
        lines: lines.receivableLines,
      }]),
      'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('treats multiple exact markers as a duplicate conflict', async () => {
    const lines = buildCutoffLines([receivable()], [], 'aktiebolag')
    const rows = [
      {
        id: 'ar', fiscal_period_id: 'fp-1',
        kind: 'receivable',
        lines: lines.receivableLines,
      },
      {
        id: 'ar-duplicate', fiscal_period_id: 'fp-1',
        kind: 'receivable',
        lines: lines.receivableLines,
      },
      {
        id: 'ar-rev', fiscal_period_id: 'fp-2',
        kind: 'receivable_reversal',
        lines: reverseLines(lines.receivableLines),
      },
    ]

    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase(rows), 'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.complete).toBe(false)
    expect(status.missing).toContain('receivable')
    expect(status.duplicates).toContain(KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable)
  })

  it('finds the pair through its markers whatever the grundbok text says', async () => {
    // The point of the marker table: identity is recorded, not spelled out.
    // These entries carry a description no filter would ever match, and the
    // finder is unmoved.
    const lines = buildCutoffLines([receivable()], [], 'aktiebolag')
    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase([
        {
          id: 'ar', fiscal_period_id: 'fp-1', description: 'Omformulerad text 2027',
          kind: 'receivable', lines: lines.receivableLines,
        },
        {
          id: 'ar-rev', fiscal_period_id: 'fp-2', description: 'Helt annan text',
          kind: 'receivable_reversal', lines: reverseLines(lines.receivableLines),
        },
      ]),
      'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status).toMatchObject({
      complete: true,
      receivableEntryId: 'ar',
      receivableReversalId: 'ar-rev',
      missing: [],
      duplicates: [],
    })
  })

  it('reads a stornoed cut-off as absent so a replacement pair can be posted', async () => {
    // Posted rows are never edited, so a stornoed cut-off keeps its marker.
    // Treating it as live would block the year permanently.
    const lines = buildCutoffLines([receivable()], [], 'aktiebolag')
    const status = await inspectKontantmetodCutoffPostings(
      makeMarkerSupabase([{
        id: 'ar', fiscal_period_id: 'fp-1', status: 'reversed',
        kind: 'receivable', lines: lines.receivableLines,
      }]),
      'co-1', 'fp-1', 'fp-2', '2026-12-31', lines,
    )
    expect(status.hasAny).toBe(false)
    expect(status.receivableEntryId).toBeNull()
    expect(status.duplicates).toEqual([])
    expect(status.missing).toEqual(['receivable', 'receivable_reversal'])
  })

  it('fails closed when the marked cut-off cannot be inspected', async () => {
    await expect(
      inspectKontantmetodCutoffPostings(
        makeMarkerSupabase([], { message: 'connection lost' }),
        'co-1', 'fp-1', 'fp-2', '2026-12-31', buildCutoffLines([], [], 'aktiebolag'),
      ),
    ).rejects.toThrow(/kunde inte kontrolleras/i)
  })
})

describe('collectKontantmetodCutoff', () => {
  type Row = Record<string, unknown>
  // Only the credit-note read (fetchCreditedAfter) uses gt() and not(). They
  // are applied as PostgREST does, so a credit note dated on or before period
  // end, or a voided one, never reads as a later credit.
  function applyCreditNoteFilters(query: Record<string, unknown>, keep: Array<(row: Row) => boolean>) {
    // The per-invoice collector reads only unlinked invoices (#3440).
    query.is = (column: string, value: unknown) => {
      keep.push((row) => (value === null ? row[column] == null : row[column] === value))
      return query
    }
    // The carry builders read the full rows of the open invoices by id.
    query.in = (column: string, values: unknown[]) => {
      keep.push((row) => values.includes(row[column]))
      return query
    }
    query.gt = (column: string, value: string) => {
      keep.push((row) => String(row[column] ?? '') > value)
      return query
    }
    query.not = (column: string, op: string, value: unknown) => {
      if (op === 'is' && value === null) keep.push((row) => row[column] != null)
      if (op === 'in') {
        const excluded = String(value).replace(/[()]/g, '').split(',')
        keep.push((row) => !excluded.includes(String(row[column])))
      }
      return query
    }
  }

  function makePagedSupabase(rows: Record<string, Array<Row>>) {
    return {
      from: (table: string) => {
        let range: { from: number; to: number } | null = null
        const keep: Array<(row: Row) => boolean> = []
        const query: Record<string, unknown> = {}
        for (const name of ['select', 'eq', 'lte', 'in', 'order']) query[name] = () => query
        applyCreditNoteFilters(query, keep)
        query.range = (from: number, to: number) => {
          range = { from, to }
          return query
        }
        query.then = (resolve: (value: unknown) => unknown) => resolve({
          data: (rows[table] ?? [])
            .filter((row) => keep.every((test) => test(row)))
            .slice(range?.from ?? 0, range ? range.to + 1 : undefined),
          error: null,
        })
        return query
      },
    }
  }

  // makePagedSupabase ignores lte(), so it cannot tell a December payment or
  // credit note from a January one. This one applies it, as PostgREST does:
  // the collector reads every payment row and dates them itself.
  function makeDateFilteringSupabase(rows: Record<string, Array<Row>>) {
    return {
      from: (table: string) => {
        const keep: Array<(row: Row) => boolean> = []
        const query: Record<string, unknown> = {}
        for (const name of ['select', 'eq', 'in', 'order', 'range']) query[name] = () => query
        query.lte = (column: string, value: string) => {
          keep.push((row) => String(row[column]) <= value)
          return query
        }
        applyCreditNoteFilters(query, keep)
        query.then = (resolve: (value: unknown) => unknown) => resolve({
          data: (rows[table] ?? []).filter((row) => keep.every((test) => test(row))),
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
        for (const name of ['select', 'eq', 'lte', 'in', 'order', 'range', 'is', 'gt', 'not']) query[name] = () => query
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
        for (const name of ['select', 'eq', 'lte', 'in', 'order', 'range', 'is', 'gt', 'not']) query[name] = () => query
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

  // A konstaterad kundförlust gives the invoice the status written_off from
  // the day of the decision. Written off after period end, the claim was
  // still open at period end and is a fordran; written off by then, it is not.
  it('counts an invoice written off after period end, and not one written off by then', async () => {
    const invoice = (id: string, number: string, total: number) => ({
      id, invoice_number: number, invoice_date: '2026-09-01', status: 'written_off',
      total, vat_amount: total / 5, vat_treatment: 'standard_25', document_type: 'invoice',
      currency: 'SEK', paid_amount: 0,
    })
    const result = await collectKontantmetodCutoff(makeDateFilteringSupabase({
      invoices: [invoice('inv-later', '101', 12500), invoice('inv-before', '102', 6250)],
      invoice_write_offs: [
        { id: 'w-later', invoice_id: 'inv-later', kind: 'confirmed', reverses_id: null, entry_date: '2027-02-01' },
        { id: 'w-before', invoice_id: 'inv-before', kind: 'confirmed', reverses_id: null, entry_date: '2026-11-15' },
      ],
      invoice_payments: [],
      supplier_invoices: [],
      supplier_invoice_payments: [],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.receivables).toHaveLength(1)
    expect(result.receivables[0]).toMatchObject({ outstanding: 12500, vat: 2500 })
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

  // A migrated supplier invoice arrives settled (status 'paid') with no payment
  // row: the provider names neither a payment date nor a payment voucher. The
  // cut-off follows the leverantörsreskontra's as-of rule: a payment row is
  // authoritative, then paid_at, and with neither the state it has today is
  // assumed to have stood at period end and disclosed (feedback seq 798354).
  // attach_supplier_invoice_settlement_voucher writes the row that replaces
  // the assumption, dated at the verifikat that paid it.
  describe('migrated supplier invoice settled without a payment row', () => {
    const migratedPaid = {
      id: 'si-migrated', supplier_invoice_number: 'L-MIG', invoice_date: '2026-12-10', status: 'paid',
      total: 1250, vat_amount: 250, reverse_charge: false, is_credit_note: false, currency: 'SEK',
      paid_amount: 1250, remaining_amount: 0, paid_at: null as string | null,
      items: [{ account_number: '5410', line_total: 1000 }],
    }
    const collect = (
      payments: Array<Record<string, unknown>>,
      invoice: Record<string, unknown> = migratedPaid,
    ) =>
      collectKontantmetodCutoff(makeDateFilteringSupabase({
        invoices: [],
        invoice_payments: [],
        supplier_invoices: [invoice],
        supplier_invoice_payments: payments,
      }) as never, 'co-1', '2026-01-01', '2026-12-31')

    it('leaves it out and discloses it as undated while nothing dates the settlement', async () => {
      const result = await collect([])
      expect(result.payables).toEqual([])
      expect(result.undatedSettlements).toEqual(['L-MIG'])
    })

    it('keeps it when paid_at says it was settled after period end', async () => {
      const result = await collect([], { ...migratedPaid, paid_at: '2027-01-15T08:00:00Z' })
      expect(result.payables[0]).toMatchObject({ outstanding: 1250, vat: 250 })
      expect(result.undatedSettlements).toEqual([])
    })

    it('drops it once the evidence row is dated on or before period end', async () => {
      const result = await collect([{
        id: 'sp-evidence', supplier_invoice_id: 'si-migrated', amount: 1250, payment_date: '2026-12-20',
        transaction_id: null, journal_entry_id: 'je-v342',
      }])
      expect(result.payables).toEqual([])
      expect(result.undatedSettlements).toEqual([])
    })

    // The reason the row is dated at the verifikat and not at the invoice: a
    // December invoice paid in January WAS a skuld on 31 December.
    it('keeps it when the verifikat that paid it is dated after period end', async () => {
      const result = await collect([{
        id: 'sp-evidence', supplier_invoice_id: 'si-migrated', amount: 1250, payment_date: '2027-01-08',
        transaction_id: null, journal_entry_id: 'je-v7',
      }])
      expect(result.payables[0]).toMatchObject({ outstanding: 1250, vat: 250 })
      expect(result.undatedSettlements).toEqual([])
    })

    it('does not disclose an unpaid invoice: nothing about it is assumed', async () => {
      const result = await collect([], {
        ...migratedPaid, status: 'registered', paid_amount: 0, remaining_amount: 1250,
      })
      expect(result.payables[0]).toMatchObject({ outstanding: 1250, vat: 250 })
      expect(result.undatedSettlements).toEqual([])
    })
  })

  // Feedback seq 798354: a company migrated from Fortnox had every customer
  // invoice imported as paid (paid_amount = total) with neither a payment row
  // nor a payment date, and the cut-off proposed the whole invoiced history as
  // year-end fordringar. The kundreskontra's as-of rule decides instead.
  describe('customer invoice settled without a payment row (feedback seq 798354)', () => {
    const migratedPaid = {
      id: 'inv-migrated', invoice_number: 'F-MIG', invoice_date: '2026-11-30', status: 'paid',
      total: 1250, vat_amount: 250, vat_treatment: 'standard_25', document_type: 'invoice',
      currency: 'SEK', paid_amount: 1250, remaining_amount: 0, paid_at: null as string | null,
    }
    const collect = (
      invoices: Array<Record<string, unknown>>,
      payments: Array<Record<string, unknown>> = [],
    ) =>
      collectKontantmetodCutoff(makePagedSupabase({
        invoices,
        invoice_payments: payments,
      }) as never, 'co-1', '2026-01-01', '2026-12-31')

    it('leaves a migrated paid invoice out of the cut-off and discloses it as undated', async () => {
      const result = await collect([migratedPaid])
      expect(result.receivables).toEqual([])
      expect(result.undatedSettlements).toEqual(['F-MIG'])
    })

    it('keeps it when paid_at says it was paid after period end', async () => {
      const result = await collect([{ ...migratedPaid, paid_at: '2027-01-20T09:00:00Z' }])
      expect(result.receivables).toEqual([
        expect.objectContaining({ id: 'inv-migrated', outstanding: 1250, vat: 250 }),
      ])
      expect(result.undatedSettlements).toEqual([])
    })

    it('drops it without a disclosure when paid_at is on or before period end', async () => {
      const result = await collect([{ ...migratedPaid, paid_at: '2026-12-31T10:00:00Z' }])
      expect(result.receivables).toEqual([])
      expect(result.undatedSettlements).toEqual([])
    })

    it('still counts it as outstanding when a real payment row is dated after period end', async () => {
      const result = await collect([migratedPaid], [{
        id: 'ip-late', invoice_id: 'inv-migrated', amount: 1250, payment_date: '2027-01-08',
      }])
      expect(result.receivables).toEqual([
        expect.objectContaining({ id: 'inv-migrated', outstanding: 1250, vat: 250 }),
      ])
      expect(result.undatedSettlements).toEqual([])
    })

    it('carries only the undated remainder of a partial payment, and discloses it', async () => {
      const result = await collect([{
        ...migratedPaid, status: 'partially_paid', paid_amount: 500, remaining_amount: 750,
      }])
      expect(result.receivables).toEqual([
        expect.objectContaining({ outstanding: 750, vat: 150 }),
      ])
      expect(result.undatedSettlements).toEqual(['F-MIG'])
    })

    it('does not disclose an unpaid invoice: nothing about it is assumed', async () => {
      const result = await collect([{
        ...migratedPaid, status: 'sent', paid_amount: 0, remaining_amount: 1250,
      }])
      expect(result.receivables).toEqual([expect.objectContaining({ outstanding: 1250 })])
      expect(result.undatedSettlements).toEqual([])
    })

    // The reporting company's own pair: Fortnox netted the kreditfaktura into
    // the balance of the invoice it credits (imported paid, paid_amount =
    // total), and the importer wrote the credit note inert at 'credited'.
    // Counting it once its original is taken as settled would book a phantom
    // negative fordran of the whole credit.
    it('treats a migrated credit note as settled with the invoice it was netted into', async () => {
      const result = await collect([
        {
          ...migratedPaid, id: 'inv-original', invoice_number: '10',
          total: 133750, vat_amount: 26750, paid_amount: 133750,
        },
        {
          ...migratedPaid, id: 'inv-credit', invoice_number: '11', invoice_date: '2026-12-03',
          status: 'credited', total: -133750, vat_amount: -26750, paid_amount: 0,
        },
      ])
      expect(result.receivables).toEqual([])
      expect(result.undatedSettlements).toEqual(['10', '11'])
      expect(buildCutoffLines(result.receivables, [], 'aktiebolag').receivableLines).toEqual([])
    })
  })

  // A kreditfaktura settles its original on its own date. Kreditera zeroes a
  // supplier original's remaining_amount and a migrated original holds the
  // provider's netted balance, so the live state alone would read a credit
  // made after period end as a settlement on the day.
  describe('original credited after period end', () => {
    const periodEnd = '2025-12-31'
    const supplierOriginal = {
      id: 'si-orig', supplier_invoice_number: 'L-10', invoice_date: '2025-12-10', status: 'credited',
      total: 1000, total_sek: 1000, vat_amount: 200, vat_amount_sek: 200, reverse_charge: false,
      is_credit_note: false, currency: 'SEK', paid_amount: 0, remaining_amount: 0, paid_at: null,
      items: [{ account_number: '5410', line_total: 800 }],
    }
    const supplierCredit = (invoiceDate: string) => ({
      ...supplierOriginal, id: 'si-credit', supplier_invoice_number: 'KREDIT-L-10',
      invoice_date: invoiceDate, is_credit_note: true, credited_invoice_id: 'si-orig',
    })
    const customerOriginal = {
      id: 'inv-orig', invoice_number: '10', invoice_date: '2025-12-10', status: 'credited',
      total: 1000, total_sek: 1000, vat_amount: 200, vat_amount_sek: 200,
      vat_treatment: 'standard_25', document_type: 'invoice', currency: 'SEK',
      paid_amount: 0, remaining_amount: 1000, paid_at: null,
    }
    const customerCredit = (invoiceDate: string, over: Row = {}) => ({
      ...customerOriginal, id: 'inv-credit', invoice_number: 'KR-10', invoice_date: invoiceDate,
      status: 'sent', total: -1000, total_sek: -1000, vat_amount: -200, vat_amount_sek: -200,
      remaining_amount: 0, credited_invoice_id: 'inv-orig', ...over,
    })
    // What a provider migration writes for the same pair: the original paid
    // with the credit netted in, the credit note inert at 'credited'.
    const migratedOriginal = { ...customerOriginal, status: 'paid', paid_amount: 1000, remaining_amount: 0 }
    const collect = (rows: Record<string, Array<Row>>) =>
      collectKontantmetodCutoff(
        makeDateFilteringSupabase(rows) as never, 'co-1', '2025-01-01', periodEnd,
      )

    it('keeps a supplier invoice credited with Kreditera after period end at its full total', async () => {
      const result = await collect({
        supplier_invoices: [supplierOriginal, supplierCredit('2026-01-15')],
      })
      expect(result.payables).toEqual([
        expect.objectContaining({ id: 'si-orig', outstanding: 1000, vat: 200 }),
      ])
      expect(result.undatedSettlements).toEqual([])
    })

    it('still nets a supplier invoice credited on or before period end to zero', async () => {
      const result = await collect({
        supplier_invoices: [supplierOriginal, supplierCredit('2025-12-20')],
      })
      expect(result.payables).toEqual([])
      expect(buildCutoffLines([], result.payables, 'aktiebolag').payableLines).toEqual([])
    })

    it('keeps a customer invoice credited after period end at its full total', async () => {
      for (const [original, credit] of [
        [customerOriginal, customerCredit('2026-01-15')],
        [migratedOriginal, customerCredit('2026-01-15', { status: 'credited' })],
      ]) {
        const result = await collect({ invoices: [original, credit] })
        expect(result.receivables).toEqual([
          expect.objectContaining({ id: 'inv-orig', outstanding: 1000, vat: 200 }),
        ])
        expect(result.undatedSettlements).toEqual([])
      }
    })

    it('still nets a customer invoice credited on or before period end to zero', async () => {
      for (const [original, credit] of [
        [customerOriginal, customerCredit('2025-12-20')],
        [migratedOriginal, customerCredit('2025-12-20', { status: 'credited' })],
      ]) {
        const result = await collect({ invoices: [original, credit] })
        expect(buildCutoffLines(result.receivables, [], 'aktiebolag').receivableLines).toEqual([])
      }
    })

    it('does not count a credit note that never took effect', async () => {
      // A kreditfaktura started in January and left as a draft credited
      // nothing: the migrated original's settlement stays the undated one.
      const result = await collect({
        invoices: [migratedOriginal, customerCredit('2026-01-15', { status: 'draft' })],
      })
      expect(result.receivables).toEqual([])
      expect(result.undatedSettlements).toEqual(['10'])
    })

    it('fails closed when the credit notes cannot be read', async () => {
      const supabase = {
        from: (table: string) => {
          let creditNoteRead = false
          const query: Record<string, unknown> = {}
          for (const name of ['select', 'eq', 'lte', 'in', 'order', 'range', 'not', 'is']) query[name] = () => query
          query.gt = () => {
            creditNoteRead = true
            return query
          }
          query.then = (resolve: (value: unknown) => unknown) => resolve(
            creditNoteRead && table === 'supplier_invoices'
              ? { data: null, error: { message: 'credit note read failed' } }
              : { data: [], error: null },
          )
          return query
        },
      }
      await expect(
        collectKontantmetodCutoff(supabase as never, 'co-1', '2025-01-01', periodEnd),
      ).rejects.toThrow(/kunde inte läsa kreditfakturor/i)
    })
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
      expect(buildCutoffLines(result.receivables, [], 'aktiebolag').receivableLines).toEqual([])
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
      const { receivableLines } = buildCutoffLines(result.receivables, [], 'aktiebolag')
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
      expect(buildCutoffLines(result.receivables, [], 'aktiebolag').receivableLines).toEqual([])
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
        const { receivableLines } = buildCutoffLines(result.receivables, [], 'aktiebolag')
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
        kind: 'eu_services',
      }],
    })
    const lines = buildCutoffLines([], result.payables, 'aktiebolag').payableLines
    expect(lines.find((line) => line.account_number === '2624')?.credit_amount).toBe(1104)
    expect(lines.find((line) => line.account_number === '2645')?.debit_amount).toBe(1104)
    expect(lines.find((line) => line.account_number === '4536')?.debit_amount).toBe(9200)
  })

  it('carries an EU goods purchase to its own basis box, apart from EU services (crm#1323)', async () => {
    const invoice = (id: string, kind: string | null) => ({
      id, supplier_invoice_number: id, invoice_date: '2026-12-01',
      status: 'registered', total: 1000, total_sek: 1000, remaining_amount: 1000,
      vat_amount: 0, vat_amount_sek: 0, reverse_charge: true, reverse_charge_kind: kind,
      is_credit_note: false, currency: 'SEK', exchange_rate: 1,
      supplier: { supplier_type: 'eu_business' },
      items: [{ account_number: '4010', line_total: 1000, vat_rate: 0, reverse_charge_rate: null }],
    })
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      supplier_invoices: [invoice('si-goods', 'eu_goods'), invoice('si-services', null)],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.payables.map((p) => p.reverseChargeGroups?.[0].kind)).toEqual(['eu_goods', 'eu_services'])
    const lines = buildCutoffLines([], result.payables, 'aktiebolag').payableLines
    expect(lines.find((line) => line.account_number === '4515')?.debit_amount).toBe(1000)
    expect(lines.find((line) => line.account_number === '4535')?.debit_amount).toBe(1000)
    const outputVat = lines.filter((line) => line.account_number === '2614')
    expect(outputVat.reduce((sum, line) => sum + line.credit_amount, 0)).toBe(500)
  })

  it('takes no basis pair for an item on an account whose momskod reports ruta 20-24 itself (crm#1096)', async () => {
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      chart_of_accounts: [{ account_number: '4056', account_class: 4, default_vat_treatment: 'reverse_charge_eu_goods' }],
      supplier_invoices: [{
        id: 'si-rc-own', supplier_invoice_number: 'L-RC2', invoice_date: '2026-12-01',
        status: 'registered', total: 1000, total_sek: 1000, remaining_amount: 1000,
        vat_amount: 0, vat_amount_sek: 0, reverse_charge: true,
        is_credit_note: false, currency: 'SEK', exchange_rate: 1,
        supplier: { supplier_type: 'eu_business' },
        items: [
          { account_number: '4056', line_total: 600, vat_rate: 0, reverse_charge_rate: null },
          { account_number: '6540', line_total: 400, vat_rate: 0, reverse_charge_rate: null },
        ],
      }],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.payables[0].reverseChargeGroups).toEqual([{
      rate: 0.25, base: 1000, nonBasisBase: 400, kind: 'eu_services',
    }])
    const lines = buildCutoffLines([], result.payables, 'aktiebolag').payableLines
    expect(lines.find((line) => line.account_number === '2614')?.credit_amount).toBe(250)
    expect(lines.find((line) => line.account_number === '4535')?.debit_amount).toBe(400)
    expect(lines.find((line) => line.account_number === '4598')?.credit_amount).toBe(400)
  })

  it('self-assesses an item on an account at 12 % at that sats, without a pair (crm#1096)', async () => {
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      chart_of_accounts: [{ account_number: '4057', account_class: 4, default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.12 }],
      supplier_invoices: [{
        id: 'si-rc-12', supplier_invoice_number: 'L-RC3', invoice_date: '2026-12-01',
        status: 'registered', total: 1000, total_sek: 1000, remaining_amount: 1000,
        vat_amount: 0, vat_amount_sek: 0, reverse_charge: true,
        is_credit_note: false, currency: 'SEK', exchange_rate: 1,
        supplier: { supplier_type: 'eu_business' },
        items: [
          { account_number: '4057', line_total: 600, vat_rate: 0, reverse_charge_rate: null },
          { account_number: '6540', line_total: 400, vat_rate: 0, reverse_charge_rate: null },
        ],
      }],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.payables[0].reverseChargeGroups).toEqual([
      { rate: 0.12, base: 600, nonBasisBase: 0, kind: 'eu_services' },
      { rate: 0.25, base: 400, nonBasisBase: 400, kind: 'eu_services' },
    ])
    const lines = buildCutoffLines([], result.payables, 'aktiebolag').payableLines
    expect(lines.find((line) => line.account_number === '2624')?.credit_amount).toBe(72)
    expect(lines.find((line) => line.account_number === '2614')?.credit_amount).toBe(100)
    expect(lines.find((line) => line.account_number === '4535')?.debit_amount).toBe(400)
    expect(lines.some((line) => line.account_number === '4516')).toBe(false)
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

  it('nets customer and supplier credits to zero as of period end', async () => {
    // The rows as the in-app credit flows leave them. Customer side: the
    // original moves to 'credited' with paid_amount untouched and the credit
    // note rests at 'sent', so the pair offsets line by line. Supplier side:
    // Kreditera zeroes the original's remaining_amount and the credit note
    // rests at 'credited' with nothing remaining, so the credit is already
    // applied and neither row enters the cut-off. No payment row dates that
    // settlement, so both are disclosed.
    const result = await collectKontantmetodCutoff(makePagedSupabase({
      invoices: [
        {
          id: 'inv-original', invoice_number: 'F-1', invoice_date: '2026-11-01', status: 'credited',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          vat_treatment: 'standard_25', document_type: 'invoice', currency: 'SEK',
          paid_amount: 0, remaining_amount: 1250,
        },
        {
          id: 'inv-credit', invoice_number: 'K-1', invoice_date: '2026-12-01', status: 'sent',
          total: -1250, total_sek: -1250, vat_amount: -250, vat_amount_sek: -250,
          vat_treatment: 'standard_25', document_type: 'invoice', currency: 'SEK',
          credited_invoice_id: 'inv-original', paid_amount: 0, remaining_amount: 0,
        },
      ],
      supplier_invoices: [
        {
          id: 'si-original', supplier_invoice_number: 'L-1', invoice_date: '2026-11-01', status: 'credited',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          reverse_charge: false, is_credit_note: false, currency: 'SEK',
          paid_amount: 0, remaining_amount: 0,
          items: [{ account_number: '5410', line_total: 1000 }],
        },
        {
          id: 'si-credit', supplier_invoice_number: 'LK-1', invoice_date: '2026-12-01', status: 'credited',
          total: 1250, total_sek: 1250, vat_amount: 250, vat_amount_sek: 250,
          reverse_charge: false, is_credit_note: true, currency: 'SEK',
          credited_invoice_id: 'si-original', paid_amount: 0, remaining_amount: 0,
          items: [{ account_number: '5410', line_total: 1000 }],
        },
      ],
    }) as never, 'co-1', '2026-01-01', '2026-12-31')
    expect(result.receivables.map((item) => item.outstanding)).toEqual([1250, -1250])
    expect(result.payables).toEqual([])
    expect(result.undatedSettlements).toEqual(['L-1', 'LK-1'])
    const lines = buildCutoffLines(result.receivables, result.payables, 'aktiebolag')
    expect(lines.receivableLines).toEqual([])
    expect(lines.payableLines).toEqual([])
  })
})

// ===========================================================================
// Per-invoice årsomföring (#3440)
// ===========================================================================

type TRow = Record<string, unknown>

/**
 * A PostgREST stand-in that APPLIES eq / in / is / lte / gt / not filters and
 * paging to seeded tables, and answers rpc() from a queue. The per-invoice
 * collector's behaviour is entirely a question of which rows each read
 * selects, so the filters must run.
 */
function makeTableSupabase(
  tables: Record<string, TRow[]>,
  rpcResults: Array<{ data: unknown; error: unknown }> = [],
) {
  const rpc = vi.fn(async () => rpcResults.shift() ?? { data: { ok: true }, error: null })
  const from = vi.fn((table: string) => {
    const keep: Array<(row: TRow) => boolean> = []
    let range: { from: number; to: number } | null = null
    const query: Record<string, unknown> = {}
    query.select = () => query
    query.order = () => query
    query.limit = () => query
    query.eq = (column: string, value: unknown) => {
      keep.push((row) => row[column] === value)
      return query
    }
    query.in = (column: string, values: unknown[]) => {
      keep.push((row) => values.includes(row[column]))
      return query
    }
    query.is = (column: string, value: unknown) => {
      keep.push((row) => (value === null ? row[column] == null : row[column] === value))
      return query
    }
    query.lte = (column: string, value: string) => {
      keep.push((row) => String(row[column] ?? '') <= value)
      return query
    }
    query.gt = (column: string, value: string) => {
      keep.push((row) => String(row[column] ?? '') > value)
      return query
    }
    query.not = (column: string, op: string, value: unknown) => {
      if (op === 'is' && value === null) keep.push((row) => row[column] != null)
      if (op === 'in') {
        const excluded = String(value).replace(/[()]/g, '').split(',')
        keep.push((row) => !excluded.includes(String(row[column])))
      }
      return query
    }
    query.range = (fromIndex: number, to: number) => {
      range = { from: fromIndex, to }
      return query
    }
    const rows = () => (tables[table] ?? [])
      .filter((row) => keep.every((test) => test(row)))
      .slice(range?.from ?? 0, range ? range.to + 1 : undefined)
    query.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
    query.single = query.maybeSingle
    query.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: null })
    return query
  })
  return { from, rpc }
}

function customerItem(over: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    ...over,
  } as InvoiceItem
}

function supplierItem(over: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  return {
    id: 'si-item-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Rad',
    quantity: 1,
    unit: 'st',
    unit_price: 400,
    line_total: 400,
    account_number: '6110',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 100,
    reverse_charge_rate: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** Customer invoice F: 1 000 + 250 moms = 1 250, open on 2026-12-31. */
function customerDoc(
  over: Partial<Extract<KontantmetodCarryDoc, { side: 'customer' }>> = {},
  invoiceOver: Record<string, unknown> = {},
): KontantmetodCarryDoc {
  const invoice = {
    ...makeInvoice({
      id: 'inv-1', invoice_number: 'F-1', invoice_date: '2026-11-15', status: 'sent',
      subtotal: 1000, vat_amount: 250, total: 1250, remaining_amount: 1250,
    }),
    items: [customerItem()],
    ...invoiceOver,
  }
  return {
    side: 'customer',
    invoice: invoice as never,
    reference: 'F-1',
    creditNote: false,
    outstandingOwn: Number(invoice.total),
    customerShareOwn: Number(invoice.total),
    ...over,
  }
}

/** Supplier invoice L: 400 + 100 = 500, open on 2026-12-31. */
function supplierDoc(
  over: Partial<Extract<KontantmetodCarryDoc, { side: 'supplier' }>> = {},
  invoiceOver: Partial<SupplierInvoice> = {},
): KontantmetodCarryDoc {
  const invoice = makeSupplierInvoice({
    id: 'si-1', supplier_invoice_number: 'L-1', arrival_number: 7, invoice_date: '2026-11-20',
    subtotal: 400, vat_amount: 100, total: 500, remaining_amount: 500,
    ...invoiceOver,
  })
  return {
    side: 'supplier',
    invoice,
    items: [supplierItem()],
    supplierType: 'swedish_business',
    reference: 'L-1',
    creditNote: false,
    outstandingOwn: Number(invoice.total),
    totalOwn: Number(invoice.total),
    ...over,
  }
}

const lineOn = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>, account: string) =>
  lines.filter((l) => l.account_number === account)
    .reduce((s, l) => roundOre(s + l.debit_amount - l.credit_amount), 0)

describe('buildKontantmetodCarryLines (årsomföring per invoice)', () => {
  it('carries an unpaid invoice as its own registration verifikat, without 29xx', () => {
    // A periodiserad line: faktureringsmetoden would credit 29xx and let a
    // schedule dissolve it. Under kontantmetoden no schedule exists.
    const doc = customerDoc({}, {
      items: [
        customerItem(),
        customerItem({
          id: 'item-2', sort_order: 1, line_total: 400, unit_price: 400, vat_amount: 100,
          accrual_period_start: '2026-12-01', accrual_period_end: '2027-05-31',
        }),
      ],
      subtotal: 1400, vat_amount: 350, total: 1750,
    })
    const built = buildKontantmetodCarryLines({ ...doc, outstandingOwn: 1750, customerShareOwn: 1750 } as never, 'aktiebolag')
    expect(built.mode).toBe('full')
    expect(built.lines).toEqual(buildInvoiceRegistrationLines(
      (doc as Extract<KontantmetodCarryDoc, { side: 'customer' }>).invoice, 'aktiebolag', null, { deferAccruals: false },
    ))
    expect(built.lines.some((l) => l.account_number.startsWith('29'))).toBe(false)
    expect(lineOn(built.lines, '1510')).toBe(1750)
    expect(lineOn(built.lines, '2611')).toBe(-350)
    expect(built.anchorSek).toBe(1750)
  })

  it('keeps the currency metadata on 1510 for a foreign invoice', () => {
    // EUR 100 + 25 at 11.00: moms locked at the invoice rate.
    const doc = customerDoc({ outstandingOwn: 125, customerShareOwn: 125 }, {
      currency: 'EUR', exchange_rate: 11, subtotal: 100, vat_amount: 25, total: 125,
      items: [customerItem({ unit_price: 100, line_total: 100, vat_amount: 25 })],
    })
    const { lines } = buildKontantmetodCarryLines(doc, 'aktiebolag')
    const ar = lines.find((l) => l.account_number === '1510')!
    expect(ar).toMatchObject({ debit_amount: 1375, currency: 'EUR', amount_in_currency: 125, exchange_rate: 11 })
    expect(lineOn(lines, '2611')).toBe(-275)
  })

  it('books the full ROT/RUT shape: customer share on 1510, Skatteverket on 1513', () => {
    const items = [customerItem({
      unit_price: 10000, line_total: 10000, vat_amount: 2500, deduction_type: 'rot',
    } as Partial<InvoiceItem>)]
    const doc = customerDoc({}, { items, subtotal: 10000, vat_amount: 2500, total: 12500 })
    const registration = buildInvoiceRegistrationLines(
      (doc as Extract<KontantmetodCarryDoc, { side: 'customer' }>).invoice, 'aktiebolag', null, { deferAccruals: false },
    )
    const deduction = lineOn(registration, '1513')
    expect(deduction).toBeGreaterThan(0)
    const built = buildKontantmetodCarryLines(
      { ...doc, outstandingOwn: roundOre(12500 - deduction), customerShareOwn: roundOre(12500 - deduction) } as never,
      'aktiebolag',
    )
    expect(built.mode).toBe('full')
    expect(built.lines).toEqual(registration)
    expect(lineOn(built.lines, '1510')).toBe(roundOre(12500 - deduction))
    // Full revenue and moms in the closed year.
    expect(lineOn(built.lines, '2611')).toBe(-2500)
  })

  it('carries an open customer credit note as its credit-note verifikat (151x credit)', () => {
    const doc = customerDoc({ creditNote: true, outstandingOwn: -625, customerShareOwn: -625 }, {
      id: 'cn-1', invoice_number: 'K-1', credited_invoice_id: 'inv-0',
      subtotal: -500, vat_amount: -125, total: -625,
      items: [customerItem({ unit_price: -500, quantity: 1, line_total: -500, vat_amount: -125 })],
    })
    const built = buildKontantmetodCarryLines(doc, 'aktiebolag')
    expect(built.mode).toBe('full')
    expect(built.lines).toEqual(buildCreditNoteLines(
      (doc as Extract<KontantmetodCarryDoc, { side: 'customer' }>).invoice, 'aktiebolag', undefined, { deferAccruals: false },
    ))
    expect(lineOn(built.lines, '1510')).toBe(-625)
  })

  it('carries a supplier invoice as its registration lines minus 17xx', () => {
    const items = [
      supplierItem(),
      supplierItem({
        id: 'si-item-2', account_number: '5420', line_total: 1200, vat_amount: 300,
        accrual_period_start: '2026-12-01', accrual_period_end: '2027-11-30',
        accrual_balance_account: '1790',
      }),
    ]
    const doc = supplierDoc({ items, outstandingOwn: 2000, totalOwn: 2000 }, {
      subtotal: 1600, vat_amount: 400, total: 2000,
    })
    const built = buildKontantmetodCarryLines(doc, 'aktiebolag')
    const invoice = (doc as Extract<KontantmetodCarryDoc, { side: 'supplier' }>).invoice
    const registration = supplierInvoiceRegistrationLines(
      invoice, items, 'swedish_business',
      `Leverantörsfaktura ${invoice.supplier_invoice_number} (ankomstnr ${invoice.arrival_number})`, undefined,
    )
    expect(registration.some((l) => l.account_number === '1790')).toBe(true)
    expect(built.mode).toBe('full')
    // The registration lines with the periodiserad line on its own cost
    // account: nothing else moves.
    expect(built.lines).toEqual(registration.map((l) =>
      l.account_number === '1790' ? { ...l, account_number: '5420' } : l,
    ))
    expect(lineOn(built.lines, '2440')).toBe(-2000)
    expect(lineOn(built.lines, '2641')).toBe(400)
  })

  it('carries a reverse-charge supplier invoice with its 2614/2645 pair and basis lines', () => {
    const items = [supplierItem({
      account_number: '6540', line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25,
    })]
    const doc = supplierDoc({ items, supplierType: 'eu_business', chart: new Map(), outstandingOwn: 1000, totalOwn: 1000 }, {
      subtotal: 1000, vat_amount: 0, total: 1000, reverse_charge: true, vat_treatment: 'reverse_charge',
    })
    const { lines } = buildKontantmetodCarryLines(doc, 'aktiebolag')
    expect(lineOn(lines, '2440')).toBe(-1000)
    expect(lineOn(lines, '2614')).toBe(-250)
    expect(lineOn(lines, '2645')).toBe(250)
    // Ruta 21/22 basis (EU services: 4535 + 4598 motkonto) nets to zero.
    expect(lines.some((l) => l.account_number === '4598')).toBe(true)
  })

  it('scales a partly settled invoice onto the ORDINARY moms accounts', () => {
    // Edge case 7: 500 incl. 100 moms paid in the closed year, 750 open.
    const doc = customerDoc({ outstandingOwn: 750 })
    const built = buildKontantmetodCarryLines(doc, 'aktiebolag')
    expect(built.mode).toBe('proportional')
    expect(lineOn(built.lines, '1510')).toBe(750)
    expect(lineOn(built.lines, '3001')).toBe(-600)
    expect(lineOn(built.lines, '2611')).toBe(-150)
    expect(built.lines.some((l) => l.account_number.startsWith('261') && l.account_number !== '2611')).toBe(false)
    expect(built.lines.some((l) => ['2618', '2628', '2638', '2648'].includes(l.account_number))).toBe(false)
  })

  it('books an FX partial on 1510 at exactly what the year-2 clearing credits, to the öre', () => {
    // EUR 333.33 open of 1 000.01 at 11.3713: the clearing path converts the
    // outstanding with headerToSekOrThrow(outstanding, null, currency, rate).
    const doc = customerDoc({ outstandingOwn: 333.33, customerShareOwn: 1000.01 }, {
      currency: 'EUR', exchange_rate: 11.3713, subtotal: 800.01, vat_amount: 200, total: 1000.01,
      total_sek: 11371.41,
      items: [customerItem({ unit_price: 800.01, line_total: 800.01, vat_amount: 200 })],
    })
    const built = buildKontantmetodCarryLines(doc, 'aktiebolag')
    const clearingSek = headerToSekOrThrow(333.33, null, 'EUR', 11.3713)
    expect(lineOn(built.lines, '1510')).toBe(clearingSek)
    expect(built.anchorSek).toBe(clearingSek)
    expect(built.lines.find((l) => l.account_number === '1510')).toMatchObject({ amount_in_currency: 333.33 })
    const debit = built.lines.reduce((s, l) => s + Math.round(l.debit_amount * 100), 0)
    const credit = built.lines.reduce((s, l) => s + Math.round(l.credit_amount * 100), 0)
    expect(debit).toBe(credit)
  })

  it('scales a partly paid supplier invoice and keeps it balanced', () => {
    const doc = supplierDoc({ outstandingOwn: 200 })
    const built = buildKontantmetodCarryLines(doc, 'aktiebolag')
    expect(built.mode).toBe('proportional')
    expect(lineOn(built.lines, '2440')).toBe(-200)
    expect(lineOn(built.lines, '6110')).toBe(160)
    expect(lineOn(built.lines, '2641')).toBe(40)
  })

  it('names the invoice when the carry cannot be built', () => {
    const doc = customerDoc({ outstandingOwn: 125, customerShareOwn: 125 }, {
      currency: 'EUR', exchange_rate: null, subtotal: 100, vat_amount: 25, total: 125,
      items: [customerItem({ unit_price: 100, line_total: 100, vat_amount: 25 })],
    })
    expect(() => buildKontantmetodCarryPlan(doc, 'aktiebolag')).toThrow(/faktura F-1 kunde inte byggas/)
  })

  it('plans a year_end text that can never collide with the legacy race guard', () => {
    const plan = buildKontantmetodCarryPlan(customerDoc(), 'aktiebolag')
    expect(plan).toMatchObject({
      side: 'customer', invoiceId: 'inv-1', mode: 'full', total: 1250,
      description: 'Kundfaktura F-1: obetald vid bokslut (kontantmetoden)',
      notes: 'Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura F-1',
    })
    const legacy = Object.values(KONTANTMETOD_CUTOFF_DESCRIPTIONS) as string[]
    for (const side of ['customer', 'supplier'] as const) {
      for (const creditNote of [false, true]) {
        expect(legacy).not.toContain(kontantmetodCarryDescription(side, 'X-1', creditNote))
      }
    }
  })
})

/** Seed rows for the per-invoice collector: one open customer and supplier invoice. */
function cashTables(extra: Record<string, TRow[]> = {}): Record<string, TRow[]> {
  return {
    invoices: [{
      id: 'inv-1', company_id: 'co-1', invoice_number: 'F-1', invoice_date: '2026-11-15',
      status: 'sent', currency: 'SEK', exchange_rate: null, subtotal: 1000, total: 1250,
      vat_amount: 250, vat_treatment: 'standard_25', document_type: 'invoice',
      paid_amount: 0, remaining_amount: 1250, journal_entry_id: null,
      items: [customerItem()],
    }],
    supplier_invoices: [{
      id: 'si-1', company_id: 'co-1', supplier_invoice_number: 'L-1', arrival_number: 7,
      invoice_date: '2026-11-20', status: 'registered', currency: 'SEK', exchange_rate: null,
      subtotal: 400, vat_amount: 100, total: 500, remaining_amount: 500,
      reverse_charge: false, is_credit_note: false, vat_treatment: 'standard_25',
      registration_journal_entry_id: null,
      supplier: { supplier_type: 'swedish_business' },
      items: [supplierItem()],
    }],
    invoice_payments: [],
    supplier_invoice_payments: [],
    journal_entries: [],
    kontantmetod_cutoff_entries: [],
    ...extra,
  }
}

const collectPerInvoice = (
  tables: Record<string, TRow[]>,
  options: Parameters<typeof collectKontantmetodCutoff>[4] = {},
) => collectKontantmetodCutoff(
  makeTableSupabase(tables) as never, 'co-1', '2026-01-01', '2026-12-31', options,
)

describe('collectKontantmetodCutoff: per-invoice årsomföring', () => {
  it('carries each unlinked open invoice with its full row and items', async () => {
    const result = await collectPerInvoice(cashTables())
    expect(result.carries.map((c) => `${c.side}:${c.invoice.id}`)).toEqual(['customer:inv-1', 'supplier:si-1'])
    const customer = result.carries.find((c) => c.side === 'customer')!
    expect(customer).toMatchObject({ outstandingOwn: 1250, reference: 'F-1', creditNote: false })
    expect((customer as Extract<KontantmetodCarryDoc, { side: 'customer' }>).invoice.items).toHaveLength(1)
    const supplier = result.carries.find((c) => c.side === 'supplier') as Extract<KontantmetodCarryDoc, { side: 'supplier' }>
    expect(supplier).toMatchObject({ outstandingOwn: 500, totalOwn: 500, supplierType: 'swedish_business' })
  })

  // An invoice booked at issue before a switch to kontantmetoden, or carried
  // by an earlier run, sits on 1510 / 2440 already: carrying it again books
  // it twice (the method-switch double carry).
  it('never carries an invoice that is linked to a verifikat', async () => {
    const tables = cashTables()
    tables.invoices![0] = { ...tables.invoices![0], journal_entry_id: 'je-reg' }
    tables.supplier_invoices![0] = { ...tables.supplier_invoices![0], registration_journal_entry_id: 'je-sreg' }
    const result = await collectPerInvoice(tables)
    expect(result.carries).toEqual([])
    expect(result.receivables).toEqual([])
    // Legacy mode still reads every invoice, exactly as the legacy cut-off did.
    const legacy = await collectPerInvoice(tables, { mode: 'legacy' })
    expect(legacy.receivables.map((r) => r.id)).toEqual(['inv-1'])
    expect(legacy.payables.map((p) => p.id)).toEqual(['si-1'])
    expect(legacy.carries).toEqual([])
  })

  // A provider migration imports a supplier invoice as its header when the
  // source has no rows (Bokio, crm#1712). Its carry would book 2440 against
  // nothing ("balanserar inte" for the whole cut-off): name it instead.
  it('names an open supplier invoice with no rows instead of carrying it', async () => {
    const tables = cashTables()
    tables.supplier_invoices![0] = {
      ...tables.supplier_invoices![0], supplier_invoice_number: null, subtotal: 500, vat_amount: 0, items: [],
    }
    const result = await collectPerInvoice(tables)
    expect(result.rowlessSupplierInvoices).toEqual(['ankomstnr 7'])
    expect(result.carries.map((c) => `${c.side}:${c.invoice.id}`)).toEqual(['customer:inv-1'])
    // Legacy mode reads the header total as before and lists nothing.
    const legacy = await collectPerInvoice(tables, { mode: 'legacy' })
    expect(legacy.rowlessSupplierInvoices).toEqual([])
    expect(legacy.payables.map((p) => p.id)).toEqual(['si-1'])
  })

  it('does not list a supplier invoice with no rows that was paid by period end', async () => {
    const tables = cashTables({
      supplier_invoice_payments: [{
        id: 'sp-1', company_id: 'co-1', supplier_invoice_id: 'si-1', amount: 500,
        payment_date: '2026-12-01', journal_entry_id: 'je-scash',
      }],
    })
    tables.supplier_invoices![0] = {
      ...tables.supplier_invoices![0], status: 'paid', remaining_amount: 0, items: [],
    }
    const result = await collectPerInvoice(tables)
    expect(result.rowlessSupplierInvoices).toEqual([])
    expect(result.carries.filter((c) => c.side === 'supplier')).toEqual([])
  })

  it('skips a credit note and its original that net to nothing, keeps a partial credit', async () => {
    const credit = (amount: number): TRow => ({
      id: 'cn-1', company_id: 'co-1', invoice_number: 'K-1', invoice_date: '2026-12-10',
      status: 'sent', currency: 'SEK', subtotal: -amount * 0.8, total: -amount, vat_amount: -amount * 0.2,
      vat_treatment: 'standard_25', document_type: 'invoice', credited_invoice_id: 'inv-1',
      paid_amount: 0, journal_entry_id: null,
    })
    const netted = await collectPerInvoice({ ...cashTables(), invoices: [...cashTables().invoices!, credit(1250)] })
    expect(netted.carries.filter((c) => c.side === 'customer')).toEqual([])

    const partial = await collectPerInvoice({ ...cashTables(), invoices: [...cashTables().invoices!, credit(250)] })
    expect(partial.carries.filter((c) => c.side === 'customer')
      .map((c) => [c.invoice.id, c.outstandingOwn, c.creditNote])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([['cn-1', -250, true], ['inv-1', 1250, false]])
  })

  it('refuses to carry a ROT invoice with anything paid in the closed year', async () => {
    const tables = cashTables({
      invoices: [{
        ...cashTables().invoices![0], subtotal: 10000, total: 12500, vat_amount: 2500,
        deduction_total: 3750, paid_amount: 4000, status: 'partially_paid',
      }],
      invoice_payments: [{ id: 'p-1', company_id: 'co-1', invoice_id: 'inv-1', amount: 4000, payment_date: '2026-12-01', journal_entry_id: 'je-cash' }],
    })
    const result = await collectPerInvoice(tables)
    expect(result.rotPartialManual).toEqual(['F-1'])
    expect(result.carries.filter((c) => c.side === 'customer')).toEqual([])
    // Open customer share 8750 - 4000 = 4750 (of 8750); Skatteverket's
    // share of the open part only: 3750 * 4750 / 8750.
    expect(result.rotPartialManualInvoices).toEqual([{
      invoiceId: 'inv-1', reference: 'F-1', creditNote: false,
      openCustomerShareSek: 4750, openDeductionSek: roundOre(3750 * 4750 / 8750), openPartHasVat: true,
    }])
  })

  it('carries an unpaid ROT invoice at its customer share (1513 comes from the builder)', async () => {
    const tables = cashTables({
      invoices: [{ ...cashTables().invoices![0], subtotal: 10000, total: 12500, vat_amount: 2500, deduction_total: 3750 }],
    })
    const result = await collectPerInvoice(tables)
    expect(result.carries[0]).toMatchObject({ side: 'customer', outstandingOwn: 8750, customerShareOwn: 8750 })
    expect(result.rotPartialManual).toEqual([])
  })

  describe('paid after period end, before the cut-off posts (edge case 1)', () => {
    const cashEntry = (over: TRow = {}): TRow => ({
      id: 'je-cash', company_id: 'co-1', status: 'posted', source_type: 'invoice_cash_payment',
      source_id: 'inv-1', entry_date: '2027-01-14', ...over,
    })
    const payment = (over: TRow = {}): TRow => ({
      id: 'pay-1', company_id: 'co-1', invoice_id: 'inv-1', amount: 1250,
      payment_date: '2027-01-14', journal_entry_id: 'je-cash', ...over,
    })
    const paidTables = (entry: TRow | null, rows: TRow[] = [payment()]) => {
      const tables = cashTables({ invoice_payments: rows, journal_entries: entry ? [entry] : [] })
      tables.invoices![0] = { ...tables.invoices![0], status: 'paid', paid_amount: 1250, remaining_amount: 0 }
      return tables
    }

    it('lists a generated cash verifikat that settles only this invoice', async () => {
      const result = await collectPerInvoice(paidTables(cashEntry()))
      // Still open on period end: carried, and its cash verifikat corrected.
      expect(result.carries.map((c) => c.invoice.id)).toContain('inv-1')
      expect(result.paidBeforePosting).toEqual([{
        side: 'customer', invoiceId: 'inv-1', reference: 'F-1', entryId: 'je-cash',
        entryDate: '2027-01-14', paymentRowId: 'pay-1', paymentAmount: 1250, carryEntryId: null,
      }])
      expect(result.paidBeforePostingManual).toEqual([])
    })

    it('lists a supplier cash verifikat the same way', async () => {
      const tables = cashTables({
        supplier_invoice_payments: [{
          id: 'sp-1', company_id: 'co-1', supplier_invoice_id: 'si-1', amount: 500,
          payment_date: '2027-01-20', journal_entry_id: 'je-scash',
        }],
        journal_entries: [cashEntry({ id: 'je-scash', source_type: 'supplier_invoice_cash_payment', source_id: 'si-1', entry_date: '2027-01-20' })],
      })
      const result = await collectPerInvoice(tables)
      expect(result.paidBeforePosting).toEqual([expect.objectContaining({
        side: 'supplier', invoiceId: 'si-1', entryId: 'je-scash', paymentRowId: 'sp-1',
      })])
    })

    it('sends a verifikat shared with another invoice (a batch) to the manual list', async () => {
      const tables = paidTables(cashEntry(), [payment(), payment({ id: 'pay-2', invoice_id: 'inv-other' })])
      const result = await collectPerInvoice(tables)
      expect(result.paidBeforePosting).toEqual([])
      expect(result.paidBeforePostingManual).toEqual([expect.objectContaining({
        invoiceId: 'inv-1', entryId: 'je-cash', reason: 'shared_verifikat',
      })])
    })

    it('sends a manual or SIE voucher to the manual list', async () => {
      for (const sourceType of ['manual', 'sie_import']) {
        const result = await collectPerInvoice(paidTables(cashEntry({ source_type: sourceType, source_id: null })))
        expect(result.paidBeforePosting).toEqual([])
        expect(result.paidBeforePostingManual).toEqual([expect.objectContaining({ reason: 'not_generated_cash_entry' })])
      }
    })

    it('sends a payment row without a verifikat to the manual list', async () => {
      const result = await collectPerInvoice(paidTables(null, [payment({ journal_entry_id: null })]))
      expect(result.paidBeforePostingManual).toEqual([expect.objectContaining({ reason: 'no_verifikat', entryId: null })])
    })

    it('lists nothing once the cash verifikat is corrected (reversed)', async () => {
      const result = await collectPerInvoice(paidTables(cashEntry({ status: 'reversed' })))
      expect(result.paidBeforePosting).toEqual([])
      expect(result.paidBeforePostingManual).toEqual([])
    })

    it('ignores a payment on or before period end (it closed the invoice in the year)', async () => {
      const result = await collectPerInvoice(paidTables(cashEntry({ entry_date: '2026-12-20' }), [payment({ payment_date: '2026-12-20' })]))
      expect(result.paidBeforePosting).toEqual([])
      expect(result.carries.map((c) => c.invoice.id)).not.toContain('inv-1')
    })

    it('resumes: an already carried invoice whose cash verifikat is still uncorrected', async () => {
      const tables = paidTables(cashEntry())
      tables.invoices![0] = { ...tables.invoices![0], journal_entry_id: 'je-carry' }
      const result = await collectPerInvoice(tables, {
        liveCarries: { customer: new Map([['inv-1', { entryId: 'je-carry', reference: 'F-1' }]]), supplier: new Map() },
      })
      expect(result.carries.map((c) => c.invoice.id)).not.toContain('inv-1')
      expect(result.paidBeforePosting).toEqual([expect.objectContaining({
        invoiceId: 'inv-1', entryId: 'je-cash', carryEntryId: 'je-carry',
      })])
    })

    const clearingLines = [
      { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1250 },
    ]
    const revenueLines = [
      { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
    ]
    const carriedTables = (entry: TRow | null, rows?: TRow[]) => {
      const tables = paidTables(entry, rows)
      tables.invoices![0] = { ...tables.invoices![0], journal_entry_id: 'je-carry' }
      return tables
    }
    const carried = { customer: new Map([['inv-1', { entryId: 'je-carry', reference: 'F-1' }]]), supplier: new Map() }

    it('leaves a carried invoice cleared against 1510 alone', async () => {
      const result = await collectPerInvoice(
        carriedTables(cashEntry({ source_type: 'invoice_paid', lines: clearingLines })),
        { liveCarries: carried },
      )
      expect(result.paidBeforePosting).toEqual([])
      expect(result.paidBeforePostingManual).toEqual([])
    })

    // Review of #3440: a verifikat not generated by the cash door was dropped
    // by its source_type once the carry was live, so a manual Dr 1930 /
    // Cr 3001 / Cr 2611 declared the moms again and readiness said complete.
    it('keeps a manual revenue-and-moms voucher of a carried invoice on the manual list, judged by its lines', async () => {
      for (const sourceType of ['manual', 'sie_import', 'invoice_paid', 'bank_transaction']) {
        const result = await collectPerInvoice(
          carriedTables(cashEntry({ source_type: sourceType, source_id: null, lines: revenueLines })),
          { liveCarries: carried },
        )
        expect(result.paidBeforePosting).toEqual([])
        expect(result.paidBeforePostingManual).toEqual([expect.objectContaining({
          invoiceId: 'inv-1', entryId: 'je-cash', entryDate: '2027-01-14', reason: 'not_generated_cash_entry',
        })])
      }
    })

    it('drops a manual clearing voucher (Dr 1930 / Cr 1510), carried or about to be carried', async () => {
      const entry = cashEntry({ source_type: 'manual', source_id: null, lines: clearingLines })
      const afterCarry = await collectPerInvoice(carriedTables(entry), { liveCarries: carried })
      expect(afterCarry.paidBeforePostingManual).toEqual([])
      const beforeCarry = await collectPerInvoice(paidTables(entry))
      expect(beforeCarry.paidBeforePostingManual).toEqual([])
      expect(beforeCarry.carries.map((c) => c.invoice.id)).toContain('inv-1')
    })

    it('keeps a payment row without a verifikat listed after the carry too', async () => {
      const result = await collectPerInvoice(
        carriedTables(null, [payment({ journal_entry_id: null })]),
        { liveCarries: carried },
      )
      expect(result.paidBeforePostingManual).toEqual([expect.objectContaining({ reason: 'no_verifikat', entryId: null })])
    })

    it('judges a supplier payment voucher by its 2440 debit', async () => {
      const supplierTables = (lines: TRow[]) => {
        const tables = cashTables({
          supplier_invoice_payments: [{
            id: 'sp-1', company_id: 'co-1', supplier_invoice_id: 'si-1', amount: 500,
            payment_date: '2027-01-20', journal_entry_id: 'je-s',
          }],
          journal_entries: [cashEntry({ id: 'je-s', source_type: 'manual', source_id: null, entry_date: '2027-01-20', lines })],
        })
        tables.supplier_invoices![0] = { ...tables.supplier_invoices![0], registration_journal_entry_id: 'je-scarry' }
        return tables
      }
      const supplierCarried = { customer: new Map(), supplier: new Map([['si-1', { entryId: 'je-scarry', reference: 'L-1' }]]) }
      const clearing = await collectPerInvoice(supplierTables([
        { account_number: '2440', debit_amount: 500, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 500 },
      ]), { liveCarries: supplierCarried })
      expect(clearing.paidBeforePostingManual).toEqual([])
      const cost = await collectPerInvoice(supplierTables([
        { account_number: '6110', debit_amount: 400, credit_amount: 0 },
        { account_number: '2641', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 500 },
      ]), { liveCarries: supplierCarried })
      expect(cost.paidBeforePostingManual).toEqual([expect.objectContaining({
        side: 'supplier', invoiceId: 'si-1', reason: 'not_generated_cash_entry',
      })])
    })

    it('keeps readiness incomplete while a carried invoice has a manual revenue-and-moms voucher', async () => {
      const tables = carriedTables(cashEntry({ source_type: 'manual', source_id: null, lines: revenueLines }))
      tables.supplier_invoices = []
      tables.kontantmetod_cutoff_entries = [{
        id: 'm-1', company_id: 'co-1', kind: 'receivable_invoice', fiscal_period_id: 'fp-1',
        invoice_id: 'inv-1', supplier_invoice_id: null, journal_entry_id: 'je-carry',
        entry: { id: 'je-carry', entry_date: '2026-12-31', status: 'posted' },
      }]
      const period = { id: 'fp-1', period_start: '2026-01-01', period_end: '2026-12-31' }
      const manual = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag')
      expect(manual.plans).toEqual([])
      expect(manual.collection.paidBeforePostingManual).toHaveLength(1)
      expect(manual.complete).toBe(false)

      tables.journal_entries = [cashEntry({ source_type: 'manual', source_id: null, lines: clearingLines })]
      const cleared = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag')
      expect(cleared.complete).toBe(true)
    })
  })

  describe('isCarryClearingVerifikat', () => {
    const line = (account_number: string, debit_amount: number, credit_amount: number) =>
      ({ account_number, debit_amount, credit_amount })

    it('takes a clearing with the settlement accounts the payment may touch', () => {
      expect(isCarryClearingVerifikat('customer', false, [line('1930', 1250, 0), line('1510', 0, 1250)])).toBe(true)
      expect(isCarryClearingVerifikat('customer', false, [
        line('1930', 1249.6, 0), line('3740', 0.4, 0), line('1510', 0, 1250),
      ])).toBe(true)
      expect(isCarryClearingVerifikat('customer', false, [
        line('1930', 1300, 0), line('1510', 0, 1250), line('3960', 0, 50),
      ])).toBe(true)
      expect(isCarryClearingVerifikat('customer', false, [line('1930', 3750, 0), line('1513', 0, 3750)])).toBe(true)
      expect(isCarryClearingVerifikat('supplier', false, [
        line('2440', 500, 0), line('6570', 5, 0), line('1930', 0, '505' as unknown as number),
      ])).toBe(true)
    })

    it('refuses revenue, cost, moms and a movement the wrong way', () => {
      expect(isCarryClearingVerifikat('customer', false, [
        line('1930', 1250, 0), line('3001', 0, 1000), line('2611', 0, 250),
      ])).toBe(false)
      expect(isCarryClearingVerifikat('customer', false, [
        line('1930', 1250, 0), line('1510', 0, 1000), line('2611', 0, 250),
      ])).toBe(false)
      expect(isCarryClearingVerifikat('customer', false, [line('1510', 1250, 0), line('1930', 0, 1250)])).toBe(false)
      expect(isCarryClearingVerifikat('supplier', false, [line('2440', 0, 500), line('1930', 500, 0)])).toBe(false)
      expect(isCarryClearingVerifikat('customer', false, [])).toBe(false)
    })

    it('mirrors both for a credit note', () => {
      expect(isCarryClearingVerifikat('customer', true, [line('1510', 250, 0), line('1930', 0, 250)])).toBe(true)
      expect(isCarryClearingVerifikat('customer', true, [line('1930', 250, 0), line('1510', 0, 250)])).toBe(false)
      expect(isCarryClearingVerifikat('supplier', true, [line('1930', 100, 0), line('2440', 0, 100)])).toBe(true)
    })
  })

  // Review of #3440: update_overdue_supplier_invoices turns every unpaid
  // supplier invoice past due 'overdue' every night, so by the bokslut most
  // open supplier invoices were silently left out of the carry.
  it('carries an overdue or disputed supplier invoice still owed on period end', async () => {
    for (const status of ['overdue', 'disputed']) {
      const tables = cashTables()
      tables.supplier_invoices![0] = { ...tables.supplier_invoices![0], status }
      const result = await collectPerInvoice(tables)
      expect(result.carries.map((c) => `${c.side}:${c.invoice.id}`)).toContain('supplier:si-1')
    }
  })

  it('keeps the legacy collection on the statuses a legacy cut-off was judged by', async () => {
    const tables = cashTables()
    tables.supplier_invoices![0] = { ...tables.supplier_invoices![0], status: 'overdue' }
    const legacy = await collectKontantmetodCutoff(
      makeTableSupabase(tables) as never, 'co-1', '2026-01-01', '2026-12-31', { mode: 'legacy' },
    )
    expect(legacy.payables).toEqual([])
  })

  describe('legacy-covered invoices (self-hosted legacy cut-offs)', () => {
    const legacy2025 = [{ fiscalPeriodId: 'fp-2025', periodEnd: '2025-12-31', receivable: true, payable: false }]
    const oldInvoice = (): TRow => ({ ...cashTables().invoices![0], id: 'inv-old', invoice_number: 'F-OLD', invoice_date: '2025-11-01' })

    it('withholds an invoice a legacy cut-off already covered', async () => {
      const result = await collectPerInvoice(
        { ...cashTables(), invoices: [oldInvoice(), ...cashTables().invoices!] },
        { legacyCutoffs: legacy2025 },
      )
      expect(result.legacyCovered).toEqual([{
        side: 'customer', invoiceId: 'inv-old', reference: 'F-OLD', legacyPeriodEnd: '2025-12-31',
      }])
      expect(result.carries.map((c) => c.invoice.id)).toEqual(['inv-1', 'si-1'])
    })

    it('carries it once the byrå acknowledges it', async () => {
      const result = await collectPerInvoice(
        { ...cashTables(), invoices: [oldInvoice(), ...cashTables().invoices!] },
        { legacyCutoffs: legacy2025, acknowledgedLegacyInvoiceIds: ['inv-old'] },
      )
      expect(result.legacyCovered).toEqual([])
      expect(result.carries.map((c) => c.invoice.id)).toContain('inv-old')
    })

    it('does not withhold the side the legacy cut-off did not cover', async () => {
      const oldSupplier: TRow = { ...cashTables().supplier_invoices![0], id: 'si-old', invoice_date: '2025-10-01' }
      const result = await collectPerInvoice(
        { ...cashTables(), supplier_invoices: [oldSupplier] },
        { legacyCutoffs: legacy2025 },
      )
      expect(result.legacyCovered).toEqual([])
      expect(result.carries.map((c) => c.invoice.id)).toContain('si-old')
    })
  })
})

describe('assessKontantmetodCutoff', () => {
  const period = { id: 'fp-1', period_start: '2026-01-01', period_end: '2026-12-31' }

  it('plans one carry per open invoice and is complete only when every list is empty', async () => {
    const open = await assessKontantmetodCutoff(
      makeTableSupabase(cashTables()) as never, 'co-1', period, null, 'aktiebolag',
    )
    expect(open.mode).toBe('per_invoice')
    expect(open.complete).toBe(false)
    expect(open.plans.map((p) => [p.side, p.invoiceId, p.total])).toEqual([
      ['customer', 'inv-1', 1250],
      ['supplier', 'si-1', 500],
    ])
    expect(open.lines.receivableLines).toEqual([])

    const done = await assessKontantmetodCutoff(
      makeTableSupabase(cashTables({ invoices: [], supplier_invoices: [] })) as never,
      'co-1', period, null, 'aktiebolag',
    )
    expect(done.complete).toBe(true)
    expect(done.plans).toEqual([])

    // Each list on its own keeps it incomplete.
    const rotOnly = await assessKontantmetodCutoff(
      makeTableSupabase(cashTables({
        invoices: [{ ...cashTables().invoices![0], subtotal: 10000, total: 12500, vat_amount: 2500, deduction_total: 3750, paid_amount: 1000 }],
        supplier_invoices: [],
        invoice_payments: [{ id: 'p', company_id: 'co-1', invoice_id: 'inv-1', amount: 1000, payment_date: '2026-12-01', journal_entry_id: null }],
      })) as never,
      'co-1', period, null, 'aktiebolag',
    )
    expect(rotOnly.plans).toEqual([])
    expect(rotOnly.complete).toBe(false)
  })

  it('stays incomplete while a cash verifikat waits for its correction', async () => {
    const tables = cashTables({
      supplier_invoices: [],
      invoice_payments: [{ id: 'pay-1', company_id: 'co-1', invoice_id: 'inv-1', amount: 1250, payment_date: '2027-01-14', journal_entry_id: 'je-cash' }],
      journal_entries: [{ id: 'je-cash', company_id: 'co-1', status: 'posted', source_type: 'invoice_cash_payment', source_id: 'inv-1', entry_date: '2027-01-14' }],
      kontantmetod_cutoff_entries: [{
        id: 'm-1', company_id: 'co-1', kind: 'receivable_invoice', fiscal_period_id: 'fp-1',
        invoice_id: 'inv-1', supplier_invoice_id: null, journal_entry_id: 'je-carry',
        entry: { id: 'je-carry', entry_date: '2026-12-31', status: 'posted' },
      }],
    })
    tables.invoices![0] = { ...tables.invoices![0], status: 'paid', paid_amount: 1250, journal_entry_id: 'je-carry' }
    const result = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag')
    expect(result.plans).toEqual([])
    expect(result.collection.paidBeforePosting).toEqual([expect.objectContaining({ carryEntryId: 'je-carry' })])
    expect(result.complete).toBe(false)
    expect(result.postings.hasAny).toBe(true)
  })

  // crm#1712: the check used to throw "balanserar inte" on such an invoice,
  // and readiness reduced that to "kunde inte genomföras: försök igen".
  it('stays incomplete, without throwing, while a supplier invoice has no rows', async () => {
    const tables = cashTables()
    tables.supplier_invoices![0] = { ...tables.supplier_invoices![0], subtotal: 500, vat_amount: 0, items: [] }
    const result = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag')
    expect(result.collection.rowlessSupplierInvoices).toEqual(['L-1'])
    expect(result.plans.map((p) => p.invoiceId)).toEqual(['inv-1'])
    expect(result.complete).toBe(false)
  })

  it('judges a period holding a posted legacy cut-off with the legacy inspector', async () => {
    const legacyLines = buildCutoffLines([receivable({ id: 'inv-1', reference: 'F-1' })], [], 'aktiebolag')
    const tables = cashTables({
      supplier_invoices: [],
      kontantmetod_cutoff_entries: [
        {
          id: 'm-1', company_id: 'co-1', kind: 'receivable', fiscal_period_id: 'fp-1',
          invoice_id: null, supplier_invoice_id: null, journal_entry_id: 'je-ar',
          entry: { id: 'je-ar', fiscal_period_id: 'fp-1', entry_date: '2026-12-31', status: 'posted', lines: legacyLines.receivableLines },
        },
        {
          id: 'm-2', company_id: 'co-1', kind: 'receivable_reversal', fiscal_period_id: 'fp-1',
          invoice_id: null, supplier_invoice_id: null, journal_entry_id: 'je-ar-rev',
          entry: { id: 'je-ar-rev', fiscal_period_id: 'fp-2', entry_date: '2027-01-01', status: 'posted', lines: reverseLines(legacyLines.receivableLines) },
        },
      ],
    })
    const result = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, 'fp-2', 'aktiebolag')
    expect(result.mode).toBe('legacy')
    expect(result.plans).toEqual([])
    expect(result.postings).toMatchObject({ complete: true, receivableEntryId: 'je-ar', receivableReversalId: 'je-ar-rev' })
    expect(result.complete).toBe(true)
  })

  it('withholds legacy-covered invoices at a later year end, and carries them on acknowledgement', async () => {
    const tables = cashTables({
      supplier_invoices: [],
      invoices: [{ ...cashTables().invoices![0], id: 'inv-old', invoice_number: 'F-OLD', invoice_date: '2025-11-01' }],
      kontantmetod_cutoff_entries: [{
        id: 'm-0', company_id: 'co-1', kind: 'receivable', fiscal_period_id: 'fp-2025',
        invoice_id: null, supplier_invoice_id: null, journal_entry_id: 'je-2025',
        entry: { id: 'je-2025', entry_date: '2025-12-31', status: 'posted' },
      }],
    })
    const withheld = await assessKontantmetodCutoff(makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag')
    expect(withheld.mode).toBe('per_invoice')
    expect(withheld.legacyCutoffs).toEqual([{ fiscalPeriodId: 'fp-2025', periodEnd: '2025-12-31', receivable: true, payable: false }])
    expect(withheld.collection.legacyCovered.map((c) => c.invoiceId)).toEqual(['inv-old'])
    expect(withheld.plans).toEqual([])
    expect(withheld.complete).toBe(false)

    const acknowledged = await assessKontantmetodCutoff(
      makeTableSupabase(tables) as never, 'co-1', period, null, 'aktiebolag',
      { acknowledgedLegacyInvoiceIds: ['inv-old'] },
    )
    expect(acknowledged.collection.legacyCovered).toEqual([])
    expect(acknowledged.plans.map((p) => p.invoiceId)).toEqual(['inv-old'])
  })

  it('fingerprints the per-invoice plans', async () => {
    const assessment = await assessKontantmetodCutoff(
      makeTableSupabase(cashTables()) as never, 'co-1', period, null, 'aktiebolag',
    )
    const base = { collection: assessment.collection, lines: assessment.lines, entityType: 'aktiebolag' as const, periodEnd: '2026-12-31' }
    const fingerprint = cutoffPreviewFingerprint({ ...base, plans: assessment.plans })
    expect(cutoffPreviewFingerprint({ ...base, plans: [...assessment.plans].reverse() })).toBe(fingerprint)
    const changed = assessment.plans.map((p, i) => i === 0
      ? { ...p, lines: p.lines.map((l) => l.account_number === '3001' ? { ...l, account_number: '3002' } : l) }
      : p)
    expect(cutoffPreviewFingerprint({ ...base, plans: changed })).not.toBe(fingerprint)
  })
})

describe('postKontantmetodCutoff (per invoice)', () => {
  const plan = (invoiceId: string, side: 'customer' | 'supplier' = 'customer'): KontantmetodCarryPlan => ({
    side,
    invoiceId,
    reference: invoiceId.toUpperCase(),
    creditNote: false,
    mode: 'full',
    description: kontantmetodCarryDescription(side, invoiceId.toUpperCase(), false),
    notes: `Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${invoiceId.toUpperCase()}`,
    lines: side === 'customer'
      ? [
          { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
          { account_number: '2611', debit_amount: 0, credit_amount: 250 },
        ]
      : [
          { account_number: '6110', debit_amount: 400, credit_amount: 0 },
          { account_number: '2641', debit_amount: 100, credit_amount: 0 },
          { account_number: '2440', debit_amount: 0, credit_amount: 500 },
        ],
    total: side === 'customer' ? 1250 : 500,
  })
  const opts = (plans: KontantmetodCarryPlan[], over: Record<string, unknown> = {}) => ({
    fiscalPeriodId: 'fp-1', periodEnd: '2026-12-31', plans, ...over,
  })

  beforeEach(() => {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(anchorCustomerInvoiceDocument).mockReset()
    vi.mocked(anchorSupplierInvoiceDocument).mockReset()
    let n = 0
    vi.mocked(createJournalEntry).mockImplementation(async () => ({ id: `je-${++n}` }) as never)
  })

  it('posts one year_end verifikat per invoice on period end and links each', async () => {
    const supabase = makeTableSupabase({})
    const result = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1'), plan('si-1', 'supplier')]))

    expect(result).toEqual({
      posted: [
        { side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-1' },
        { side: 'supplier', invoiceId: 'si-1', reference: 'SI-1', entryId: 'je-2' },
      ],
      compensated: [],
      corrected: [],
      correctionFailed: [],
      remaining: 0,
    })
    expect(createJournalEntry).toHaveBeenNthCalledWith(1, supabase, 'co-1', 'user-1', {
      fiscal_period_id: 'fp-1',
      entry_date: '2026-12-31',
      description: 'Kundfaktura INV-1: obetald vid bokslut (kontantmetoden)',
      source_type: 'year_end',
      source_id: 'fp-1',
      notes: 'Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura INV-1',
      lines: plan('inv-1').lines,
      // The posting port's ledger adapter passes commitMethod and rubricVersion, undefined as before.
    }, undefined, undefined)
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'record_kontantmetod_cutoff_link', {
      p_company_id: 'co-1', p_fiscal_period_id: 'fp-1', p_journal_entry_id: 'je-1',
      p_invoice_id: 'inv-1', p_supplier_invoice_id: null,
    })
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'record_kontantmetod_cutoff_link', {
      p_company_id: 'co-1', p_fiscal_period_id: 'fp-1', p_journal_entry_id: 'je-2',
      p_invoice_id: null, p_supplier_invoice_id: 'si-1',
    })
    expect(anchorCustomerInvoiceDocument).toHaveBeenCalledWith(supabase, 'co-1', 'inv-1')
    expect(anchorSupplierInvoiceDocument).toHaveBeenCalledWith(supabase, 'co-1', 'si-1')
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('refuses before posting anything while an invoice has an unusable moms setting', async () => {
    const supabase = makeTableSupabase({})
    await expect(postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1')], { unknownVatTreatment: ['F-9'] })))
      .rejects.toThrow(/saknar momsinställning/)
    await expect(postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1')], { strayVatOnZeroRate: ['F-8'] })))
      .rejects.toThrow(/momsfri momsinställning/)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('stornoes a carry on period end when the invoice was linked meanwhile, and goes on', async () => {
    const supabase = makeTableSupabase({}, [
      { data: { ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' }, error: null },
      { data: { ok: true }, error: null },
    ])
    vi.mocked(reverseEntry).mockResolvedValueOnce({ id: 'storno-1' } as never)
    const result = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1'), plan('inv-2')]))
    expect(reverseEntry).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', 'je-1', '2026-12-31')
    expect(result.compensated).toEqual([{
      side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-1',
      stornoEntryId: 'storno-1', code: 'CUTOFF_INVOICE_ALREADY_LINKED',
    }])
    expect(result.posted.map((p) => p.invoiceId)).toEqual(['inv-2'])
    expect(anchorCustomerInvoiceDocument).toHaveBeenCalledTimes(1)
  })

  it('treats a marker guard refusal (an RPC error) the same way', async () => {
    const supabase = makeTableSupabase({}, [{ data: null, error: { message: 'kontantmetod per-invoice carry must hold its 151x debit leg' } }])
    vi.mocked(reverseEntry).mockResolvedValueOnce({ id: 'storno-1' } as never)
    const result = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1')]))
    expect(result.posted).toEqual([])
    expect(result.compensated[0]).toMatchObject({ entryId: 'je-1', stornoEntryId: 'storno-1' })
  })

  it('stops, naming every posted id, when a carry cannot be linked nor stornoed', async () => {
    const supabase = makeTableSupabase({}, [
      { data: { ok: true }, error: null },
      { data: { ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' }, error: null },
    ])
    vi.mocked(reverseEntry).mockRejectedValueOnce(new Error('period locked'))
    const err = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts([plan('inv-1'), plan('inv-2'), plan('inv-3')]))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KontantmetodCutoffPartialError)
    expect((err as KontantmetodCutoffPartialError).postedIds).toEqual({ 'carry_inv-1': 'je-1', 'carry_inv-2': 'je-2' })
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
  })

  it('is resumable: a posting failure mid-run keeps what posted and reports it', async () => {
    vi.mocked(createJournalEntry)
      .mockReset()
      .mockResolvedValueOnce({ id: 'je-1' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    const err = await postKontantmetodCutoff(makeTableSupabase({}) as never, 'co-1', 'user-1', opts([plan('inv-1'), plan('inv-2')]))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KontantmetodCutoffPartialError)
    expect((err as KontantmetodCutoffPartialError).postedIds).toEqual({ 'carry_inv-1': 'je-1' })
  })

  it('rethrows the original error when nothing has posted yet', async () => {
    vi.mocked(createJournalEntry).mockReset().mockRejectedValueOnce(new Error('period locked'))
    await expect(postKontantmetodCutoff(makeTableSupabase({}) as never, 'co-1', 'user-1', opts([plan('inv-1')])))
      .rejects.toThrow('period locked')
  })

  it('posts at most one chunk per call and reports what remains', async () => {
    const plans = Array.from({ length: 5 }, (_, i) => plan(`inv-${i + 1}`))
    const result = await postKontantmetodCutoff(makeTableSupabase({}) as never, 'co-1', 'user-1', opts(plans, { chunkSize: 2 }))
    expect(result.posted.map((p) => p.invoiceId)).toEqual(['inv-1', 'inv-2'])
    expect(result.remaining).toBe(3)
    // The chunk is capped, whatever the caller asks for.
    const many = Array.from({ length: KONTANTMETOD_CUTOFF_CHUNK_SIZE + 3 }, (_, i) => plan(`x-${i}`))
    const capped = await postKontantmetodCutoff(makeTableSupabase({}) as never, 'co-1', 'user-1', opts(many, { chunkSize: 1000 }))
    expect(capped.posted).toHaveLength(KONTANTMETOD_CUTOFF_CHUNK_SIZE)
    expect(capped.remaining).toBe(3)
  })

  it('posts nothing at all when there is nothing to carry', async () => {
    const result = await postKontantmetodCutoff(makeTableSupabase({}) as never, 'co-1', 'user-1', opts([]))
    expect(result).toEqual({ posted: [], compensated: [], corrected: [], correctionFailed: [], remaining: 0 })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

describe('carryBusinessEventFacts (the business event of one carry)', () => {
  const facts = (
    side: 'customer' | 'supplier',
    lines: Array<[string, number, number]>,
    total: number,
    mode: KontantmetodCarryPlan['mode'] = 'full',
  ) => carryBusinessEventFacts({
    side,
    mode,
    total,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })

  it('states the 1510 leg and the utgående moms per treatment of a customer carry', () => {
    expect(facts('customer', [
      ['1510', 1370, 0], ['3001', 0, 1000], ['3002', 0, 100], ['2611', 0, 250], ['2621', 0, 12], ['2621', 0, 8],
    ], 1370)).toEqual({
      amount: 1370,
      taxAmounts: [
        { tax: 'vat', treatment: 'standard_25', amount_sek: 250 },
        { tax: 'vat', treatment: 'reduced_12', amount_sek: 20 },
      ],
      manualLines: false,
    })
  })

  it('states a credit note carry\'s moms as a magnitude', () => {
    expect(facts('customer', [['1510', 0, 625], ['3001', 500, 0], ['2611', 125, 0]], 625).taxAmounts)
      .toEqual([{ tax: 'vat', treatment: 'standard_25', amount_sek: 125 }])
  })

  it('states a supplier carry\'s ingående moms with no treatment, and no reverse-charge pair', () => {
    expect(facts('supplier', [['6110', 400, 0], ['2641', 100, 0], ['2440', 0, 500]], 500).taxAmounts)
      .toEqual([{ tax: 'vat', treatment: null, amount_sek: 100 }])
    expect(facts('supplier', [['4535', 1000, 0], ['2614', 0, 250], ['2645', 250, 0], ['2440', 0, 1000]], 1000).taxAmounts)
      .toEqual([])
  })

  it('states no moms on an export carry, and marks a manual carry\'s lines as the accountant\'s', () => {
    expect(facts('customer', [['1510', 800, 0], ['3105', 0, 800]], 800).taxAmounts).toEqual([])
    expect(facts('customer', [['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], 1250, 'manual').manualLines).toBe(true)
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
          kind: 'eu_services',
        }],
        netByAccount: [{ account: '6540', amount: 1000 }],
      })],
      'aktiebolag',
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
    const { payableLines } = buildCutoffLines([], [payable({ reverseCharge: false })], 'aktiebolag')
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
  })
})

// ---------------------------------------------------------------------------
// Test plan section 7: edge case 1, paid after period end before the cut-off
// posted. E is the kontantmetod cash verifikat, C the carry, K the rättelse.
// ---------------------------------------------------------------------------

type L = { account_number: string; debit_amount: number; credit_amount: number; currency?: string; amount_in_currency?: number }
const dr = (account: string, amount: number, extra: Partial<L> = {}): L => ({ account_number: account, debit_amount: amount, credit_amount: 0, ...extra })
const cr = (account: string, amount: number, extra: Partial<L> = {}): L => ({ account_number: account, debit_amount: 0, credit_amount: amount, ...extra })
const shape = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

/** Customer invoice F: 1 000 + 250 moms. C as the registration builder books it. */
const C_CUSTOMER = [dr('1510', 1250), cr('3001', 1000), cr('2611', 250)]
const E_CUSTOMER = [dr('1930', 1250), cr('3001', 1000), cr('2611', 250)]
/** Supplier invoice L: 400 + 100. */
const C_SUPPLIER = [dr('6110', 400), dr('2641', 100), cr('2440', 500)]
const E_SUPPLIER = [dr('6110', 400), dr('2641', 100), cr('1930', 500)]

describe('buildPaidBeforePostingCorrectionLines', () => {
  const build = (over: Partial<Parameters<typeof buildPaidBeforePostingCorrectionLines>[0]>) =>
    buildPaidBeforePostingCorrectionLines({
      side: 'customer', reference: 'F-1', cashLines: E_CUSTOMER, carryLines: C_CUSTOMER, paymentAmount: 1250, ...over,
    })

  it('replaces revenue and moms with a 1510 clearing (customer, SEK)', () => {
    const lines = build({})
    expect(shape(lines)).toEqual([['1510', 0, 1250], ['1930', 1250, 0]])
    expect(sum(lines)).toEqual({ debit: 1250, credit: 1250 })
  })

  it('replaces cost and moms with a 2440 clearing, keeping the bank fee (supplier, SEK)', () => {
    const lines = build({
      side: 'supplier', reference: 'L-1', paymentAmount: 500, carryLines: C_SUPPLIER,
      cashLines: [...E_SUPPLIER.map((l) => l.account_number === '1930' ? cr('1930', 525) : l), dr('6570', 25)],
    })
    expect(shape(lines)).toEqual([['1930', 0, 525], ['2440', 500, 0], ['6570', 25, 0]])
  })

  it('books the FX difference on 3960 or 7960 against the carried SEK', () => {
    // EUR 100 + 25 at 11.00 carried; paid at 11.20 (1 400 kr), then at 10.80.
    const carry = [dr('1510', 1375, { currency: 'EUR', amount_in_currency: 125 }), cr('3001', 1100), cr('2611', 275)]
    const gain = build({ carryLines: carry, paymentAmount: 125, cashLines: [dr('1930', 1400), cr('3001', 1120), cr('2611', 280)] })
    expect(shape(gain)).toEqual([['1510', 0, 1375], ['1930', 1400, 0], ['3960', 0, 25]])
    const loss = build({ carryLines: carry, paymentAmount: 125, cashLines: [dr('1930', 1350), cr('3001', 1080), cr('2611', 270)] })
    expect(shape(loss)).toEqual([['1510', 0, 1375], ['1930', 1350, 0], ['7960', 25, 0]])
  })

  it('drops the 1513 leg of a ROT payment: the carry holds it', () => {
    const carry = [dr('1510', 8750), dr('1513', 3750), cr('3001', 10000), cr('2611', 2500)]
    const cash = [dr('1930', 8750), dr('1513', 3750), cr('3001', 10000), cr('2611', 2500)]
    const lines = build({ carryLines: carry, cashLines: cash, paymentAmount: 8750 })
    expect(shape(lines)).toEqual([['1510', 0, 8750], ['1930', 8750, 0]])
  })

  it('clears a part of a foreign carry at the carry rate', () => {
    const carry = [dr('1510', 1375, { currency: 'EUR', amount_in_currency: 125 }), cr('3001', 1100), cr('2611', 275)]
    const lines = build({ carryLines: carry, paymentAmount: 50, cashLines: [dr('1930', 560), cr('3001', 448), cr('2611', 112)] })
    expect(shape(lines)).toEqual([['1510', 0, 550], ['1930', 560, 0], ['3960', 0, 10]])
  })

  it('clears only the part a SEK payment row covers', () => {
    const lines = build({ cashLines: [dr('1930', 500), cr('3001', 400), cr('2611', 100)], paymentAmount: 500 })
    expect(shape(lines)).toEqual([['1510', 0, 500], ['1930', 500, 0]])
  })

  it('reverses the sides for a credit note carry', () => {
    const carry = [cr('1510', 1250), dr('3001', 1000), dr('2611', 250)]
    const cash = [cr('1930', 1250), dr('3001', 1000), dr('2611', 250)]
    expect(shape(build({ carryLines: carry, cashLines: cash }))).toEqual([['1510', 1250, 0], ['1930', 0, 1250]])
  })

  it('refuses what the rule does not cover, naming why', () => {
    // A SEK bank leg that does not match the carried amount it clears.
    expect(() => build({ cashLines: [dr('1930', 1200), cr('3001', 960), cr('2611', 240)], paymentAmount: 1250 }))
      .toThrow(KontantmetodCorrectionError)
    expect(() => build({ cashLines: [dr('1930', 1200), cr('3001', 960), cr('2611', 240)], paymentAmount: 1250 }))
      .toThrow(/stämmer inte/)
    // A revenue account the carry does not book.
    expect(() => build({ cashLines: [dr('1930', 1250), cr('3002', 1000), cr('2611', 250)] }))
      .toThrow(/3002/)
    // More paid than was carried.
    expect(() => build({ paymentAmount: 1300 })).toThrow(/större än/)
    // A carry without exactly one 1510 line.
    expect(() => build({ carryLines: [cr('3001', 1000), cr('2611', 250), dr('1930', 1250)] })).toThrow(/1510/)
  })
})

describe('previewPaidBeforePostingCorrections', () => {
  const item = (over: Partial<PaidBeforePosting> = {}): PaidBeforePosting => ({
    side: 'customer', invoiceId: 'inv-1', reference: 'F-1', entryId: 'je-cash', entryDate: '2027-01-14',
    paymentRowId: 'pay-1', paymentAmount: 1250, carryEntryId: null, ...over,
  })
  const cashRow = (over: TRow = {}): TRow => ({
    id: 'je-cash', company_id: 'co-1', status: 'posted', entry_date: '2027-01-14', lines: E_CUSTOMER, ...over,
  })
  const carryPlan: KontantmetodCarryPlan = {
    side: 'customer', invoiceId: 'inv-1', reference: 'F-1', creditNote: false, mode: 'full',
    description: kontantmetodCarryDescription('customer', 'F-1', false), notes: 'n', lines: C_CUSTOMER, total: 1250,
  }

  it('takes the carry from the plan when the same run posts it, and shows the storno', async () => {
    const result = await previewPaidBeforePostingCorrections(
      makeTableSupabase({ journal_entries: [cashRow()] }) as never, 'co-1', [item()], [carryPlan],
    )
    expect(result.refusals).toEqual([])
    expect(result.corrections).toHaveLength(1)
    expect(shape(result.corrections[0]!.correctedLines)).toEqual([['1510', 0, 1250], ['1930', 1250, 0]])
    expect(shape(result.corrections[0]!.stornoLines)).toEqual([['1930', 0, 1250], ['2611', 250, 0], ['3001', 1000, 0]])
  })

  it('takes the posted carry on a resume, and lists what the rule cannot do', async () => {
    const tables = {
      journal_entries: [
        cashRow(),
        { id: 'je-carry', company_id: 'co-1', status: 'posted', entry_date: '2026-12-31', lines: C_CUSTOMER },
        cashRow({ id: 'je-odd', lines: [dr('1930', 1250), cr('3002', 1000), cr('2611', 250)] }),
      ],
    }
    const result = await previewPaidBeforePostingCorrections(
      makeTableSupabase(tables) as never, 'co-1',
      [item({ carryEntryId: 'je-carry' }), item({ invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-odd', carryEntryId: 'je-carry' })],
      [],
    )
    expect(result.corrections.map((c) => c.entryId)).toEqual(['je-cash'])
    expect(result.refusals).toEqual([expect.objectContaining({ invoiceId: 'inv-2', entryId: 'je-odd', reason: expect.stringContaining('3002') })])
  })
})

describe('postKontantmetodCutoff: correcting payments booked before the cut-off', () => {
  const carryPlan = (invoiceId = 'inv-1'): KontantmetodCarryPlan => ({
    side: 'customer', invoiceId, reference: invoiceId.toUpperCase(), creditNote: false, mode: 'full',
    description: kontantmetodCarryDescription('customer', invoiceId.toUpperCase(), false),
    notes: 'n', lines: C_CUSTOMER, total: 1250,
  })
  const item = (over: Partial<PaidBeforePosting> = {}): PaidBeforePosting => ({
    side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-cash', entryDate: '2027-01-14',
    paymentRowId: 'pay-1', paymentAmount: 1250, carryEntryId: null, ...over,
  })
  const tables = (carryId = 'je-1') => ({
    journal_entries: [
      { id: 'je-cash', company_id: 'co-1', status: 'posted', entry_date: '2027-01-14', description: 'Kontantbetalning', lines: E_CUSTOMER },
      { id: carryId, company_id: 'co-1', status: 'posted', entry_date: '2026-12-31', voucher_series: 'A', voucher_number: 41, lines: C_CUSTOMER },
    ],
  })
  const opts = (over: Record<string, unknown> = {}) => ({
    fiscalPeriodId: 'fp-1', periodEnd: '2026-12-31', plans: [carryPlan()], paidBeforePosting: [item()], ...over,
  })

  beforeEach(() => {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(correctEntry).mockReset()
    let n = 0
    vi.mocked(createJournalEntry).mockImplementation(async () => ({ id: `je-${++n}` }) as never)
    vi.mocked(correctEntry).mockResolvedValue({ reversal: { id: 'storno-e' }, corrected: { id: 'k-1' } } as never)
  })

  it('corrects E with correctEntry on its own date, after the carry posted', async () => {
    const supabase = makeTableSupabase(tables())
    const result = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts())

    expect(result.posted.map((p) => p.entryId)).toEqual(['je-1'])
    expect(result.corrected).toEqual([{
      side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-cash',
      stornoEntryId: 'storno-e', correctionEntryId: 'k-1',
    }])
    expect(result.correctionFailed).toEqual([])
    const [, company, user, originalId, lines, options] = vi.mocked(correctEntry).mock.calls[0]!
    expect([company, user, originalId]).toEqual(['co-1', 'user-1', 'je-cash'])
    expect(shape(lines)).toEqual([['1510', 0, 1250], ['1930', 1250, 0]])
    // No date override: the storno and the rättelse keep E's date.
    expect(options).toMatchObject({ description: paidBeforePostingCorrectionDescription('A41') })
    // A right booking moved to its clearing account rejects no learned template (crm#1858).
    expect(options).toMatchObject({ keepLearnedTemplates: true })
    expect(options).not.toHaveProperty('newEntryDate')
    expect(options?.preloadedOriginal).toMatchObject({ id: 'je-cash', status: 'posted' })
    expect(vi.mocked(createJournalEntry).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(correctEntry).mock.invocationCallOrder[0]!)
  })

  it('leaves the correction for a later run when the invoice was not carried in this one', async () => {
    const supabase = makeTableSupabase(tables(), [{ data: { ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' }, error: null }])
    vi.mocked(reverseEntry).mockResolvedValueOnce({ id: 'storno-c' } as never)
    const compensated = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', opts())
    expect(compensated.compensated).toHaveLength(1)
    expect(correctEntry).not.toHaveBeenCalled()

    // Beyond the chunk: not carried yet either.
    const beyond = await postKontantmetodCutoff(makeTableSupabase(tables()) as never, 'co-1', 'user-1', opts({
      plans: [carryPlan('inv-0'), carryPlan()], chunkSize: 1,
    }))
    expect(beyond.remaining).toBe(1)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('reports a failed correction and keeps the carry; a re-run performs only the correction', async () => {
    vi.mocked(correctEntry).mockRejectedValueOnce(Object.assign(new Error('period locked'), { code: 'PERIOD_LOCKED' }))
    const first = await postKontantmetodCutoff(makeTableSupabase(tables()) as never, 'co-1', 'user-1', opts())
    expect(first.posted.map((p) => p.invoiceId)).toEqual(['inv-1'])
    expect(first.corrected).toEqual([])
    expect(first.correctionFailed).toEqual([{
      side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-cash', code: 'PERIOD_LOCKED', message: 'period locked',
    }])

    // The resume: the invoice is linked now (no plan), E still posted.
    vi.mocked(createJournalEntry).mockClear()
    const rerun = await postKontantmetodCutoff(makeTableSupabase(tables('je-carry')) as never, 'co-1', 'user-1', opts({
      plans: [], paidBeforePosting: [item({ carryEntryId: 'je-carry' })],
    }))
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(rerun.corrected.map((c) => c.correctionEntryId)).toEqual(['k-1'])
  })

  it('skips a cash verifikat that is no longer posted (already corrected)', async () => {
    const t = tables('je-carry')
    t.journal_entries[0] = { ...t.journal_entries[0]!, status: 'reversed' }
    const result = await postKontantmetodCutoff(makeTableSupabase(t) as never, 'co-1', 'user-1', opts({
      plans: [], paidBeforePosting: [item({ carryEntryId: 'je-carry' })],
    }))
    expect(correctEntry).not.toHaveBeenCalled()
    expect(result.corrected).toEqual([])
    expect(result.correctionFailed).toEqual([])
  })

  it('corrects a supplier payment and an FX customer payment', async () => {
    const supplier: PaidBeforePosting = {
      side: 'supplier', invoiceId: 'si-1', reference: 'L-1', entryId: 'je-scash', entryDate: '2027-01-20',
      paymentRowId: 'sp-1', paymentAmount: 500, carryEntryId: 'je-scarry',
    }
    const fx = item({ entryId: 'je-fx', carryEntryId: 'je-fxcarry', paymentAmount: 125 })
    const t = {
      journal_entries: [
        { id: 'je-scash', company_id: 'co-1', status: 'posted', entry_date: '2027-01-20', lines: E_SUPPLIER },
        { id: 'je-scarry', company_id: 'co-1', status: 'posted', entry_date: '2026-12-31', voucher_series: 'A', voucher_number: 7, lines: C_SUPPLIER },
        { id: 'je-fx', company_id: 'co-1', status: 'posted', entry_date: '2027-01-14', lines: [dr('1930', 1400), cr('3001', 1120), cr('2611', 280)] },
        { id: 'je-fxcarry', company_id: 'co-1', status: 'posted', entry_date: '2026-12-31', voucher_series: 'A', voucher_number: 8,
          lines: [dr('1510', 1375, { currency: 'EUR', amount_in_currency: 125 }), cr('3001', 1100), cr('2611', 275)] },
      ],
    }
    await postKontantmetodCutoff(makeTableSupabase(t) as never, 'co-1', 'user-1', opts({ plans: [], paidBeforePosting: [supplier, fx] }))
    const calls = vi.mocked(correctEntry).mock.calls
    expect(shape(calls[0]![4])).toEqual([['1930', 0, 500], ['2440', 500, 0]])
    expect(shape(calls[1]![4])).toEqual([['1510', 0, 1375], ['1930', 1400, 0], ['3960', 0, 25]])
  })
})

// Review of #3440: a ROT/RUT invoice part paid in the closed year had a
// remediation nobody could carry out (a manual voucher can never be linked).
// The manual carry posts through the cut-off itself and is linked like any.
describe('manual carries (KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL)', () => {
  const target = {
    invoiceId: 'inv-1', reference: 'F-1', creditNote: false,
    openCustomerShareSek: 4750, openDeductionSek: 2035.71, openPartHasVat: true,
  }
  const good = [
    { account_number: '1510', debit_amount: 4750, credit_amount: 0 },
    { account_number: '1513', debit_amount: 2035.71, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 5428.57 },
    { account_number: '2611', debit_amount: 0, credit_amount: 1357.14 },
  ]

  it('turns valid lines into a manual plan that posts and links like a carry', () => {
    const plan = buildKontantmetodManualCarryPlan(target, good)
    expect(plan).toMatchObject({
      side: 'customer', invoiceId: 'inv-1', reference: 'F-1', creditNote: false, mode: 'manual', total: 4750,
      description: 'Kundfaktura F-1: obetald vid bokslut (kontantmetoden)',
    })
    expect(plan.notes).toContain('Manuell årsomföring')
    expect(plan.lines.map((l) => l.account_number)).toEqual(['1510', '1513', '3001', '2611'])
  })

  it.each([
    ['an unbalanced verifikat', [good[0], good[2], good[3]], /balanserar inte/],
    ['the wrong customer share on 151x', [
      { account_number: '1510', debit_amount: 4000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 3200 },
      { account_number: '2611', debit_amount: 0, credit_amount: 800 },
    ], /kundfordran/],
    ['an account outside revenue and output moms', [
      good[0], good[1], good[2],
      { account_number: '2999', debit_amount: 0, credit_amount: 1357.14 },
    ], /konto 2999 hör inte till en årsomföring/],
    ['no moms on an open part that carries moms', [
      good[0], good[1],
      { account_number: '3001', debit_amount: 0, credit_amount: 6785.71 },
    ], /momsen för den obetalda delen saknas/],
    ['no revenue', [
      good[0], good[1],
      { account_number: '2611', debit_amount: 0, credit_amount: 6785.71 },
    ], /intäkten för den obetalda delen saknas/],
    ['money on 19xx', [
      { account_number: '1510', debit_amount: 4750, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 4750 },
    ], /19xx/],
    ['an account given as a number', [{ ...good[0], account_number: 1510 }, ...good.slice(1)], /kontonummer/],
    ['a line with both sides', [{ ...good[0], credit_amount: 1 }, ...good.slice(1)], /antingen debet eller kredit/],
    ['sub-öre amounts', [{ ...good[0], debit_amount: 4750.001 }, ...good.slice(1)], /under öre/],
  ])('refuses %s', (_label, lines, message) => {
    expect(() => buildKontantmetodManualCarryPlan(target, lines)).toThrow(KontantmetodManualCarryError)
    expect(() => buildKontantmetodManualCarryPlan(target, lines)).toThrow(message as RegExp)
  })

  // Review of #3440: 1513 was only capped from above. Less than Skatteverket's
  // open share left the year-2 payout clearing 1513 with no moms behind it:
  // the moms on the difference was never declared and 1513 went negative.
  describe('1513 is exactly Skatteverket\'s share of the open part', () => {
    const withDeduction = (deduction: number) => [
      good[0],
      { account_number: '1513', debit_amount: deduction, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: roundOre(4750 + deduction - 1357.14) },
      good[3],
    ]
    const refusal = (lines: unknown) => {
      try {
        buildKontantmetodManualCarryPlan(target, lines)
      } catch (err) {
        return err
      }
      return null
    }

    it('refuses less than the share', () => {
      const err = refusal(withDeduction(1000))
      expect(err).toBeInstanceOf(KontantmetodManualCarryError)
      expect(err).toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
      expect((err as Error).message).toMatch(/1513 ska vara exakt Skatteverkets andel av den obetalda delen, 2035\.71 kr/)
      expect((err as Error).message).toMatch(/bokför 1000 kr/)
    })

    it('refuses one öre less than the share', () => {
      expect(refusal(withDeduction(2035.70))).toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
    })

    it('refuses nothing on 1513', () => {
      const err = refusal([good[0], { account_number: '3001', debit_amount: 0, credit_amount: 3392.86 }, good[3]])
      expect(err).toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
    })

    it('refuses more than the share', () => {
      const err = refusal(withDeduction(3750))
      expect(err).toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
      expect((err as Error).message).toMatch(/bokför 3750 kr/)
    })

    it('refuses 1513 on the wrong side', () => {
      const lines = [
        good[0],
        { account_number: '1513', debit_amount: 0, credit_amount: 2035.71 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1357.15 },
        good[3],
      ]
      expect(refusal(lines)).toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
    })

    it('accepts exactly the share, with the full revenue and moms of the open part', () => {
      const plan = buildKontantmetodManualCarryPlan(target, withDeduction(2035.71))
      const sum = (account: string, side: 'debit_amount' | 'credit_amount') =>
        plan.lines.filter((l) => l.account_number === account).reduce((s, l) => s + l[side], 0)
      expect(sum('1513', 'debit_amount')).toBe(2035.71)
      // The 1513 share is backed by revenue and moms, not by another receivable.
      expect(roundOre(sum('3001', 'credit_amount') + sum('2611', 'credit_amount')))
        .toBe(roundOre(sum('1510', 'debit_amount') + sum('1513', 'debit_amount')))
    })

    it('takes no 1513 and no moms when the open part has neither', () => {
      const plain = { ...target, openDeductionSek: 0, openPartHasVat: false }
      expect(buildKontantmetodManualCarryPlan(plain, [
        good[0], { account_number: '3001', debit_amount: 0, credit_amount: 4750 },
      ]).lines).toHaveLength(2)
      expect(() => buildKontantmetodManualCarryPlan(plain, [
        good[0],
        { account_number: '3001', debit_amount: 0, credit_amount: 3800 },
        { account_number: '2611', debit_amount: 0, credit_amount: 950 },
      ])).toThrow(/ingen moms/)
    })
  })

  it('takes a credit note on the opposite side', () => {
    const plan = buildKontantmetodManualCarryPlan({ ...target, creditNote: true, openDeductionSek: 0 }, [
      { account_number: '3001', debit_amount: 3800, credit_amount: 0 },
      { account_number: '2611', debit_amount: 950, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 4750 },
    ])
    expect(plan.creditNote).toBe(true)
    expect(plan.description).toBe('Kreditfaktura F-1: oreglerad vid bokslut (kontantmetoden)')
  })

  it('accepts only invoices waiting for a manual carry, each once', () => {
    const collection = { rotPartialManualInvoices: [target] }
    expect(resolveKontantmetodManualCarries(collection, undefined)).toEqual([])
    expect(resolveKontantmetodManualCarries(collection, [{ invoice_id: 'inv-1', lines: good }])).toHaveLength(1)
    expect(() => resolveKontantmetodManualCarries(collection, [{ invoice_id: 'inv-2', lines: good }]))
      .toThrow(/väntar inte på en manuell årsomföring/)
    expect(() => resolveKontantmetodManualCarries(collection, [
      { invoice_id: 'inv-1', lines: good }, { invoice_id: 'inv-1', lines: good },
    ])).toThrow(/två gånger/)
    expect(() => resolveKontantmetodManualCarries(collection, { invoice_id: 'inv-1' })).toThrow(KontantmetodManualCarryError)
  })

  it('clears readiness once the manual carry is linked: the invoice leaves the collection', async () => {
    const rotTables = (link: string | null) => cashTables({
      supplier_invoices: [],
      invoices: [{
        ...cashTables().invoices![0], subtotal: 10000, total: 12500, vat_amount: 2500,
        deduction_total: 3750, paid_amount: 4000, status: 'partially_paid', journal_entry_id: link,
      }],
      invoice_payments: [{ id: 'p-1', company_id: 'co-1', invoice_id: 'inv-1', amount: 4000, payment_date: '2026-12-01', journal_entry_id: 'je-cash' }],
    })
    const period = { id: 'fp-1', period_start: '2026-01-01', period_end: '2026-12-31' }
    const before = await assessKontantmetodCutoff(makeTableSupabase(rotTables(null)) as never, 'co-1', period, null, 'aktiebolag')
    expect(before.collection.rotPartialManual).toEqual(['F-1'])
    expect(before.complete).toBe(false)
    const after = await assessKontantmetodCutoff(makeTableSupabase(rotTables('je-manual')) as never, 'co-1', period, null, 'aktiebolag')
    expect(after.collection.rotPartialManual).toEqual([])
    expect(after.complete).toBe(true)
  })

  it('posts a manual plan through the engine and links it like any carry', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce({ id: 'je-manual' } as never)
    const supabase = makeTableSupabase({})
    const plan = buildKontantmetodManualCarryPlan(target, good)
    const result = await postKontantmetodCutoff(supabase as never, 'co-1', 'user-1', {
      fiscalPeriodId: 'fp-1', periodEnd: '2026-12-31', plans: [plan],
    })
    expect(result.posted).toEqual([{ side: 'customer', invoiceId: 'inv-1', reference: 'F-1', entryId: 'je-manual' }])
    expect(vi.mocked(createJournalEntry)).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', expect.objectContaining({
      entry_date: '2026-12-31', source_type: 'year_end', source_id: 'fp-1', lines: plan.lines,
      // The posting port's ledger adapter passes commitMethod and rubricVersion, undefined as before.
    }), undefined, undefined)
    expect(supabase.rpc).toHaveBeenCalledWith('record_kontantmetod_cutoff_link', expect.objectContaining({
      p_journal_entry_id: 'je-manual', p_invoice_id: 'inv-1', p_supplier_invoice_id: null,
    }))
  })
})

// Kontantmetodens two steps for ROT/RUT (ML 2023:200 7 kap. 16 §;
// Skatteverket, "Så fungerar rotavdraget"): the customer's payment booked
// only the customer's share. Skatteverket's share not yet paid out on period
// end is a fordran on the day and is carried, on 1513 with its revenue and
// moms; one the payout already booked in the year is not.
describe('collectKontantmetodCutoff: Skatteverket\'s share under the two steps', () => {
  const rotRow = (over: TRow = {}): TRow => ({
    id: 'inv-rot', company_id: 'co-1', invoice_number: 'F-ROT', invoice_date: '2026-09-01',
    status: 'paid', currency: 'SEK', exchange_rate: null, subtotal: 10000, total: 12500,
    vat_amount: 2500, vat_treatment: 'standard_25', document_type: 'invoice',
    paid_amount: 8750, remaining_amount: 0, deduction_total: 3750, deduction_reclaimed_total: 0,
    journal_entry_id: null,
    items: [customerItem({
      invoice_id: 'inv-rot', unit_price: 10000, line_total: 10000, vat_amount: 2500,
      deduction_type: 'rot', deduction_amount: 3750,
    })],
    ...over,
  })
  const cashVoucher = (over: TRow = {}): TRow => ({
    id: 'je-cash', company_id: 'co-1', status: 'posted', reversed_by_id: null,
    source_type: 'invoice_cash_payment', entry_date: '2026-09-20', ...over,
  })
  const tables = (extra: Record<string, TRow[]> = {}): Record<string, TRow[]> => ({
    ...cashTables(),
    invoices: [rotRow()],
    supplier_invoices: [],
    invoice_payments: [{
      id: 'ip-rot', invoice_id: 'inv-rot', amount: 8750, payment_date: '2026-09-20', journal_entry_id: 'je-cash',
    }],
    journal_entries: [cashVoucher()],
    journal_entry_lines: [],
    rot_rut_payout_request_items: [],
    ...extra,
  })
  const payoutItem = (status: string, entryDate: string, decided: number | null = null): Record<string, TRow[]> => ({
    rot_rut_payout_request_items: [{
      invoice_id: 'inv-rot', requested_amount: 3750, decided_amount: decided,
      request: { status, decided_total: decided, settlement_journal_entry_id: 'je-payout' },
    }],
    journal_entries: [
      cashVoucher(),
      { id: 'je-payout', company_id: 'co-1', status: 'posted', reversed_by_id: null, source_type: 'rot_rut_payout', entry_date: entryDate },
    ],
  })

  it('carries the share alone when the payout had not come: 1513 against 3 000 revenue and 750 moms', async () => {
    const result = await collectPerInvoice(tables())
    expect(result.carries).toHaveLength(1)
    const plan = buildKontantmetodCarryPlan(result.carries[0], 'aktiebolag')
    expect(plan).toMatchObject({
      side: 'customer',
      invoiceId: 'inv-rot',
      mode: 'full',
      total: 3750,
      description: 'Kundfaktura F-ROT: Skatteverkets andel ej utbetald vid bokslut (kontantmetoden)',
    })
    expect(plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1513', 3750, 0],
      ['3001', 0, 3000],
      ['2611', 0, 750],
    ])
    expect(result.rotPartialManual).toEqual([])
  })

  it('carries the share when the payout came after period end, even if already booked', async () => {
    const result = await collectPerInvoice(tables(payoutItem('paid', '2027-01-12')))
    expect(result.carries.map((c) => c.invoice.id)).toEqual(['inv-rot'])
  })

  it('carries nothing when the payout in the year booked the share', async () => {
    const result = await collectPerInvoice(tables(payoutItem('paid', '2026-10-10')))
    expect(result.carries).toEqual([])
    expect(result.rotPartialManual).toEqual([])
  })

  it('carries nothing for a payment booked before the two steps: its 1513 holds the share', async () => {
    const result = await collectPerInvoice(tables({ journal_entry_lines: [{ journal_entry_id: 'je-cash', account_number: '1513' }] }))
    expect(result.carries).toEqual([])
  })

  it('a claim approved in part in the year lists the refused rest as the customer\'s, for a manual carry', async () => {
    const result = await collectPerInvoice(tables(payoutItem('partially_paid', '2026-10-10', 3000)))
    expect(result.carries).toEqual([])
    expect(result.rotPartialManual).toEqual(['F-ROT'])
    const target = result.rotPartialManualInvoices[0]
    expect(target).toEqual({
      invoiceId: 'inv-rot',
      reference: 'F-ROT',
      creditNote: false,
      openCustomerShareSek: 750,
      openDeductionSek: 0,
      openPartHasVat: true,
    })
    const plan = buildKontantmetodManualCarryPlan(target, [
      { account_number: '1510', debit_amount: 750, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 600 },
      { account_number: '2611', debit_amount: 0, credit_amount: 150 },
    ])
    expect(plan.total).toBe(750)
  })
})
