import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../NewInvoiceDialog.tsx'),
  'utf8',
)

/**
 * Regression pin for the copy-invoice flow, same class as the article-delete
 * phantom column fixed in #1188. `invoice_items` has NO `company_id` column:
 * it is scoped through its parent invoice. Filtering on it makes PostgREST
 * answer 42703, fetchAllRows rethrows, and the dialog renders the
 * "kunde inte laddas" panel for EVERY company.
 *
 * This is a component, and the repo does not render components in tests, so
 * there is no behavioral harness that can observe the failing request: pin the
 * query shape in the source instead.
 */
describe('NewInvoiceDialog copy-source query shape', () => {
  const itemsQuery = (() => {
    const start = SRC.indexOf("from('invoice_items')")
    expect(start).toBeGreaterThan(-1)
    return SRC.slice(start, SRC.indexOf('.range(from, to)', start))
  })()

  it('must not filter invoice_items by company_id (column does not exist)', () => {
    expect(itemsQuery).not.toContain("eq('company_id'")
  })

  it('still scopes the items to the parent invoice', () => {
    expect(itemsQuery).toContain("eq('invoice_id', copyFromId)")
  })

  it('keeps the company filter on the parent invoices lookup (tenancy)', () => {
    const start = SRC.indexOf("from('invoices')")
    expect(start).toBeGreaterThan(-1)
    const invoiceQuery = SRC.slice(start, SRC.indexOf('.single()', start))
    expect(invoiceQuery).toContain("eq('id', copyFromId)")
    expect(invoiceQuery).toContain("eq('company_id', company.id)")
  })
})
