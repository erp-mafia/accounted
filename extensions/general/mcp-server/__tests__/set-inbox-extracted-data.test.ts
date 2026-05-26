import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

const tool = tools.find((t) => t.name === 'gnubok_set_inbox_extracted_data')!

beforeEach(() => {
  vi.clearAllMocks()
})

function validPayload() {
  return {
    supplier: {
      name: 'Anthropic Inc.',
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: 'A-2026-0001',
      invoiceDate: '2026-05-12',
      dueDate: '2026-06-11',
      paymentReference: null,
      currency: 'USD',
    },
    lineItems: [
      {
        description: 'Claude API usage',
        quantity: 1,
        unitPrice: 50,
        lineTotal: 50,
        vatRate: 0,
        accountSuggestion: null,
      },
    ],
    totals: { subtotal: 50, vatAmount: 0, total: 50 },
    vatBreakdown: [{ rate: 0, base: 50, amount: 0 }],
  }
}

describe('gnubok_set_inbox_extracted_data — registration', () => {
  it('is registered with the right scope', () => {
    expect(tool).toBeDefined()
    expect(TOOL_SCOPE_MAP['gnubok_set_inbox_extracted_data']).toBe('suppliers:write')
  })

  it('has additionalProperties: false on the top-level inputSchema', () => {
    expect((tool.inputSchema as Record<string, unknown>).additionalProperties).toBe(false)
  })
})

describe('gnubok_set_inbox_extracted_data — happy path', () => {
  it('validates the payload, fetches the item, matches supplier, and updates', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // fetch inbox item — must include company_id so the defense-in-depth
    // tenant check passes.
    enqueue({
      data: { id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: null },
      error: null,
    })
    // supplier match by orgNumber — payload has none, skipped
    // supplier match by name (ILIKE) — found
    enqueue({ data: { id: 'sup-1' }, error: null })
    // update inbox_items
    enqueue({ data: null, error: null })

    const result = (await tool.execute(
      { inbox_item_id: 'inbox-1', extracted_data: validPayload() },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { inbox_item_id: string; matched_supplier_id: string | null; extracted_data: { confidence: number } }

    expect(result.inbox_item_id).toBe('inbox-1')
    expect(result.matched_supplier_id).toBe('sup-1')
    // BYO data is marked confidence 0.95 (vs 1.0 for AI-perfect parse) so
    // downstream provenance is distinguishable.
    expect(result.extracted_data.confidence).toBe(0.95)
  })
})

describe('gnubok_set_inbox_extracted_data — validation & guards', () => {
  it('rejects malformed extracted_data with a Zod error', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute(
        { inbox_item_id: 'inbox-1', extracted_data: { supplier: 'not-an-object' } },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow()
  })

  it('throws when the inbox item does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    await expect(
      tool.execute(
        { inbox_item_id: 'missing', extracted_data: validPayload() },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/not found/i)
  })

  it('refuses to overwrite when the item already created a supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: 'sinv-1' },
      error: null,
    })
    await expect(
      tool.execute(
        { inbox_item_id: 'inbox-1', extracted_data: validPayload() },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/already linked/i)
  })

  it('rejects when the fetched row belongs to a different company (defense-in-depth)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The .eq('company_id', companyId) on the SELECT should already prevent
    // this in practice, but the explicit assert catches any future query
    // change that bypasses the where-clause (V4.5.1).
    enqueue({
      data: { id: 'inbox-1', company_id: 'company-other', created_supplier_invoice_id: null },
      error: null,
    })
    await expect(
      tool.execute(
        { inbox_item_id: 'inbox-1', extracted_data: validPayload() },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/different company/i)
  })

  it('requires inbox_item_id', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute(
        { inbox_item_id: '', extracted_data: validPayload() },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/inbox_item_id/i)
  })
})
