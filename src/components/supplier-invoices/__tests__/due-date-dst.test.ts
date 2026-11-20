/**
 * accounted#58: the supplier invoice's terms-based förfallodatum parsed the
 * invoice date as UTC midnight, shifted it with the local setDate and read it
 * back as UTC. In Swedish time that lost a day across the March DST change
 * (2026-03-10 + 30 days gave 2026-04-08). The webshop "already booked" and
 * bank "match voucher" search windows had the same shape. All three now use
 * the shared pure calendar-date helpers on addDaysIso. Components are not
 * rendered in this suite (vitest runs in `node`), so the wiring is pinned on
 * the source.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { addDaysIso } from '@/lib/dates/iso'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

const SOURCES = [
  '../NewSupplierInvoiceForm.tsx',
  '../../orders/MarkOrderBookedDialog.tsx',
  '../../transactions/MatchVoucherDialog.tsx',
]

describe('due date and search windows across DST', () => {
  it('adds payment terms as calendar days across both DST changes', () => {
    expect(addDaysIso('2026-03-10', 30)).toBe('2026-04-09')
    expect(addDaysIso('2026-10-20', 30)).toBe('2026-11-19')
    expect(addDaysIso('2026-04-15', -45)).toBe('2026-03-01')
  })

  it('every door shifts dates on addDaysIso, never a local setDate', () => {
    for (const rel of SOURCES) {
      const src = read(rel)
      expect(src, rel).toContain("from '@/lib/dates/iso'")
      expect(src, rel).toMatch(/\b(?:addDaysIso|invoiceDueDate)\(/)
      expect(src, rel).not.toMatch(/\.setDate\(/)
    }
  })
})
