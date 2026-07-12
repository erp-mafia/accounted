import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

/**
 * Regression guard for a reported bug: documents booked directly as a
 * journal entry (created_journal_entry_id set, e.g. via SIE import) kept
 * showing up in gnubok_list_unmatched_documents even though nothing was left
 * to do with them, while gnubok_list_inbox_items(unprocessed_only) already
 * considered them terminal-linked and correctly omitted them. The two tools
 * disagreed because this query only excluded created_supplier_invoice_id and
 * a transactions.document_id match, never created_journal_entry_id.
 *
 * lib/pending-operations/__tests__/inbox-link-status.pg.test.ts already
 * documents the intended contract ("the link column alone drops the row out
 * of the 'needs action' filter (the UI and list_unmatched_documents read
 * it)"); this test locks the query actually doing that.
 */
const tool = tools.find((t) => t.name === 'gnubok_list_unmatched_documents')!

function makeRecordingChain(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(result)
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args })
        return proxy
      }
    },
  }
  const proxy = new Proxy({}, handler)
  return { proxy, calls }
}

describe('gnubok_list_unmatched_documents', () => {
  it('is registered as a read-only paginated tool', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as { properties: Record<string, unknown> }
    expect(schema.properties.items).toBeDefined()
    expect(schema.properties.count).toBeDefined()
  })

  it('describes journal entries as a terminal link, not just bank transactions and supplier invoices', () => {
    expect(tool.description).toMatch(/journal entry/)
  })

  it('excludes inbox rows already booked as a journal entry, not just supplier invoices', async () => {
    const inboxChain = makeRecordingChain({ data: [], error: null })
    const fromMock = vi.fn().mockReturnValue(inboxChain.proxy)
    const supabase = { from: fromMock }

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      items: unknown[]
      count: number
    }

    expect(fromMock).toHaveBeenCalledWith('invoice_inbox_items')
    const isCalls = inboxChain.calls.filter((c) => c.method === 'is')
    expect(isCalls).toContainEqual({ method: 'is', args: ['created_supplier_invoice_id', null] })
    expect(isCalls).toContainEqual({ method: 'is', args: ['created_journal_entry_id', null] })
    expect(result).toEqual({ items: [], count: 0 })
  })

  it('maps extracted_data fields and drops documents already pinned to a transaction', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'inbox-1',
          document_id: 'doc-1',
          source: 'upload',
          email_from: null,
          email_subject: null,
          email_received_at: null,
          created_at: '2026-06-01T00:00:00Z',
          extracted_data: {
            supplier: { name: 'DNB Finans', orgNumber: '5164060161' },
            invoice: { currency: 'SEK', invoiceDate: '2025-08-05', paymentReference: '9581810307' },
            totals: { total: 13428 },
          },
        },
        {
          id: 'inbox-2',
          document_id: 'doc-2',
          source: 'upload',
          email_from: null,
          email_subject: null,
          email_received_at: null,
          created_at: '2026-05-01T00:00:00Z',
          extracted_data: null,
        },
      ],
      error: null,
    })
    // doc-2 is already pinned to a bank transaction; doc-1 is not.
    enqueue({ data: [{ document_id: 'doc-2' }], error: null })

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      items: Array<{ inbox_item_id: string; vendor_name: string | null; amount: number | null }>
      count: number
    }

    expect(result.count).toBe(1)
    expect(result.items[0].inbox_item_id).toBe('inbox-1')
    expect(result.items[0].vendor_name).toBe('DNB Finans')
    expect(result.items[0].amount).toBe(13428)
  })

  it('returns an empty result when the inbox query has nothing pending', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      items: unknown[]
      count: number
    }

    expect(result).toEqual({ items: [], count: 0 })
  })

  it('throws on a database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection refused' } })

    await expect(tool.execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(
      /connection refused/,
    )
  })
})
