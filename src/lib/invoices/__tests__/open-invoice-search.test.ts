import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  PICKER_LIMIT,
  pickerSearchPattern,
  searchOpenInvoices,
  searchOpenSupplierInvoices,
} from '../open-invoice-search'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

interface Row {
  id: string
  invoice_date: string | null
}

const row = (id: string, invoice_date: string): Row => ({ id, invoice_date })

beforeEach(() => {
  reset()
})

describe('pickerSearchPattern', () => {
  it('wraps a trimmed term and escapes LIKE wildcards', () => {
    expect(pickerSearchPattern('  50% AB_x ')).toBe('%50\\% AB\\_x%')
  })

  it('returns null for a blank term', () => {
    expect(pickerSearchPattern('   ')).toBeNull()
  })
})

describe('searchOpenInvoices', () => {
  it('without a term loads the newest open invoices and filters nothing by text', async () => {
    enqueue({ data: [row('a', '2026-10-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', '')

    expect(rows.map((r) => r.id)).toEqual(['a'])
    expect(findCalls('invoices', 'ilike')).toEqual([])
    expect(findCalls('invoices', 'limit')).toEqual([[PICKER_LIMIT]])
    expect(findCalls('invoices', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['document_type', 'invoice'],
      ]),
    )
    expect(findCalls('invoices', 'gt')).toEqual([['remaining_amount', 0]])
  })

  it('sends a search term to the database, so an open invoice older than the newest 200 is found', async () => {
    // The old picker filtered the newest 200 rows in the browser: an open
    // invoice from 2024 behind 200 newer ones could never be found.
    enqueue({ data: [row('old-by-number', '2024-03-01')] })
    enqueue({ data: [row('new-by-name', '2026-09-30'), row('old-by-number', '2024-03-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', '1011')

    expect(findCalls('invoices', 'ilike')).toEqual([
      ['invoice_number', '%1011%'],
      ['customer.name', '%1011%'],
    ])
    expect(findCalls('invoices', 'select')).toEqual([
      ['*, customer:customers(*)'],
      ['*, customer:customers!inner(*)'],
    ])
    // Merged newest first, each invoice once.
    expect(rows.map((r) => r.id)).toEqual(['new-by-name', 'old-by-number'])
  })

  it('keeps the merged result at the picker limit', async () => {
    const many = Array.from({ length: PICKER_LIMIT }, (_, i) =>
      row(`n${String(i).padStart(3, '0')}`, '2026-01-01'),
    )
    enqueue({ data: many })
    enqueue({ data: [row('extra', '2025-01-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', 'ab')

    expect(rows).toHaveLength(PICKER_LIMIT)
    expect(rows.some((r) => r.id === 'extra')).toBe(false)
  })

  it('throws on a database error instead of showing an empty list', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(searchOpenInvoices<Row>(client, 'company-1', '')).rejects.toThrow('boom')
  })
})

describe('searchOpenSupplierInvoices', () => {
  it('matches the supplier invoice number and the supplier name in the database', async () => {
    enqueue({ data: [row('si-1', '2025-02-01')] })
    enqueue({ data: [row('si-2', '2025-05-01')] })

    const rows = await searchOpenSupplierInvoices<Row>(client, 'company-1', 'Telia')

    expect(findCalls('supplier_invoices', 'ilike')).toEqual([
      ['supplier_invoice_number', '%Telia%'],
      ['supplier.name', '%Telia%'],
    ])
    expect(findCalls('supplier_invoices', 'in')).toEqual([
      ['status', ['approved', 'overdue', 'partially_paid']],
      ['status', ['approved', 'overdue', 'partially_paid']],
    ])
    expect(rows.map((r) => r.id)).toEqual(['si-2', 'si-1'])
  })
})
