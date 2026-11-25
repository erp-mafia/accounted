/**
 * The supplier invoice list search guard catches the search written by hand,
 * and leaves the lines that only name the same fields.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/supplier-invoice-list-search.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('supplier-invoice-list-search', () => {
  it.each([
    "      (inv.supplier_invoice_number ?? '').toLowerCase().includes(query) ||",
    "      (inv.payment_reference ?? '').toLowerCase().includes(query)",
    '  return invoice.payment_reference?.toLowerCase().includes(term)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    "  `${inv.supplier?.name ?? ''} ${inv.supplier_invoice_number ?? ''}`.trim(),",
    '  const matchesSearch = supplierInvoiceMatchesSearch(inv, searchTerm) !== null',
    '  if (normalizeOcrReference(row.payment_reference) === referenceDigits) return true',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
