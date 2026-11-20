/**
 * The supplier to-pay guard catches the three readings that drifted, and
 * leaves the reads that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/supplier-invoice-to-pay.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('supplier-invoice-to-pay', () => {
  it.each([
    "query = query.in('status', [...payableSupplierInvoiceStatuses(accountingMethod)]).eq('auto_debit', false)",
    'if (!PAYABLE.has(invoice.status) || invoice.auto_debit) return false',
    'return PAYABLE.has(invoice.status) && !invoice.auto_debit && marker !== null',
    'if (companyAttestsSupplierInvoices(accountingMethod) && !invoice.approved_at) return false',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'return payableSupplierInvoiceStatuses(accountingMethod).includes(invoice.status)',
    "query = query.in('status', [...PAYABLE_SUPPLIER_INVOICE_STATUSES]).eq('auto_debit', false)",
    'if (!PAYABLE.has(invoice.status)) return false',
    'if (!companyAttestsSupplierInvoices(accountingMethod)) return false',
    'return waitsToBePaid(invoice, { atTheBank, waitsForAttest })',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
