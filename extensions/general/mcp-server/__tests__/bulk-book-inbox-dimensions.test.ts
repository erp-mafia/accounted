/**
 * gnubok_bulk_book_inbox_items: shared dimensions bag.
 *
 * The bag resolves via the standard resolve-don't-select pass and is staged
 * into the pending-operation params, from which the executor forwards it to
 * bulkBookMatchedInboxItems (covered in
 * lib/transactions/__tests__/categorize-core.bulk.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { eventBus } from '@/lib/events/bus'

const bulkBookInbox = tools.find((t) => t.name === 'gnubok_bulk_book_inbox_items')!

/** Per-table mock capturing insert payloads (same pattern as the payroll
 * staged-tool tests). A single queued entry repeats for subsequent reads. */
function makeCapturingSupabase(byTable: Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>>) {
  const queues = new Map<string, Array<{ data?: unknown; error?: unknown }>>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const inserts: Record<string, unknown[]> = {}
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve({ count: null, ...next })
          }
        }
        return (...callArgs: unknown[]) => {
          if (prop === 'insert') {
            ;(inserts[table] ??= []).push(callArgs[0])
          }
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { inserts, from: vi.fn((table: string) => buildChain(table)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_bulk_book_inbox_items: dimensions', () => {
  it('stages the resolved bag in params and echoes it in the preview', async () => {
    const supabaseMock = makeCapturingSupabase({
      // Resolver: dimensions disabled → free-text passthrough. Also serves
      // the period-status read at staging time.
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [
          { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null },
        ],
      },
      transactions: { data: [{ id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK' }] },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-inbox-dims' }, error: null },
    })

    const result = (await bulkBookInbox.execute(
      {
        item_ids: ['i1'],
        category: 'expense_software',
        dimensions: { '6': 'P001' },
      },
      'company-1',
      'user-1',
      supabaseMock as never,
      { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.dimensions).toEqual({ '6': 'P001' })
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params.dimensions).toEqual({ '6': 'P001' })
  })

  it('stages dimensions: null when no bag is supplied (persisted-optional contract)', async () => {
    const supabaseMock = makeCapturingSupabase({
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [
          { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null },
        ],
      },
      transactions: { data: [{ id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK' }] },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-inbox-nodims' }, error: null },
    })

    const result = (await bulkBookInbox.execute(
      { item_ids: ['i1'], category: 'expense_software' },
      'company-1',
      'user-1',
      supabaseMock as never,
      { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview).not.toHaveProperty('dimensions')
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
    }
    // BulkBookInboxSchema normalizes the persisted null back to undefined at
    // commit time.
    expect(inserted.params.dimensions).toBeNull()
  })
})
