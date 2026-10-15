import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeSupplierInvoice, makeSupplier } from '@/tests/helpers'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, SupplierInvoiceItem } from '@/types'
import { buildSupplierInvoicePayload, inferVatTreatment, type SupplierInvoiceFormData, type SupplierInvoiceLineItem } from '../form-payload'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import { formatAmount } from '@/lib/utils'
import { roundOre } from '@/lib/money'

vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(async (_db, _company, _user, input: CreateJournalEntryInput) => ({ id: 'entry-1', ...input })),
}))
vi.mock('@/lib/bookkeeping/chart-vat-treatments', () => ({ fetchChartVatTreatments: vi.fn(async () => new Map()) }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/account-number', () => ({ AccountNumber: ({ number }: { number: string }) => number }))

// crm#1190: the "Verifikation som bokförs" preview of the review dialog kept
// its own copy of the registration rules and dropped the moms of every row
// below zero (a rabatt row) before summing per rate: 2641 came out too high
// and the preview did not balance, while the verifikat actually posted was
// right. The preview now runs the posting builder itself; these tests hold
// the rendered preview to the posted lines, row for row.

const header = {
  supplier_id: 'supplier-1', supplier_invoice_number: 'M-1190', invoice_date: '2026-10-01',
  due_date: '2026-10-31', delivery_date: '', currency: 'SEK', exchange_rate: '',
  reverse_charge: false, payment_reference: '', notes: '', payer: 'unpaid',
  claimant_name: '', employee_id: '',
} satisfies Omit<SupplierInvoiceFormData, 'items'>

type Row = [account: string, debit: string, credit: string]

/** [account, debit, credit] per line row of the rendered preview, without the Summa row. */
function previewRows(items: SupplierInvoiceLineItem[], oreRounding: boolean): Row[] {
  const html = renderToStaticMarkup(createElement(SupplierInvoiceReviewContent, {
    supplier: makeSupplier({ supplier_type: 'swedish_business' }),
    invoiceNumber: header.supplier_invoice_number,
    invoiceDate: header.invoice_date,
    dueDate: header.due_date,
    currency: 'SEK',
    reverseCharge: false,
    items,
    oreRounding,
    bookingMoment: 'issue',
    chartVatTreatments: new Map(),
  }))
  const body = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].at(-1)![1]
  const text = (cell: string) => cell.replace(/<[^>]+>/g, '')
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .filter((row) => !/colspan/i.test(row[1]))
    .map((row) => {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1]))
      return [cells[0], cells[2], cells[3]] as Row
    })
}

/**
 * Register the form's rows the way the create paths store them (payload, then
 * line_total and vat_amount per row as lib/supplier-invoices/create.ts
 * computes them) and return the verifikat the registration posts.
 */
async function bookedLines(items: SupplierInvoiceLineItem[], oreRounding: boolean) {
  const data: SupplierInvoiceFormData = { ...header, items }
  const payload = buildSupplierInvoicePayload(data, {
    oreRounding, inboxItemId: null, uploadedDocumentId: undefined, defaultDims: {}, canUseAccrual: true,
  })
  const stored: SupplierInvoiceItem[] = payload.items.map((item, i) => ({
    ...item, id: `item-${i}`, supplier_invoice_id: 'invoice-1', sort_order: i,
    line_total: roundOre(item.amount), quantity: 1, unit_price: item.amount, unit: 'st',
    vat_code: null, vat_amount: roundOre(roundOre(item.amount) * item.vat_rate),
    reverse_charge_rate: null, created_at: '2026-10-01T00:00:00Z',
  }))
  const subtotal = roundOre(stored.reduce((sum, item) => sum + item.line_total, 0))
  const vat = roundOre(stored.reduce((sum, item) => sum + item.vat_amount, 0))
  const total = roundOre(subtotal + vat)
  const invoice = makeSupplierInvoice({
    subtotal, vat_amount: vat, total, remaining_amount: total, reverse_charge: false,
    vat_treatment: inferVatTreatment(items, false),
  })
  await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, stored, 'swedish_business')
  const lines = vi.mocked(createJournalEntry).mock.calls.at(-1)![3].lines
  return { lines, total, vat }
}

const asRows = (lines: CreateJournalEntryLineInput[]): Row[] =>
  lines
    .filter((l) => l.debit_amount !== 0 || l.credit_amount !== 0)
    .map((l) => [
      l.account_number,
      l.debit_amount ? formatAmount(l.debit_amount) : '',
      l.credit_amount ? formatAmount(l.credit_amount) : '',
    ])

const net = (lines: CreateJournalEntryLineInput[], account: string) =>
  roundOre(lines.filter((l) => l.account_number === account).reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0))

const balance = (lines: CreateJournalEntryLineInput[]) =>
  roundOre(lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0))

beforeEach(() => vi.clearAllMocks())

describe('review preview equals the posted registration verifikat (crm#1190)', () => {
  it('the reported mobile subscription: rabatt rows lower 2641 to 74,75 and both sides are 1 024,00', async () => {
    const items: SupplierInvoiceLineItem[] = [
      { description: 'Abonnemang', amount: 449, account_number: '6212', vat_rate: 0.25 },
      { description: 'Rabatt under bindningstid', amount: -50, account_number: '6212', vat_rate: 0.25 },
      { description: 'Abonnemangsrabatt', amount: -100, account_number: '6212', vat_rate: 0.25 },
      { description: 'Månadsbetalning mobil', amount: 650, account_number: '2410', vat_rate: 0 },
    ]
    const { lines, total, vat } = await bookedLines(items, true)

    expect(vat).toBe(74.75)
    expect(total).toBe(1024)
    expect(asRows(lines)).toEqual([
      ['6212', formatAmount(299), ''],
      ['2410', formatAmount(650), ''],
      ['3740', formatAmount(0.25), ''],
      ['2641', formatAmount(74.75), ''],
      ['2440', '', formatAmount(1024)],
    ])
    expect(balance(lines)).toBe(0)
    expect(previewRows(items, true)).toEqual(asRows(lines))
  })

  it('a leverantörskreditfaktura keyed in as an invoice (every row negative) credits 2641 and debits 2440 by the total', async () => {
    const items: SupplierInvoiceLineItem[] = [
      { description: 'Retur', amount: -800, account_number: '5410', vat_rate: 0.25 },
      { description: 'Retur frakt', amount: -100, account_number: '6212', vat_rate: 0.25 },
    ]
    const { lines, total } = await bookedLines(items, false)

    expect(total).toBe(-1125)
    expect(asRows(lines)).toEqual([
      ['5410', '', formatAmount(800)],
      ['6212', '', formatAmount(100)],
      ['2641', '', formatAmount(225)],
      ['2440', formatAmount(1125), ''],
    ])
    expect(net(lines, '2440')).toBe(-total)
    expect(balance(lines)).toBe(0)
    expect(previewRows(items, false)).toEqual(asRows(lines))
  })

  it('mixed rates: one 2641 line per rate on its own side, a rate whose returns outweigh it on the credit side', async () => {
    const items: SupplierInvoiceLineItem[] = [
      { description: 'Kontorsmaterial', amount: 800, account_number: '6110', vat_rate: 0.25 },
      { description: 'Rabatt', amount: -200, account_number: '6110', vat_rate: 0.25 },
      { description: 'Varor 12 %', amount: 300, account_number: '4010', vat_rate: 0.12 },
      { description: 'Retur 12 %', amount: -500, account_number: '4010', vat_rate: 0.12 },
      { description: 'Tidningar', amount: 100, account_number: '6970', vat_rate: 0.06 },
    ]
    const { lines, total, vat } = await bookedLines(items, false)

    expect(vat).toBe(132)
    expect(total).toBe(632)
    expect(asRows(lines)).toEqual([
      ['6110', formatAmount(600), ''],
      ['4010', '', formatAmount(200)],
      ['6970', formatAmount(100), ''],
      ['2641', formatAmount(150), ''],
      ['2641', '', formatAmount(24)],
      ['2641', formatAmount(6), ''],
      ['2440', '', formatAmount(632)],
    ])
    expect(net(lines, '2641')).toBe(vat)
    expect(net(lines, '2440')).toBe(-total)
    expect(balance(lines)).toBe(0)
    expect(previewRows(items, false)).toEqual(asRows(lines))
  })
})
