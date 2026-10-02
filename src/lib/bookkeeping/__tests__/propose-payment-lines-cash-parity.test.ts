/**
 * The kontantmetoden payment dialog submits its proposed lines verbatim, so
 * the proposal must be the entry createInvoiceCashEntry books on every other
 * door (bank match, v1, MCP): buildInvoiceCashLines. These pin that parity on
 * the shapes the old hand-kept copy got wrong.
 */
import { describe, it, expect } from 'vitest'
import { proposePaymentLines } from '../propose-payment-lines'
import { buildInvoiceCashLines } from '../invoice-lines'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem, VatTreatment } from '@/types'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    sort_order: 0,
    created_at: '2026-09-01',
    ...overrides,
  }
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '2026-042',
    total: 1250,
    total_sek: null,
    subtotal: 1000,
    subtotal_sek: null,
    vat_amount: 250,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25' as VatTreatment,
    items: [item()],
    ...overrides,
  } as Invoice
}

type AnyLine = Pick<FormLine, 'account_number' | 'dimensions'> & {
  debit_amount: number | string
  credit_amount: number | string
}

const signature = (lines: AnyLine[]) =>
  lines.map((l) => ({
    account: l.account_number,
    debit: Number(l.debit_amount) || 0,
    credit: Number(l.credit_amount) || 0,
    dimensions: l.dimensions && Object.keys(l.dimensions).length > 0 ? l.dimensions : undefined,
  }))

function propose(inv: Invoice) {
  return proposePaymentLines({ invoice: inv, accountingMethod: 'cash', entityType: 'aktiebolag' })
}

function booked(inv: Invoice): CreateJournalEntryLineInput[] {
  return buildInvoiceCashLines(inv, 'aktiebolag').lines
}

describe('proposePaymentLines (cash) proposes what createInvoiceCashEntry books', () => {
  it('credits an item on its own revenue account, not the VAT rate default', () => {
    const inv = invoice({ items: [item({ revenue_account: '3041' })] })
    expect(signature(propose(inv))).toEqual(signature(booked(inv)))
    expect(propose(inv).map((l) => l.account_number)).toEqual(['1930', '3041', '2611'])
  })

  it('a momsfri item on its own account stays there (not 3004)', () => {
    const inv = invoice({
      vat_treatment: 'exempt',
      total: 200,
      subtotal: 200,
      vat_amount: 0,
      items: [item({ revenue_account: '3221', vat_rate: 0, vat_amount: 0, unit_price: 200, line_total: 200 })],
    })
    expect(signature(propose(inv))).toEqual(signature(booked(inv)))
    expect(propose(inv).map((l) => l.account_number)).toEqual(['1930', '3221'])
  })

  it('goods delivered to another EU country book 3108, not 3308 (#2906)', () => {
    const inv = invoice({
      vat_treatment: 'reverse_charge',
      delivery_country: 'DE',
      total: 1000,
      vat_amount: 0,
      items: [item({ vat_rate: 0, vat_amount: 0 })],
    })
    expect(signature(propose(inv))).toEqual(signature(booked(inv)))
    expect(propose(inv).map((l) => l.account_number)).toEqual(['1930', '3108'])
  })

  it('items tagged differently keep their own revenue lines and bags', () => {
    const inv = invoice({
      total: 2500,
      subtotal: 2000,
      vat_amount: 500,
      default_dimensions: { '6': 'P1' },
      items: [
        item({ id: 'a', dimensions: { '1': 'K1' } }),
        item({ id: 'b', dimensions: { '1': 'K2' } }),
      ],
    })
    const proposed = propose(inv)
    expect(signature(proposed)).toEqual(signature(booked(inv)))
    expect(proposed.filter((l) => l.account_number === '3001').map((l) => l.dimensions)).toEqual([
      { '6': 'P1', '1': 'K1' },
      { '6': 'P1', '1': 'K2' },
    ])
  })

  it('ROT: 1513 per item, bank gets the customer share', () => {
    // 1 000 labor + 25 % = 1 250; ROT 30 % = 375.
    const inv = invoice({ deduction_total: 375, items: [item({ deduction_type: 'rot' })] })
    expect(signature(propose(inv))).toEqual(signature(booked(inv)))
    expect(propose(inv).find((l) => l.account_number === '1930')?.debit_amount).toBe('875')
  })

  it('öresavrundning is the one addition: bank leg at "Att betala", 3740 the residual', () => {
    const inv = invoice({
      total: 1250.4,
      subtotal: 1000.32,
      vat_amount: 250.08,
      items: [item({ revenue_account: '3041', unit_price: 1000.32, line_total: 1000.32, vat_amount: 250.08 })],
    })
    const proposed = proposePaymentLines({
      invoice: inv,
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
      companyOreRounding: true,
    })
    const [bank, ...rest] = signature(booked(inv))
    expect(signature(proposed)).toEqual([
      { ...bank, debit: 1250 },
      ...rest,
      { account: '3740', debit: 0.4, credit: 0, dimensions: undefined },
    ])
  })
})
