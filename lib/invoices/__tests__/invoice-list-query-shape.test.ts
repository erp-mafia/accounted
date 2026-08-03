import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../app/(dashboard)/invoices/page.tsx'),
  'utf8',
)

describe('invoice list query shape', () => {
  it('paginates beyond the PostgREST row cap with a stable total order', () => {
    expect(source).toContain('fetchAllRows<Invoice>')
    expect(source).toContain(".order('invoice_date', { ascending: false })")
    expect(source).toContain(".order('id', { ascending: false })")
    expect(source).toContain('.range(from, to)')
    expect(source).toContain('dedupeBy: (invoice) => invoice.id')
  })
})
