import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { allocateDocumentVat } from '@/lib/vat/document-vat'
import {
  supplierInvoiceRegistrationLines,
  type SupplierInvoiceBookingItem,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { bookLimitedDeduction, limitedDeductionApplies } from '../limited-deduction'
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
