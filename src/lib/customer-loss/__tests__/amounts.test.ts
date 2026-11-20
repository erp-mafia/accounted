import { describe, expect, it } from 'vitest'
import {
  confirmedLines,
  doubtfulLines,
  liveRows,
  openVatByAccount,
  outputVatRate,
  reachedLedgerAsReceivable,
  receivableBasis,
  recoveryLines,
  recoveryShares,
  reserveOutstanding,
  reserveTarget,
  totalVat,
  vatSharesOfPart,
  type LedgerLine,
  type WriteOffRowLike,
} from '../amounts'
import { decisionId } from '../ids'
import { roundOre, sumOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

const l = (account_number: string, debit: number, credit: number): LedgerLine => ({
  account_number,
  debit_amount: debit,
  credit_amount: credit,
})

/** 25 %: 1000 + 250, 12 %: 500 + 60. Total 1810. */
const mixedInvoice: LedgerLine[] = [
  l('1510', 1810, 0),
  l('3001', 0, 1000),
  l('2611', 0, 250),
  l('3002', 0, 500),
  l('2621', 0, 60),
]

function balanced(lines: CreateJournalEntryLineInput[]): boolean {
  return (
    sumOre(lines.map((x) => x.debit_amount)) === sumOre(lines.map((x) => x.credit_amount)) &&
    lines.every((x) => x.debit_amount >= 0 && x.credit_amount >= 0)
  )
}

function row(partial: Partial<WriteOffRowLike> & Pick<WriteOffRowLike, 'id' | 'kind'>): WriteOffRowLike {
  return {
    amount: 0,
    net_amount: 0,
    vat_amount: 0,
    vat_by_rate: [],
    reserve_released: 0,
    reverses_id: null,
    journal_entry_id: 'je',
    decided_at: '2026-06-01T00:00:00Z',
    ...partial,
  }
}

describe('output VAT accounts', () => {
  it('maps the domestic output VAT accounts to their rates and nothing else', () => {
    expect(outputVatRate('2611')).toBe(25)
    expect(outputVatRate('2621')).toBe(12)
    expect(outputVatRate('2631')).toBe(6)
    expect(outputVatRate('2618')).toBeNull() // vilande: in no ruta until moved (crm#1562)
    expect(outputVatRate('2614')).toBeNull() // reverse charge, ruta 30
    expect(outputVatRate('2641')).toBeNull()
    expect(outputVatRate('3001')).toBeNull()
  })
})

describe('open VAT per account, net of credit notes', () => {
  it('nets a credit note per rate to the öre', () => {
    const creditNote = [l('1510', 0, 362), l('3001', 200, 0), l('2611', 50, 0), l('3002', 100, 0), l('2621', 12, 0)]
    const open = openVatByAccount(mixedInvoice, creditNote)
    expect(Object.fromEntries(open)).toEqual({ '2611': 200, '2621': 48 })
    expect(receivableBasis(mixedInvoice, creditNote)).toBe(1448)
  })

  it('has no VAT share for reverse charge, export or exempt invoices', () => {
    const reverseCharge = [l('1510', 1000, 0), l('3308', 0, 1000)]
    expect(openVatByAccount(reverseCharge, []).size).toBe(0)
    expect(vatSharesOfPart(openVatByAccount(reverseCharge, []), 1000, 1000)).toEqual([])
    expect(reserveTarget(new Map(), 1000, 600)).toBe(600)
  })

  it('knows whether the invoice reached the ledger as a receivable (the booked-branch rule)', () => {
    expect(reachedLedgerAsReceivable(mixedInvoice)).toBe(true)
    // Kontantmetoden: the payment voucher books the sale straight against the bank.
    expect(reachedLedgerAsReceivable([l('1930', 1250, 0), l('3001', 0, 1000), l('2611', 0, 250)])).toBe(false)
    // A year-end carry puts the full claim on 1510 and counts as booked.
    expect(reachedLedgerAsReceivable([l('1510', 1250, 0), l('3001', 0, 1000), l('2611', 0, 250)])).toBe(true)
  })
})

describe('VAT share of the open part', () => {
  const open = openVatByAccount(mixedInvoice, [])

  it('takes the whole VAT when the whole claim is open', () => {
    const shares = vatSharesOfPart(open, 1810, 1810)
    expect(shares).toEqual([
      { account: '2611', rate: 25, vat: 250, base: 1000 },
      { account: '2621', rate: 12, vat: 60, base: 500 },
    ])
  })

  it('takes the same proportion of every rate after a partial payment', () => {
    const shares = vatSharesOfPart(open, 1810, 905)
    expect(shares).toEqual([
      { account: '2611', rate: 25, vat: 125, base: 500 },
      { account: '2621', rate: 12, vat: 30, base: 250 },
    ])
    expect(reserveTarget(open, 1810, 905)).toBe(750)
  })

  it('rounds each share to the öre', () => {
    const shares = vatSharesOfPart(open, 1810, 333.33)
    expect(shares.map((s) => s.vat)).toEqual([roundOre((250 * 333.33) / 1810), roundOre((60 * 333.33) / 1810)])
    expect(shares.every((s) => roundOre(s.vat) === s.vat && roundOre(s.base) === s.base)).toBe(true)
  })
})

describe('reserve bookkeeping', () => {
  it('counts reserves, releases and the konstaterad release, ignoring annulled decisions', () => {
    const rows = [
      row({ id: 'a', kind: 'doubtful', net_amount: 800, decided_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'b', kind: 'reversed_doubtful', net_amount: 200, decided_at: '2026-02-01T00:00:00Z' }),
      row({ id: 'c', kind: 'doubtful', net_amount: 100, decided_at: '2026-03-01T00:00:00Z' }),
      row({ id: 'd', kind: 'annulled', reverses_id: 'c', net_amount: 100, decided_at: '2026-03-02T00:00:00Z' }),
    ]
    expect(liveRows(rows).map((r) => r.id)).toEqual(['a', 'b'])
    expect(reserveOutstanding(rows)).toBe(600)
    rows.push(row({ id: 'e', kind: 'confirmed', reserve_released: 600, decided_at: '2026-04-01T00:00:00Z' }))
    expect(reserveOutstanding(rows)).toBe(0)
  })
})

describe('recovery after a write-off', () => {
  const confirmed = row({
    id: 'g',
    kind: 'confirmed',
    amount: 999.99,
    net_amount: 814.26,
    vat_amount: 185.73,
    vat_by_rate: [
      { account: '2611', rate: 25, vat: 150.01, base: 600.04 },
      { account: '2621', rate: 12, vat: 35.72, base: 297.67 },
    ],
  })

  it('reports back exactly the written-off VAT per rate over several partial recoveries', () => {
    const prior: WriteOffRowLike[] = []
    for (const amount of [333.33, 333.33, 333.33]) {
      const { shares, left } = recoveryShares(confirmed, prior, amount)
      expect(amount).toBeLessThanOrEqual(left)
      const vat = totalVat(shares)
      prior.push(
        row({
          id: `h${prior.length}`,
          kind: 'recovered',
          amount,
          vat_amount: vat,
          net_amount: roundOre(amount - vat),
          vat_by_rate: shares,
        }),
      )
      expect(balanced(recoveryLines({ amount, shares, paymentAccount: '1930', tag: '1042' }))).toBe(true)
    }
    const perAccount = (account: string) =>
      sumOre(prior.flatMap((r) => (r.vat_by_rate ?? []).filter((s) => s.account === account).map((s) => s.vat)))
    expect(perAccount('2611')).toBe(150.01)
    expect(perAccount('2621')).toBe(35.72)
    expect(recoveryShares(confirmed, prior, 0.01).left).toBe(0)
  })
})

describe('voucher lines', () => {
  it('books befarad on 6352 / 1519', () => {
    expect(doubtfulLines(750, '1042').map((x) => [x.account_number, x.debit_amount, x.credit_amount])).toEqual([
      ['6352', 750, 0],
      ['1519', 0, 750],
    ])
  })

  it('books konstaterad on 6351 and 26xx against 1510 and releases the reserve', () => {
    const shares = vatSharesOfPart(openVatByAccount(mixedInvoice, []), 1810, 905)
    const lines = confirmedLines({ amount: 905, shares, reserve: 750, receivableAccount: '1510', tag: '1042' })
    expect(lines.map((x) => [x.account_number, x.debit_amount, x.credit_amount])).toEqual([
      ['6351', 750, 0],
      ['2611', 125, 0],
      ['2621', 30, 0],
      ['1510', 0, 905],
      ['1519', 750, 0],
      ['6352', 0, 750],
    ])
    expect(balanced(lines)).toBe(true)
  })

  it('books a recovery on 3950 and 26xx', () => {
    const lines = recoveryLines({
      amount: 125,
      shares: [{ account: '2611', rate: 25, vat: 25, base: 100 }],
      paymentAccount: '1930',
      tag: '1042',
    })
    expect(lines.map((x) => [x.account_number, x.debit_amount, x.credit_amount])).toEqual([
      ['1930', 125, 0],
      ['3950', 0, 100],
      ['2611', 0, 25],
    ])
  })
})

describe('decision ids', () => {
  it('is deterministic per invoice, kind and ordinal, in UUID version 5 layout', async () => {
    const a = await decisionId('11111111-1111-4111-8111-111111111111', 'confirmed', 0)
    expect(a).toBe(await decisionId('11111111-1111-4111-8111-111111111111', 'confirmed', 0))
    expect(a).not.toBe(await decisionId('11111111-1111-4111-8111-111111111111', 'confirmed', 1))
    expect(a).not.toBe(await decisionId('11111111-1111-4111-8111-111111111111', 'doubtful', 0))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
