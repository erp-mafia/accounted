import { describe, it, expect } from 'vitest'
import { selectInboxFields } from '@/lib/documents/inbox-field-visibility'

const FIELDS = [
  { key: 'supplier.name', label: 'Leverantör' },
  { key: 'totals.total', label: 'Totalt' },
  { key: 'totals.vatAmount', label: 'Moms' },
  { key: 'supplier.bankgiro', label: 'Bankgiro' },
  { key: 'supplier.plusgiro', label: 'Plusgiro' },
  { key: 'invoice.invoiceNumber', label: 'Fakturanr' },
  { key: 'invoice.paymentReference', label: 'OCR/Referens' },
  { key: 'invoice.invoiceDate', label: 'Fakturadatum' },
  { key: 'invoice.dueDate', label: 'Förfallodatum' },
]

const none = () => false
const keys = (r: { shown: { key: string }[] }) => r.shown.map((f) => f.key)
const labelOf = (r: { shown: { key: string; label: string }[] }, key: string) =>
  r.shown.find((f) => f.key === key)?.label

describe('selectInboxFields', () => {
  it('leaves invoices exactly as they are', () => {
    for (const kind of ['supplier_invoice', 'government_letter', 'other', null, undefined]) {
      const r = selectInboxFields({ documentKind: kind, fields: FIELDS, hasValue: none, showAll: false })
      expect(keys(r)).toEqual(FIELDS.map((f) => f.key))
      expect(r.hiddenCount).toBe(0)
      expect(labelOf(r, 'invoice.invoiceDate')).toBe('Fakturadatum')
    }
  })

  it('hides the five invoice-only fields on a receipt and counts them', () => {
    const r = selectInboxFields({ documentKind: 'receipt', fields: FIELDS, hasValue: none, showAll: false })
    expect(r.hiddenCount).toBe(5)
    expect(keys(r)).toEqual([
      'supplier.name',
      'totals.total',
      'totals.vatAmount',
      'invoice.invoiceDate',
    ])
  })

  it('relabels the date as the purchase date on a receipt', () => {
    const r = selectInboxFields({ documentKind: 'receipt', fields: FIELDS, hasValue: none, showAll: false })
    expect(labelOf(r, 'invoice.invoiceDate')).toBe('Inköpsdatum')
  })

  it('NEVER hides a field that holds a value, even on a receipt', () => {
    // Misclassification, or a hybrid restaurangnota carrying an invoice
    // number: data must never disappear behind a heuristic.
    const r = selectInboxFields({
      documentKind: 'receipt',
      fields: FIELDS,
      hasValue: (k) => k === 'invoice.invoiceNumber',
      showAll: false,
    })
    expect(keys(r)).toContain('invoice.invoiceNumber')
    expect(r.hiddenCount).toBe(4)
  })

  it('showAll restores every field, still relabelled', () => {
    const r = selectInboxFields({ documentKind: 'receipt', fields: FIELDS, hasValue: none, showAll: true })
    expect(keys(r)).toEqual(FIELDS.map((f) => f.key))
    expect(r.hiddenCount).toBe(0)
    expect(labelOf(r, 'invoice.invoiceDate')).toBe('Inköpsdatum')
  })

  it('does not mutate the caller’s field list', () => {
    const copy = FIELDS.map((f) => ({ ...f }))
    selectInboxFields({ documentKind: 'receipt', fields: copy, hasValue: none, showAll: true })
    expect(copy.find((f) => f.key === 'invoice.invoiceDate')?.label).toBe('Fakturadatum')
  })
})
