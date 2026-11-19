/**
 * gnubok_set_inbox_extracted_data mirrors the agent's reading onto the
 * document row too, best effort: the tool answers the same whatever the
 * mirror says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mirror = vi.hoisted(() => vi.fn())
vi.mock('@/lib/documents/reading-correction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/reading-correction')>()
  return { ...actual, mirrorCorrectedReadingToDocument: mirror }
})

import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_set_inbox_extracted_data')!

const payload = {
  supplier: { name: 'Anthropic Inc.', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
  invoice: { invoiceNumber: 'A-1', invoiceDate: '2026-05-12', dueDate: '2026-06-11', paymentReference: null, currency: 'USD' },
  lineItems: [{ description: 'API', quantity: 1, unitPrice: 50, lineTotal: 50, vatRate: 0, accountSuggestion: null }],
  totals: { subtotal: 50, vatAmount: 0, total: 50 },
  vatBreakdown: [{ rate: 0, base: 50, amount: 0 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  mirror.mockResolvedValue('mirrored')
})

async function run(item: Record<string, unknown>) {
  const { supabase, enqueue, findCall } = createQueuedMockSupabase()
  enqueue({ data: item, error: null })
  enqueue({ data: null, error: null }) // supplier match by name: none
  enqueue({ data: null, error: null }) // inbox item update
  const result = await tool.execute({ inbox_item_id: 'inbox-1', extracted_data: payload }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
  return { result: result as { inbox_item_id: string; extracted_data: Record<string, unknown> }, findCall }
}

describe('gnubok_set_inbox_extracted_data: the document follows the reading', () => {
  it("mirrors the agent's reading onto the item's document", async () => {
    const { result, findCall } = await run({ id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: null, document_id: 'doc-1' })
    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('document_id')
    expect(mirror).toHaveBeenCalledWith({ documentId: 'doc-1', companyId: 'company-1', reading: result.extracted_data })
    expect(result.extracted_data).toMatchObject({ confidence: 0.95 })
  })

  it.each(['locked', 'failed'])('answers the same when the mirror answers %s', async (answer) => {
    mirror.mockResolvedValue(answer)
    const { result } = await run({ id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: null, document_id: 'doc-1' })
    expect(result.inbox_item_id).toBe('inbox-1')
  })

  it('never mirrors for an item already converted to a supplier invoice', async () => {
    await expect(run({ id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: 'si-1', document_id: 'doc-1' })).rejects.toThrow(/already linked/)
    expect(mirror).not.toHaveBeenCalled()
  })
})
