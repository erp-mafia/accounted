import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Layout guards for the sales and purchasing pages (UI scan t1108 U2). Each
 * one is a phone or narrow-panel defect that rendered: a page that scrolled
 * sideways, actions that ran over the title, a table wider than its panel.
 */
const root = path.resolve(__dirname, '../../../')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('sales and purchasing layout', () => {
  it('orders table bleeds exactly the panel padding (16px phone, 24px desktop)', () => {
    const src = read('app/(dashboard)/orders/page.tsx')
    expect(src).toContain('-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6')
    expect(src).not.toMatch(/-mx-5|md:-mx-8/)
  })

  it.each([
    'app/(dashboard)/customers/[id]/page.tsx',
    'app/(dashboard)/suppliers/[id]/page.tsx',
    'app/(dashboard)/supplier-invoices/[id]/page.tsx',
    'app/(dashboard)/sales-orders/[id]/page.tsx',
    'app/(dashboard)/articles/[id]/page.tsx',
    'app/(dashboard)/invoices/[id]/page.tsx',
  ])('%s top bar wraps its actions on a phone', (rel) => {
    expect(read(rel)).toContain('className="page-header page-header-wrap ')
  })

  it('supplier invoice lines scroll inside their section from md', () => {
    const src = read('app/(dashboard)/supplier-invoices/[id]/page.tsx')
    expect(src).toContain('<div className="hidden overflow-x-auto md:block">')
  })

  it('counterparty open items truncate instead of widening the slide-over', () => {
    const src = read('components/parties/CounterpartyOpenItems.tsx')
    expect(src).not.toContain('${VTD_CLASS} truncate`')
    expect(src.match(/w-full max-w-0 truncate/g)?.length).toBe(3)
  })
})
