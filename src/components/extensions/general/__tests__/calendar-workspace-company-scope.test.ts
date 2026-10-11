import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CALENDAR = fs.readFileSync(path.resolve(__dirname, '../CalendarWorkspace.tsx'), 'utf8')
const BULK_BOOK = fs.readFileSync(
  path.resolve(__dirname, '../../../transactions/BulkBookDialog.tsx'),
  'utf8',
)

/**
 * Regression pin for the calendar workspace and the bulk-book template list.
 *
 * Both read straight from the browser and leaned on RLS for scoping, but the
 * SELECT policies are membership-wide (user_company_ids()), so a user in two
 * companies saw the other company's invoices, deadlines, customers and
 * templates merged into the active one. The calendar's deadline insert also
 * omitted company_id, which the INSERT policy (company_id =
 * current_active_company_id()) refuses, so creating a deadline always failed.
 *
 * Components are not rendered in tests, so pin the data paths in the source:
 * company-scoped API routes and reference-data hooks, never bare table reads.
 */
describe('CalendarWorkspace data paths', () => {
  it('reads and writes deadlines only through /api/deadlines', () => {
    expect(CALENDAR).not.toContain("from('deadlines')")
    expect(CALENDAR).toContain("fetch('/api/deadlines'")
    expect(CALENDAR).toContain('/complete`')
  })

  it('reads customers through the company-scoped reference hook', () => {
    expect(CALENDAR).not.toContain("from('customers')")
    expect(CALENDAR).toContain('useCustomers()')
  })

  it('filters the invoice read to the active company', () => {
    const start = CALENDAR.indexOf("from('invoices')")
    expect(start).toBeGreaterThan(-1)
    const invoiceQuery = CALENDAR.slice(start, CALENDAR.indexOf('.range(', start))
    expect(invoiceQuery).toContain(".eq('company_id', companyId)")
  })
})

describe('BulkBookDialog template list', () => {
  it('uses the company-scoped booking template hook, not a bare library read', () => {
    expect(BULK_BOOK).not.toContain("from('booking_template_library')")
    expect(BULK_BOOK).toContain('useBookingTemplates()')
  })
})
