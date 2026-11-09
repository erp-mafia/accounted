import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResponsiveTable } from '@/components/ui/responsive-table'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const h = React.createElement

describe('responsive table headers', () => {
  it('keeps header labels, links and spanning totals in server-rendered markup', () => {
    const html = renderToStaticMarkup(h(ResponsiveTable, { primaryColumn: 2, children:
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Verifikat'), h('th', null, h('span', null, 'Beskrivning')), h('th', null, 'Saldo'))),
        h('tbody', null, h('tr', null, h('td', null, h('a', { href: '/bookkeeping/example' }, 'V93')), h('td', null, 'Payment'), h('td', null, '100'))),
        h('tfoot', null, h('tr', null, h('td', { colSpan: 2 }, 'Summa'), h('td', null, '100')))),
    }))
    expect(html).toContain('--table-column-2:&quot;Beskrivning&quot;')
    expect(html).toContain('--table-last-column-1:&quot;Saldo&quot;')
    expect(html).toContain('data-primary-column="2"')
    expect(html).toContain('<a href="/bookkeeping/example">V93</a>')
    expect(html).toContain('colSpan="2"')
  })
  it('reads column labels supplied to sortable header components', () => {
    function SortableHead({ label }: { label: string }) { return h('th', null, h('button', null, label)) }
    const html = renderToStaticMarkup(h(ResponsiveTable, { children: h('table', null, h('thead', null, h('tr', null, h(SortableHead, { label: 'Belopp' })))) }))
    expect(html).toContain('--table-column-1:&quot;Belopp&quot;')
  })
  it('supports shared table primitives and accessible labels on icon columns', () => {
    const html = renderToStaticMarkup(h(Table, null,
      h(TableHeader, null, h(TableRow, null,
        h(TableHead, null, h('button', { 'aria-label': 'Select rows' }, h('span'))), h(TableHead, null, 'Amount'))),
      h(TableBody, null, h(TableRow, null, h(TableCell, null, 'Selected'), h(TableCell, null, '100')))))
    expect(html).toContain('--table-column-1:&quot;Select rows&quot;')
    expect(html).toContain('--table-column-2:&quot;Amount&quot;')
    expect(html.match(/class="responsive-table/g)).toHaveLength(1)
  })
})
