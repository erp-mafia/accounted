import { beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeSupplierInvoice, makeSupplier } from '@/tests/helpers'
import type { CreateJournalEntryInput, SupplierInvoiceItem } from '@/types'
import { buildSupplierInvoicePayload, type SupplierInvoiceFormData } from '../form-payload'
import { createSupplierInvoiceRegistrationEntry, createSupplierInvoiceCashEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import { formatAmount } from '@/lib/utils'
import { roundOre } from '@/lib/money'

vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(async (_db, _company, _user, input: CreateJournalEntryInput) => ({ id: 'entry-1', ...input })),
}))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/account-number', () => ({ AccountNumber: ({ number }: { number: string }) => number }))

const form: SupplierInvoiceFormData = {
  supplier_id: 'supplier-1', supplier_invoice_number: 'ROUND-1', invoice_date: '2026-09-01',
  due_date: '2026-09-30', delivery_date: '', currency: 'SEK', exchange_rate: '',
  reverse_charge: false, payment_reference: '', notes: '', payer: 'unpaid',
  claimant_name: '', employee_id: '',
  items: [
    { description: 'Purchase', amount: 16000, account_number: '6110', vat_rate: 0.25 },
    { description: 'Fee', amount: 45, account_number: '3540', vat_rate: 0.25 },
  ],
}

beforeEach(() => vi.clearAllMocks())

it.each([false, true])('saves the previewed payable and keeps VAT unchanged (reverse charge %s)', async (reverseCharge) => {
  const data = reverseCharge
    ? { ...form, reverse_charge: true, items: [{ ...form.items[0], amount: 100.4, vat_rate: 0, reverse_charge_rate: 0.12 }] }
    : form
  const payload = buildSupplierInvoicePayload(data, {
    oreRounding: true, inboxItemId: null, uploadedDocumentId: undefined,
    defaultDims: {}, canUseAccrual: false,
  })
  const items: SupplierInvoiceItem[] = payload.items.map((item, i) => ({
    ...item, id: `item-${i}`, supplier_invoice_id: 'invoice-1', sort_order: i,
    line_total: roundOre(item.amount), quantity: 1, unit_price: item.amount,
    unit: 'st', vat_code: null, vat_amount: roundOre(item.amount * item.vat_rate),
    reverse_charge_rate: item.reverse_charge_rate ?? null, created_at: '2026-09-01T00:00:00Z',
  }))
  const subtotal = roundOre(items.reduce((sum, item) => sum + item.line_total, 0))
  const vat = roundOre(items.reduce((sum, item) => sum + item.vat_amount, 0))
  const total = roundOre(subtotal + vat)
  const invoice = makeSupplierInvoice({
    subtotal, vat_amount: vat, total, remaining_amount: total, reverse_charge: reverseCharge,
    vat_treatment: reverseCharge ? 'reverse_charge' : 'standard_25',
  })
  await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, items, 'swedish_business')
  await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, items, '2026-09-21', 'swedish_business')
  for (const [i, anchor] of ['2440', '1930'].entries()) {
    const lines = vi.mocked(createJournalEntry).mock.calls[i][3].lines
    expect(lines.find(l => l.account_number === anchor)?.credit_amount).toBe(reverseCharge ? 100 : 20056)
    expect(lines.find(l => l.account_number === '3740')?.credit_amount).toBe(reverseCharge ? 0.4 : 0.25)
    expect(lines.find(l => l.account_number === (reverseCharge ? '2647' : '2641'))?.debit_amount).toBe(reverseCharge ? 12.05 : 4011.25)
    expect(roundOre(lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0))).toBe(0)
    if (reverseCharge) expect(lines.find(l => l.account_number === '4426')?.debit_amount).toBe(100.4)
  }
})

it.each([false, true])('renders a rounding credit and the actual 2440 total (explicit item %s)', (explicit) => {
  const items = explicit
    ? [...form.items, { description: 'Rounding', amount: -0.25, account_number: '3740', vat_rate: 0 }]
    : form.items
  const html = renderToStaticMarkup(createElement(SupplierInvoiceReviewContent, {
    supplier: makeSupplier(), invoiceNumber: form.supplier_invoice_number,
    invoiceDate: form.invoice_date, dueDate: form.due_date,
    currency: 'SEK', reverseCharge: false, items, oreRounding: true,
  }))
  const body = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].at(-1)![1]
  const cellsFor = (account: string) => {
    const row = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].find(m => m[1].includes(account))![1]
    return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '')).slice(-2)
  }
  expect(cellsFor('3740')).toEqual(['', formatAmount(0.25)])
  expect(cellsFor('2440')).toEqual(['', formatAmount(20056)])
})
