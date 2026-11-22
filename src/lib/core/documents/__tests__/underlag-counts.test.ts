import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { countUnderlagForJournalEntries, UNDERLAG_COUNTS_CHUNK } from '../underlag-counts'

/**
 * The verifikat list now asks for a whole page's counts at once (up to 1,000
 * rows under "Alla"): the reads go out in chunks small enough for the .or()
 * filter, and the chunks merge into one answer. What counts is covered
 * through the counts route (app/api/documents/counts/__tests__).
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('countUnderlagForJournalEntries', () => {
  it('reads in chunks and merges them into one answer', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => uuid(i))
    const { supabase, findCalls } = createTableMockSupabase({
      // One direct attachment per asked entry.
      document_attachments: (chain) => {
        const asked = (chain.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
        return { data: asked.map((id) => ({ id: `doc-${id}`, journal_entry_id: id })) }
      },
      supplier_invoices: { data: [] },
      supplier_invoice_payments: { data: [] },
      // The first asked entry of each chunk is also on a customer invoice.
      invoices: (chain) => {
        const asked = (chain.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
        const range = chain.find((c) => c.method === 'range')?.args[0] as number | undefined
        return { data: range ? [] : [{ id: `inv-${asked[0]}`, journal_entry_id: asked[0] }] }
      },
      invoice_payments: { data: [] },
      // Every tenth asked entry is marked "Inget underlag krävs"; one row for
      // an entry nobody asked about must not leak into the answer.
      journal_entry_no_doc_required: (chain) => {
        const asked = (chain.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
        return {
          data: [
            ...asked.filter((_, i) => i % 10 === 0).map((id) => ({ journal_entry_id: id, reason: 'Bankavgift' })),
            { journal_entry_id: uuid(999), reason: null },
          ],
        }
      },
    })

    const result = await countUnderlagForJournalEntries(supabase as unknown as SupabaseClient, 'company-1', ids)

    const reads = findCalls('document_attachments', 'in').map((args) => (args[1] as string[]).length)
    expect(reads).toEqual([UNDERLAG_COUNTS_CHUNK, UNDERLAG_COUNTS_CHUNK, 20])
    expect(Object.keys(result.counts)).toHaveLength(120)
    expect(result.counts[uuid(119)]).toBe(1)
    expect(Object.keys(result.invoice_references).sort()).toEqual([uuid(0), uuid(50), uuid(100)])
    // Only the asked rows' exemptions, read per chunk with the counts (never
    // the company's whole exemption list).
    expect(findCalls('journal_entry_no_doc_required', 'in').map((args) => (args[1] as string[]).length)).toEqual([
      UNDERLAG_COUNTS_CHUNK,
      UNDERLAG_COUNTS_CHUNK,
      20,
    ])
    expect(Object.keys(result.no_doc_required)).toHaveLength(12)
    expect(result.no_doc_required[uuid(10)]).toBe('Bankavgift')
    expect(result.no_doc_required[uuid(999)]).toBeUndefined()
  })

  it('reads nothing for no ids', async () => {
    const { supabase, findCalls } = createTableMockSupabase()
    expect(await countUnderlagForJournalEntries(supabase as unknown as SupabaseClient, 'company-1', [])).toEqual({
      counts: {},
      invoice_references: {},
      no_doc_required: {},
    })
    expect(findCalls('document_attachments', 'in')).toEqual([])
  })

  it('throws the first read error', async () => {
    const { supabase } = createTableMockSupabase({
      document_attachments: { data: null, error: { message: 'boom' } },
      supplier_invoices: { data: [] },
      supplier_invoice_payments: { data: [] },
      journal_entry_no_doc_required: { data: [] },
    })
    await expect(
      countUnderlagForJournalEntries(supabase as unknown as SupabaseClient, 'company-1', [uuid(1)]),
    ).rejects.toMatchObject({ message: 'boom' })
  })
})
