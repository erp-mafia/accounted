import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((candidate) => candidate.name === 'gnubok_list_inbox_items')!

describe('gnubok_list_inbox_items', () => {
  it('advertises file_name in its item output contract', () => {
    const schema = tool.outputSchema as {
      properties: {
        items: {
          items: {
            properties: Record<string, unknown>
            required: string[]
          }
        }
      }
    }

    expect(schema.properties.items.items.properties.file_name).toEqual({
      type: ['string', 'null'],
      description: 'Original document file name, or null when the inbox item has no document',
    })
    expect(schema.properties.items.items.required).toContain('file_name')
  })

  it('joins the document and returns its file_name on each list row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'inbox-1',
          status: 'received',
          source: 'upload',
          created_at: '2026-07-31T12:00:00Z',
          extracted_data: null,
          matched_supplier_id: null,
          matched_transaction_id: null,
          created_supplier_invoice_id: null,
          created_journal_entry_id: null,
          email_from: null,
          email_subject: null,
          error_message: null,
          document_attachments: [{ file_name: 'dooer-export-2026-07.pdf' }],
        },
        {
          id: 'inbox-2',
          status: 'received',
          source: 'email',
          created_at: '2026-07-30T12:00:00Z',
          extracted_data: null,
          matched_supplier_id: null,
          matched_transaction_id: null,
          created_supplier_invoice_id: null,
          created_journal_entry_id: null,
          email_from: null,
          email_subject: null,
          error_message: null,
          document_attachments: [],
        },
      ],
      error: null,
    })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      items: Array<{ file_name: string | null }>
      count: number
    }

    const select = findCall('invoice_inbox_items', 'select')?.[0]
    expect(select).toContain('document_attachments(file_name)')
    expect(result.items.map((item) => item.file_name)).toEqual([
      'dooer-export-2026-07.pdf',
      null,
    ])
    expect(result.count).toBe(2)
  })
})
