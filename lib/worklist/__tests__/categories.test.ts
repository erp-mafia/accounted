import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countSuggestedMatches,
  countSupplierInvoicesAwaitingApproval,
  countUnbookedTransactions,
  countVerifikatMissingDocument,
  listSuggestedMatches,
} from '../categories'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('countUnbookedTransactions', () => {
  it('returns the head count from transactions', async () => {
    enqueue({ count: 4 })
    await expect(countUnbookedTransactions(supabase, COMPANY)).resolves.toBe(4)
    expect(mockSupabase.from).toHaveBeenCalledWith('transactions')
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countUnbookedTransactions(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countInboxDocuments', () => {
  it('counts only items whose document is still unlinked', async () => {
    enqueue({
      data: [
        { id: 'i1', document_id: 'd1' },
        { id: 'i2', document_id: 'd2' },
        { id: 'i3', document_id: 'd3' },
      ],
    })
    enqueue({ count: 2 }) // one of the three docs is already linked elsewhere
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(2)
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('returns 0 without a document query when no unconsumed items exist', async () => {
    enqueue({ data: [] })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('chunks the document id filter so large inboxes stay under URL limits', async () => {
    // 200 deduped ids → two .in() chunks of 150 + 50, counts summed.
    enqueue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `item-${i}`,
        document_id: `doc-${i}`,
      })),
    })
    enqueue({ count: 140 })
    enqueue({ count: 45 })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(185)
    // 1 inbox query + 2 chunked document queries.
    expect(mockSupabase.from).toHaveBeenCalledTimes(3)
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countVerifikatMissingDocument', () => {
  it('counts posted document-requiring entries with neither document nor exemption', async () => {
    // 6 posted entries: je-1 documented+exempt, je-2 documented, je-3 exempt
    // → je-4, je-5, je-6 missing.
    enqueue({
      data: [
        { id: 'je-1' },
        { id: 'je-2' },
        { id: 'je-3' },
        { id: 'je-4' },
        { id: 'je-5' },
        { id: 'je-6' },
      ],
    })
    enqueue({
      data: [
        { journal_entry_id: 'je-1' },
        { journal_entry_id: 'je-1' }, // second doc on the same entry — still one entry
        { journal_entry_id: 'je-2' },
      ],
    })
    enqueue({
      data: [{ journal_entry_id: 'je-1' }, { journal_entry_id: 'je-3' }],
    })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(3)
  })

  it('ignores documents attached to entries outside the document-requiring set', async () => {
    // The doc on je-99 (e.g. a VAT-settlement entry) must not shrink the count.
    enqueue({ data: [{ id: 'je-1' }] })
    enqueue({ data: [{ journal_entry_id: 'je-99' }] })
    enqueue({ data: [] })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(1)
  })

  it('soft-fails to 0 when a paginated read errors', async () => {
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })

  it('soft-fails to 0 (never a silent partial) when pagination errors mid-stream', async () => {
    // First page of entries is full (1000 = fetchAllRows page size), so a
    // second page is requested and errors. fetchAllRows must throw — the
    // count drops to a logged 0 rather than computing from a truncated set.
    enqueue({
      data: Array.from({ length: 1000 }, (_, i) => ({ id: `je-${i}` })),
    })
    enqueue({ data: [] }) // document_attachments page 1
    enqueue({ data: [] }) // exemptions page 1
    enqueue({ error: { message: 'mid-stream failure' } }) // entries page 2
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('simple head counts', () => {
  it.each([
    ['countSuggestedMatches', countSuggestedMatches, 'transactions'],
    ['countSupplierInvoicesAwaitingApproval', countSupplierInvoicesAwaitingApproval, 'supplier_invoices'],
    ['countOverdueInvoices', countOverdueInvoices, 'invoices'],
    ['countDeadlinesNeedingAction', countDeadlinesNeedingAction, 'deadlines'],
    ['countPendingOperations', countPendingOperations, 'pending_operations'],
  ] as const)('%s returns the count and targets the right table', async (_name, fn, table) => {
    enqueue({ count: 3 })
    await expect(fn(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.from).toHaveBeenCalledWith(table)
  })
})

describe('listSuggestedMatches', () => {
  it('maps invoice and supplier-invoice hints to confirmable rows', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'ICA BANKEN',
          amount: 423,
          currency: 'SEK',
          potential_invoice_id: 'inv-1',
          potential_supplier_invoice_id: null,
        },
        {
          id: 'tx-2',
          date: '2026-05-30',
          description: 'TELIA',
          amount: -549,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-1',
        },
      ],
    })
    enqueue({
      data: [
        { id: 'inv-1', invoice_number: 'F-2026-12', total: 423, customer: { name: 'Kund AB' } },
      ],
    })
    enqueue({
      data: [
        {
          id: 'sinv-1',
          supplier_invoice_number: 'TEL-99',
          total: 549,
          supplier: { name: 'Telia AB' },
        },
      ],
    })

    const matches = await listSuggestedMatches(supabase, COMPANY)
    expect(matches).toEqual([
      {
        transaction_id: 'tx-1',
        transaction_date: '2026-06-01',
        transaction_description: 'ICA BANKEN',
        transaction_amount: 423,
        transaction_currency: 'SEK',
        kind: 'invoice',
        candidate_id: 'inv-1',
        candidate_number: 'F-2026-12',
        counterparty_name: 'Kund AB',
        candidate_total: 423,
      },
      {
        transaction_id: 'tx-2',
        transaction_date: '2026-05-30',
        transaction_description: 'TELIA',
        transaction_amount: -549,
        transaction_currency: 'SEK',
        kind: 'supplier_invoice',
        candidate_id: 'sinv-1',
        candidate_number: 'TEL-99',
        counterparty_name: 'Telia AB',
        candidate_total: 549,
      },
    ])
  })

  it('drops rows whose hinted candidate no longer exists', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'X',
          amount: 100,
          currency: 'SEK',
          potential_invoice_id: 'inv-gone',
          potential_supplier_invoice_id: null,
        },
      ],
    })
    enqueue({ data: [] }) // invoice lookup finds nothing (deleted candidate)
    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
  })

  it('returns [] on transaction query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
  })
})
