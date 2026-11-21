import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { allocateDocumentVat } from '@/lib/vat/document-vat'
import {
  supplierInvoiceRegistrationLines,
  type SupplierInvoiceBookingItem,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import {
  PERSONBIL_LEASE_HIRE_ACCOUNTS,
  bookLimitedDeduction,
  deductStagedLines,
  deductibleRowVat,
  deductionForStatedVat,
  invoicedRowVat,
  isPersonbilLeaseOrHireAccount,
  limitedDeductionApplies,
  type LimitedDeductionRow,
} from '../limited-deduction'
import {
  buildSupplierInvoicePayload,
  statedVatFromInvoiceField,
  type SupplierInvoiceFormData,
  type SupplierInvoiceLineItem,
} from '../form-payload'

// crm#1617: a leasing invoice for a personbil, 4 000 kr + 1 000 kr moms. Only
// half the moms is ingående moms (ML 2023:200 13 kap.); the other half is a
// cost on 5615. The editor had no way to say so: typing the half into the
// Moms field only showed "Momsdiff -500,00 mot raderna" and the registration
// still deducted all 1 000 kr.

const header = {
  supplier_id: '7d3f1c2a-5b6e-4c8d-9a0b-1c2d3e4f5a6b', supplier_invoice_number: 'L-1617', invoice_date: '2026-11-01',
  due_date: '2026-11-30', delivery_date: '', currency: 'SEK', exchange_rate: '',
  reverse_charge: false, reverse_charge_kind: '', payment_reference: '', notes: '', payer: 'unpaid',
  claimant_name: '', employee_id: '',
} satisfies Omit<SupplierInvoiceFormData, 'items'>

function row(overrides: Partial<SupplierInvoiceLineItem> = {}): SupplierInvoiceLineItem {
  return { description: 'Leasing personbil november', amount: 4000, account_number: '5615', vat_rate: 0.25, ...overrides }
}

function payloadOf(items: SupplierInvoiceLineItem[], statedVat: number | null = null) {
  const data: SupplierInvoiceFormData = { ...header, items }
  return payloadOfData(data, statedVat)
}

function payloadOfData(data: SupplierInvoiceFormData, statedVat: number | null = null) {
  const items = data.items
  return buildSupplierInvoicePayload(data, {
    inboxItemId: null, uploadedDocumentId: undefined, oreRounding: false, defaultDims: {},
    canUseAccrual: true, euSupplier: false,
    statedVat: statedVatFromInvoiceField(bookLimitedDeduction(items, limitedDeductionApplies(data)).items, statedVat, false),
  })
}

/** The registration verifikat of a payload, stored the way lib/supplier-invoices/create.ts stores it. */
function registrationOf(payload: ReturnType<typeof payloadOf>) {
  const parsed = CreateSupplierInvoiceSchema.parse(payload)
  const allocated = allocateDocumentVat(
    parsed.items.map((item) => ({ lineTotal: roundOre(item.amount!), rate: item.vat_rate ?? 0, overrideVat: item.vat_amount ?? null })),
    parsed.vat_breakdown?.map((entry) => ({ rate: entry.vat_rate, vatAmount: entry.vat_amount })) ?? null,
  )
  if (!allocated.ok) throw new Error(`refused: ${JSON.stringify(allocated.details)}`)
  const items: SupplierInvoiceBookingItem[] = parsed.items.map((item, index) => ({
    account_number: item.account_number, line_total: roundOre(item.amount!), vat_rate: item.vat_rate ?? 0,
    vat_amount: allocated.lineVat[index], reverse_charge_rate: null, accrual_period_start: null,
    accrual_period_end: null, accrual_balance_account: null, dimensions: {}, apply_slp: false,
  }))
  const lines = supplierInvoiceRegistrationLines(
    { currency: 'SEK', exchange_rate: null, reverse_charge: false, reverse_charge_kind: null,
      vat_treatment: parsed.vat_treatment!, default_dimensions: {}, total: 0 },
    items, 'swedish_business', 'L-1617', undefined,
  )
  return lines.map((line) => [line.account_number, line.debit_amount, line.credit_amount])
}

describe('bookLimitedDeduction', () => {
  it('books half the moms of a leased personbil as cost and keeps the invoice total payable', () => {
    const lines = registrationOf(payloadOf([row({ vat_deduction_share: 0.5 })]))
    expect(lines).toEqual([
      ['5615', 4500, 0],
      ['2641', 500, 0],
      ['2440', 0, 5000],
    ])
  })

  it('a row without a deduction set books all its moms, as before', () => {
    expect(registrationOf(payloadOf([row()]))).toEqual([
      ['5615', 4000, 0],
      ['2641', 1000, 0],
      ['2440', 0, 5000],
    ])
  })

  it('no deductible moms at all books the whole moms as cost, with no 2641 line', () => {
    const payload = payloadOf([row({ vat_deduction_share: 0 })])
    // The supplier still charged moms: the invoice is not momsfri.
    expect(payload.vat_treatment).toBe('standard_25')
    expect(registrationOf(payload)).toEqual([
      ['5615', 5000, 0],
      ['2440', 0, 5000],
    ])
  })

  it('a limited row beside an ordinary one: only the limited row moves moms to cost', () => {
    const items = [row({ vat_deduction_share: 0.5 }), row({ description: 'Service', account_number: '5613', amount: 800 })]
    expect(registrationOf(payloadOf(items, 1200))).toEqual([
      ['5615', 4500, 0],
      ['5613', 800, 0],
      ['2641', 700, 0],
      ['2440', 0, 6000],
    ])
  })

  it('the invoice moms typed into the Moms field does not make the registration refuse', () => {
    expect(registrationOf(payloadOf([row({ vat_deduction_share: 0.5 })], 1000))).toEqual([
      ['5615', 4500, 0],
      ['2641', 500, 0],
      ['2440', 0, 5000],
    ])
  })

  it('holds the deduction between 0 and the row moms', () => {
    const { items, nonDeductibleVat } = bookLimitedDeduction(
      [row({ vat_deduction_share: 1.5 }), row({ vat_deduction_share: -0.1 })],
      true,
    )
    expect(items[0]).toEqual(row())
    expect(nonDeductibleVat[0]).toBe(0)
    expect(items[1]).toMatchObject({ amount: 5000, vat_rate: 0 })
    expect(nonDeductibleVat[1]).toBe(1000)
  })

  it('reports per row the moms moved to cost, and strips the editor field', () => {
    const { items, nonDeductibleVat } = bookLimitedDeduction([row({ amount: 1234.57, vat_deduction_share: 0.5 })], true)
    const invoiced = netVat(1234.57, 0.25)
    const deductible = roundOre(invoiced * 0.5)
    expect(nonDeductibleVat).toEqual([roundOre(invoiced - deductible)])
    expect(items[0]).toMatchObject({ amount: roundOre(1234.57 + invoiced - deductible), vat_amount: deductible, vat_rate: 0.25 })
    expect(items[0]).not.toHaveProperty('vat_deduction_share')
  })

  it('a corrected amount keeps the deduction in proportion', () => {
    expect(registrationOf(payloadOf([row({ amount: 8000, vat_deduction_share: 0.5 })]))).toEqual([
      ['5615', 9000, 0],
      ['2641', 1000, 0],
      ['2440', 0, 10000],
    ])
  })

  it('does nothing under reverse charge or on a self-billing invoice', () => {
    expect(limitedDeductionApplies({ reverse_charge: true })).toBe(false)
    expect(limitedDeductionApplies({ reverse_charge: false, is_self_billed: true })).toBe(false)
    const { items, nonDeductibleVat } = bookLimitedDeduction([row({ vat_deduction_share: 0.5 })], false)
    expect(items[0]).toEqual(row())
    expect(nonDeductibleVat).toEqual([0])
    const selfBilled = payloadOfData({ ...header, is_self_billed: true, items: [row({ vat_deduction_share: 0.5 })] })
    expect(selfBilled.items[0]).toMatchObject({ amount: 4000, vat_rate: 0.25 })
    expect(selfBilled.items[0]).not.toHaveProperty('vat_amount')
  })
})

describe('invoicedRowVat', () => {
  it('is amount × moms sats on an editor row, which states no moms of its own', () => {
    expect(invoicedRowVat({ amount: 4000, vat_rate: 0.25 })).toBe(1000)
  })

  it('is the row\'s invoiced_vat when the door has the figure, even an öre off amount × sats', () => {
    // 100.03 × 25 % is 25.01; the seller's per-line rounding printed 25.00.
    // The deduction splits what the invoice charged, so the row incl. moms
    // stays what the invoice bills.
    expect(invoicedRowVat({ amount: 100.03, vat_rate: 0.25, invoiced_vat: 25 })).toBe(25)
    const booked = bookLimitedDeduction<LimitedDeductionRow>([{ amount: 100.03, vat_rate: 0.25, invoiced_vat: 25, vat_deduction_share: 0.5 }], true)
    expect(booked.items[0]).toMatchObject({ amount: 112.53, vat_amount: 12.5 })
    expect(roundOre(booked.items[0].amount + (booked.items[0].vat_amount ?? 0))).toBe(125.03)
  })
})

describe('deductStagedLines', () => {
  // The MCP inbox door's lines for the leasing invoice of the report: the
  // personbil leasing deducts half its moms, the fee all, the insurance has none.
  const lines = [
    { line_number: 1, line_total: 14055, vat_rate: 0.25, vat_amount: 3513.75, account_number: '5615' },
    { line_number: 2, line_total: 495, vat_rate: 0.25, vat_amount: 123.75, account_number: '5690' },
    { line_number: 3, line_total: 800, vat_rate: 0, vat_amount: 0, account_number: '5612' },
  ]

  it('books a line at its share as the editor books the same row, and leaves the others', () => {
    const result = deductStagedLines(lines, new Map([[1, 0.5]]))
    const editor = bookLimitedDeduction<LimitedDeductionRow>([{ amount: 14055, vat_rate: 0.25, vat_deduction_share: 0.5 }], true).items[0]
    expect(result.invalidLines).toEqual([])
    expect(result.lines[0]).toEqual({ ...lines[0], line_total: editor.amount, vat_amount: editor.vat_amount, vat_deduction_share: 0.5 })
    expect(result.lines[0]).toMatchObject({ line_total: 15811.87, vat_amount: 1756.88 })
    expect(result.lines.slice(1)).toEqual(lines.slice(1))
    expect(result.deducted).toEqual([{ line_number: 1, invoiced_vat: 3513.75, deductible_vat: 1756.88, vat_as_cost: 1756.87 }])
    const inclVat = (rows: typeof lines) => roundOre(rows.reduce((sum, row) => sum + row.line_total + row.vat_amount, 0))
    expect(inclVat(result.lines)).toBe(inclVat(lines))
  })

  it('names the lines given a share that the invoice lacks or that carry no moms', () => {
    expect(deductStagedLines(lines, new Map([[3, 0.5], [4, 0.5]])).invalidLines).toEqual([3, 4])
  })

  it('a share of 1 changes nothing', () => {
    const result = deductStagedLines(lines, new Map([[1, 1]]))
    expect(result.lines).toEqual(lines)
    expect(result.deducted).toEqual([])
  })
})

describe('isPersonbilLeaseOrHireAccount', () => {
  it('is personbil leasing and car hire, from the booking templates', () => {
    // Billeasing (5615 Leasing av personbilar) and Hyrbil (5820 Hyrbilskostnader).
    expect([...PERSONBIL_LEASE_HIRE_ACCOUNTS].sort()).toEqual(['5615', '5820'])
    expect(isPersonbilLeaseOrHireAccount('5615')).toBe(true)
    expect(isPersonbilLeaseOrHireAccount('5820')).toBe(true)
    const leasing = BOOKING_TEMPLATES.find((template) => template.id === 'vehicle_leasing')
    expect(leasing).toMatchObject({ debit_account: '5615', deductibility: 'conditional' })
  })

  it('is not a lastbil, a fuel or a repair account', () => {
    for (const account of ['5625', '5611', '5613', '5690', '6072', '']) {
      expect(isPersonbilLeaseOrHireAccount(account)).toBe(false)
    }
    expect(isPersonbilLeaseOrHireAccount(undefined)).toBe(false)
  })
})

describe('deductionForStatedVat', () => {
  // crm#1954: a personbil leasing invoice, leasing fee 3 995 + 25 % and
  // invoicing fee 50 + 25 %, with 511,88 typed into the Moms field: half the
  // moms on the leasing fee, all of it on the invoicing fee.
  const leasing = row({ description: 'Leasingavgift', amount: 3995 })
  const fee = row({ description: 'Faktureringsavgift', amount: 50, account_number: '6570' })

  it('puts the whole difference on the personbil row, to the öre', () => {
    const result = deductionForStatedVat([leasing, fee], 511.88, true)
    expect(result).toEqual({ nonDeductibleVat: 499.37, rows: [{ index: 0, share: expect.any(Number), deductibleVat: 499.38 }] })
    const applied = [{ ...leasing, vat_deduction_share: result!.rows[0].share }, fee]
    expect(deductibleRowVat(leasing, result!.rows[0].share)).toBe(499.38)
    const booked = bookLimitedDeduction(applied, true)
    expect(booked.nonDeductibleVat).toEqual([499.37, 0])
    expect(booked.items[0]).toMatchObject({ amount: 4494.37, vat_amount: 499.38 })
    // The registration deducts exactly the typed moms, and the payable stays the invoice total.
    expect(registrationOf(payloadOf(applied, 511.88))).toEqual([
      ['5615', 4494.37, 0],
      ['6570', 50, 0],
      ['2641', 511.88, 0],
      ['2440', 0, 5056.25],
    ])
  })

  it('prefers the personbil row even when another row carries more moms', () => {
    const service = row({ description: 'Service', amount: 6000, account_number: '5613' })
    const result = deductionForStatedVat([service, row({ amount: 2000 })], 1750, true)
    expect(result?.rows).toEqual([{ index: 1, share: 0.5, deductibleVat: 250 }])
  })

  it('without a personbil row takes the row with the most moms', () => {
    const small = row({ amount: 100, account_number: '6072' })
    const large = row({ amount: 800, account_number: '6071' })
    const result = deductionForStatedVat([small, large], 125, true)
    expect(result).toEqual({ nonDeductibleVat: 100, rows: [{ index: 1, share: 0.5, deductibleVat: 100 }] })
  })

  it('fills the next row when the difference is more than one row carries', () => {
    // 1 011,25 kr of moms, 10 kr typed: the leasing row deducts nothing, the fee 10 kr.
    const result = deductionForStatedVat([leasing, fee], 10, true)
    expect(result?.nonDeductibleVat).toBe(1001.25)
    expect(result?.rows).toEqual([
      { index: 0, share: 0, deductibleVat: 0 },
      { index: 1, share: 0.8, deductibleVat: 10 },
    ])
    const booked = bookLimitedDeduction([
      { ...leasing, vat_deduction_share: result!.rows[0].share },
      { ...fee, vat_deduction_share: result!.rows[1].share },
    ], true)
    expect(booked.nonDeductibleVat).toEqual([998.75, 2.5])
  })

  it('counts a deduction the rows already carry and moves only the rest', () => {
    const halved = { ...leasing, vat_deduction_share: 0.5 }
    // The leasing row already deducts 499,38: 511,88 typed leaves nothing to do.
    expect(deductionForStatedVat([halved, fee], 511.88, true)).toBeNull()
    const result = deductionForStatedVat([halved, fee], 500, true)
    expect(result).toEqual({ nonDeductibleVat: 11.88, rows: [{ index: 0, share: expect.any(Number), deductibleVat: 487.5 }] })
    expect(deductibleRowVat(leasing, result!.rows[0].share)).toBe(487.5)
  })

  it('does nothing when the typed moms is not lower than the rows deduct', () => {
    expect(deductionForStatedVat([leasing, fee], 1011.25, true)).toBeNull()
    expect(deductionForStatedVat([leasing, fee], 1200, true)).toBeNull()
  })

  it('never goes negative: no negative moms, a credit row is left alone, nothing when it does not apply', () => {
    expect(deductionForStatedVat([leasing, fee], -1, true)).toBeNull()
    // A credit row carries no moms to move: 1 011,25 less 250 is all the moms there is.
    const credit = row({ amount: -1000, account_number: '5615' })
    expect(deductionForStatedVat([leasing, fee, credit], 0, true)).toEqual({
      nonDeductibleVat: 761.25,
      rows: [
        { index: 0, share: expect.any(Number), deductibleVat: 237.5 },
      ],
    })
    expect(deductionForStatedVat([row({ amount: -1000 })], 0, true)).toBeNull()
    expect(deductionForStatedVat([leasing, fee], 511.88, false)).toBeNull()
    const all = deductionForStatedVat([leasing, fee], 0, true)
    expect(all?.rows.every((r) => r.share >= 0 && r.deductibleVat >= 0)).toBe(true)
    expect(all?.nonDeductibleVat).toBe(1011.25)
  })

  it('gives every deductible figure back to the öre through deductibleRowVat', () => {
    for (const amount of [1, 3.33, 99.99, 1234.57, 3995, 14055, 87654.31]) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const item = row({ amount, vat_rate: rate })
        const full = invoicedRowVat(item)
        for (const deductibleOre of [0, 1, Math.floor(full * 50), Math.round(full * 100) - 1]) {
          const stated = deductibleOre / 100
          if (stated >= full) continue
          const result = deductionForStatedVat([item], stated, true)
          expect(result?.rows).toHaveLength(1)
          expect(deductibleRowVat(item, result!.rows[0].share)).toBe(stated)
          expect(bookLimitedDeduction([{ ...item, vat_deduction_share: result!.rows[0].share }], true).nonDeductibleVat[0])
            .toBe(roundOre(full - stated))
        }
      }
    }
  })
})
