import { roundOre } from '@/lib/money'
import { describe, it, expect } from 'vitest'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'
import {
  buildCreditNoteLines,
  buildDeductionCarryLines,
  buildDeductionRecognitionLines,
  buildInvoiceCashLines,
  buildInvoiceRegistrationLines,
  scaleDeductionItems,
  splitDeductionShare,
} from '../invoice-lines'

/**
 * Bokslutsmetoden reports a ROT/RUT invoice's moms in two steps (ML 2023:200
 * 7 kap. 16 §; Skatteverket, "Så fungerar rotavdraget", Momsmetoder): moms on
 * what the customer pays when the customer pays, and "momsen på rotavdraget"
 * when Skatteverket's payout arrives.
 *
 * Skatteverket's worked example: arbete 10 000, material 8 000, resa 400,
 * moms 25 % 4 600, rotavdrag 30 % of the labour incl. moms 3 750, the
 * customer pays 19 250. Step 1: 19 250 * 0,20 = 3 850 kr moms. Step 2:
 * 3 750 * 0,20 = 750 kr moms.
 */

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Arbete',
    quantity: 1,
    unit: 'st',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    deduction_type: 'rot',
    deduction_amount: 3750,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

function skvItems(): InvoiceItem[] {
  return [
    item(),
    item({
      id: 'item-material',
      sort_order: 1,
      description: 'Material',
      unit_price: 8000,
      line_total: 8000,
      vat_amount: 2000,
      deduction_type: null,
      deduction_amount: 0,
    }),
    item({
      id: 'item-travel',
      sort_order: 2,
      description: 'Resa',
      unit_price: 400,
      line_total: 400,
      vat_amount: 100,
      deduction_type: null,
      deduction_amount: 0,
    }),
  ]
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '1042',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: 18400,
    subtotal_sek: 18400,
    vat_amount: 4600,
    vat_amount_sek: 4600,
    total: 23000,
    total_sek: 23000,
    deduction_total: 3750,
    items: skvItems(),
    ...overrides,
  } as Invoice
}

/** Net credit per account (credit minus debit), öre-exact. */
function netByAccount(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const net: Record<string, number> = {}
  for (const line of lines) {
    net[line.account_number] = roundOre((net[line.account_number] ?? 0) + line.credit_amount - line.debit_amount)
  }
  return net
}

function balanced(lines: CreateJournalEntryLineInput[]): boolean {
  const debit = roundOre(lines.reduce((sum, line) => sum + line.debit_amount, 0))
  const credit = roundOre(lines.reduce((sum, line) => sum + line.credit_amount, 0))
  return debit === credit && debit > 0
}

const cash = (inv: Invoice) =>
  buildInvoiceCashLines(inv, 'aktiebolag', undefined, '1930', undefined, undefined, { deferDeductionShare: true }).lines

describe('splitDeductionShare: Skatteverket\'s worked example', () => {
  it('takes 3 000 revenue and 750 moms off the labour line', () => {
    const split = splitDeductionShare(skvItems(), 'SEK')!
    expect(split.deductionSek).toBe(3750)
    expect(split.deductionItems).toHaveLength(1)
    expect(split.deductionItems[0]).toMatchObject({ line_total: 3000, vat_amount: 750, vat_rate: 25 })
    expect(split.customerItems[0]).toMatchObject({ line_total: 7000, vat_amount: 1750, deduction_type: null })
    // Unflagged rows are untouched.
    expect(split.customerItems.slice(1)).toEqual(skvItems().slice(1))
  })

  it('books in one step without a deduction, in a foreign currency, or without a per-line momssats', () => {
    expect(splitDeductionShare([item({ deduction_type: null, deduction_amount: 0 })], 'SEK')).toBeNull()
    expect(splitDeductionShare(skvItems(), 'EUR')).toBeNull()
    expect(splitDeductionShare([item({ vat_rate: undefined as unknown as number })], 'SEK')).toBeNull()
    expect(splitDeductionShare(undefined, 'SEK')).toBeNull()
  })
})

describe('kontantmetoden: customer payment, then payout', () => {
  it('the payment books the customer share: 19 250 to the bank, 3 850 moms, no 1513', () => {
    const lines = cash(invoice())
    expect(balanced(lines)).toBe(true)
    expect(lines.find((line) => line.account_number === '1930')?.debit_amount).toBe(19250)
    expect(lines.some((line) => line.account_number === '1513')).toBe(false)
    expect(netByAccount(lines)['2611']).toBe(3850)
    expect(netByAccount(lines)['3001']).toBe(15400)
  })

  it('the payout books the deduction share: 3 000 revenue, 750 moms', () => {
    const recognition = buildDeductionRecognitionLines(invoice(), 'aktiebolag')!
    expect(recognition.totalSek).toBe(3750)
    expect(netByAccount(recognition.lines)).toEqual({ '3001': 3000, '2611': 750 })
    expect(recognition.lines[0].line_description).toBe('Försäljning faktura 1042, ROT-avdrag')
  })

  it('payment plus payout equal the faktureringsmetod registration on every revenue and moms account', () => {
    const cases: Invoice[] = [
      invoice(),
      // A legacy öre deduction, a second rate, a rabatt and an own revenue account.
      invoice({
        total: 3098.25,
        items: [
          item({ unit_price: 1234.5, line_total: 1234.5, vat_amount: 308.63, deduction_amount: 462.94 }),
          item({
            id: 'item-2',
            sort_order: 1,
            line_total: 900,
            vat_amount: 108,
            vat_rate: 12,
            revenue_account: '3041',
            deduction_type: 'rut',
            deduction_amount: 504,
          }),
          item({ id: 'item-3', sort_order: 2, line_total: 437.7, vat_amount: 109.42, deduction_type: null, deduction_amount: 0 }),
        ],
      }),
    ]
    for (const inv of cases) {
      const registration = netByAccount(buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { deferAccruals: false }))
      const paid = netByAccount([...cash(inv), ...buildDeductionRecognitionLines(inv, 'aktiebolag')!.lines])
      for (const account of Object.keys(registration).filter((a) => !a.startsWith('15'))) {
        expect(paid[account], `account ${account}`).toBe(registration[account])
      }
    }
  })

  it('a partly approved claim books revenue and moms on what Skatteverket paid only', () => {
    // Beslut: 3 000 of the 3 750 requested.
    const recognition = buildDeductionRecognitionLines(invoice(), 'aktiebolag', 3000)!
    expect(recognition.totalSek).toBe(3000)
    expect(netByAccount(recognition.lines)).toEqual({ '3001': 2400, '2611': 600 })
    // Nothing paid: nothing booked.
    expect(buildDeductionRecognitionLines(invoice(), 'aktiebolag', 0)).toEqual({ lines: [], totalSek: 0 })
  })

  it('scales several deduction lines to the paid kronor, the öre residual on the largest', () => {
    const split = splitDeductionShare(
      [item({ deduction_amount: 1000 }), item({ id: 'item-2', deduction_amount: 2000 })],
      'SEK',
    )!
    const scaled = scaleDeductionItems(split.deductionItems, 1000.01)
    const totals = scaled.map((row) => roundOre(row.line_total + row.vat_amount))
    expect(totals).toEqual([333.34, 666.67])
    expect(roundOre(totals.reduce((a, b) => a + b, 0))).toBe(1000.01)
  })

  it('the year-end carry of the share alone balances 1513 against the share\'s revenue and moms', () => {
    const lines = buildDeductionCarryLines(invoice(), 'aktiebolag')!
    expect(balanced(lines)).toBe(true)
    expect(netByAccount(lines)).toEqual({ '1513': -3750, '3001': 3000, '2611': 750 })
  })
})

describe('faktureringsmetoden is unchanged', () => {
  it('a kontantfaktura without the flag books the full revenue and moms with 1513 for the deduction', () => {
    const lines = buildInvoiceCashLines(invoice(), 'aktiebolag').lines
    expect(netByAccount(lines)).toEqual({ '1930': -19250, '1513': -3750, '3001': 18400, '2611': 4600 })
  })

  it('the registration still books 1510 + 1513 against the full revenue and moms', () => {
    const lines = buildInvoiceRegistrationLines(invoice(), 'aktiebolag')
    expect(netByAccount(lines)).toEqual({ '1510': -19250, '1513': -3750, '3001': 18400, '2611': 4600 })
  })
})

describe('a kreditfaktura of a kontantmetod ROT/RUT invoice', () => {
  // The original's rows negated, the deduction a positive magnitude (buildCreditNoteItem).
  const creditNote = () =>
    invoice({
      id: 'cn-1',
      invoice_number: 'K-7',
      subtotal: -18400,
      vat_amount: -4600,
      total: -23000,
      items: skvItems().map((row) => ({
        ...row,
        quantity: -1,
        line_total: -row.line_total,
        vat_amount: -row.vat_amount,
      })),
    })

  it("reverses only the customer's share, back onto 1510, while Skatteverket's share is unbooked", () => {
    const lines = buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42', { deductionBookedSek: 0 })
    expect(balanced(lines)).toBe(true)
    expect(netByAccount(lines)).toEqual({ '3001': -15400, '2611': -3850, '1510': 19250 })
    // Together with the payment entry nothing is left on any account but the refund owed.
    const net = netByAccount([...cash(invoice()), ...lines])
    expect(net).toEqual({ '1930': -19250, '3001': 0, '2611': 0, '1510': 19250 })
  })

  it('reverses it all, 1513 included, once the payout booked the share (and without the flag)', () => {
    const lines = buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42')
    expect(netByAccount(lines)).toEqual({ '3001': -18400, '2611': -4600, '1510': 19250, '1513': 3750 })
    // The whole share booked by the payout is exactly the full reversal.
    expect(buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42', { deductionBookedSek: 3750 })).toEqual(lines)
    expect(buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42', { deductionBookedSek: null })).toEqual(lines)
  })

  it('after a partial payout reverses only what the payout booked of the share, 1513 for what is owed back (issue #93)', () => {
    // Beslut: 3 000 of the 3 750 requested; the payout booked 2 400 revenue and 600 moms.
    const lines = buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42', { deductionBookedSek: 3000 })
    expect(balanced(lines)).toBe(true)
    expect(netByAccount(lines)).toEqual({ '3001': -17800, '2611': -4450, '1510': 19250, '1513': 3000 })
    // Payment, payout and credit: no revenue or moms left, the refund owed to
    // the customer on 1510 and what Skatteverket paid owed back on 1513.
    const payout = buildDeductionRecognitionLines(invoice(), 'aktiebolag', 3000)!.lines
    const net = netByAccount([
      ...cash(invoice()),
      { account_number: '1930', debit_amount: 3000, credit_amount: 0 },
      ...payout,
      ...lines,
    ])
    expect(net).toEqual({ '1930': -22250, '3001': 0, '2611': 0, '1510': 19250, '1513': 3000 })
    // The old rule reversed the whole share: the refused 750 kr, 600 revenue and 150 moms, too much.
    const whole = netByAccount([...cash(invoice()), ...payout, ...buildCreditNoteLines(creditNote(), 'aktiebolag', 'A-42')])
    expect(whole['2611']).toBe(-150)
    expect(whole['3001']).toBe(-600)
  })
})
