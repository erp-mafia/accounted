import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PAGE_SRC = fs.readFileSync(path.resolve(__dirname, '../../../app/(dashboard)/bokfor/page.tsx'), 'utf8')

describe('/bokfor', () => {
  // Stepping to the next row keeps the route and changes the query, and
  // React keeps a component's state across that: without a key per row, the
  // last row's filled-in suggestion lines would open on the next row.
  it('mounts a fresh screen per row', () => {
    expect(PAGE_SRC).toContain('key={`${subject.transactionId}:${subject.account ?? \'\'}:${found?.inbox_item_id ?? \'\'}:${subject.picked ? \'vald\' : \'\'}`}')
    expect(PAGE_SRC).toContain('<BookingScreen key="voucher"')
    expect(PAGE_SRC.match(/<BookingScreen\b/g)?.length).toBe(2)
  })
})
