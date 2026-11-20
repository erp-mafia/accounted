import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { INTAKE_SOURCE_IDS } from '@/lib/intake/sources'
import { tools } from '../server'

/**
 * intake_source on the MCP inbox reads: the canonical door
 * (lib/intake/sources.ts) next to the legacy `source`, which says 'upload'
 * for the dashboard, MCP and whatever Arkiv queued alike.
 */
const list = tools.find((candidate) => candidate.name === 'gnubok_list_inbox_items')!
const get = tools.find((candidate) => candidate.name === 'gnubok_get_inbox_item')!

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'received',
    source: 'upload',
    created_at: '2026-10-01T12:00:00Z',
    extracted_data: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: null,
    email_subject: null,
    error_message: null,
    document_attachments: null,
    intake_stamp: null,
    intake_channel: null,
    ...overrides,
  }
}

describe('gnubok_list_inbox_items intake_source', () => {
  it('selects the stamp, the channel and the document upload_source, never the whole channel_context', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [], error: null })
    await list.execute({}, 'company-1', 'user-1', supabase as never)
    const select = findCall('invoice_inbox_items', 'select')?.[0] as string
    expect(select).toContain('upload_source')
    expect(select).toContain('intake_stamp:channel_context->>intake_source')
    expect(select).toContain('intake_channel:channel_context->>channel')
    expect(select).not.toMatch(/(^|[\s,])channel_context(,|\s|$)/)
  })

  it('names the door of each row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'a', source: 'email' }),
        row({ id: 'b', source: 'mail_hunt', intake_channel: 'mail_hunt' }),
        row({ id: 'c', source: 'upload', document_attachments: { file_name: 'k.pdf', journal_entry_id: null, upload_source: 'file_upload' } }),
        row({ id: 'd', source: 'upload', document_attachments: { file_name: 'k.pdf', journal_entry_id: null, upload_source: 'api' } }),
        row({ id: 'e', source: 'upload', intake_stamp: 'partner_api', document_attachments: { file_name: 'k.pdf', journal_entry_id: null, upload_source: 'api' } }),
        row({ id: 'f', source: 'whatsapp', intake_channel: 'whatsapp' }),
        row({ id: 'g', source: 'peppol' }),
      ],
      error: null,
    })
    const result = (await list.execute({}, 'company-1', 'user-1', supabase as never)) as {
      items: Array<{ id: string; source: string; intake_source: string | null }>
    }
    expect(result.items.map((i) => [i.id, i.source, i.intake_source])).toEqual([
      ['a', 'email', 'intake_email'],
      ['b', 'mail_hunt', 'mailbox'],
      ['c', 'upload', 'upload'],
      ['d', 'upload', 'mcp'],
      ['e', 'upload', 'partner_api'],
      ['f', 'whatsapp', 'whatsapp'],
      ['g', 'peppol', 'peppol'],
    ])
    for (const i of result.items) expect(INTAKE_SOURCE_IDS).toContain(i.intake_source)
  })
})

describe('gnubok_get_inbox_item intake_source', () => {
  it('adds intake_source to the row and keeps every column it returned', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    const item = {
      ...row(),
      channel_context: { intake_source: 'partner_api' },
      document_attachments: { id: 'doc-1', file_name: 'k.pdf', mime_type: 'application/pdf', file_size_bytes: 10, created_at: '2026-10-01T12:00:00Z', upload_source: 'api' },
    }
    delete (item as Record<string, unknown>).intake_stamp
    delete (item as Record<string, unknown>).intake_channel
    enqueue({ data: item, error: null })
    const result = (await get.execute({ inbox_item_id: item.id }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>
    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('upload_source')
    // Every column it returned, plus intake_source (other fields may sit beside them).
    expect(result).toMatchObject({ ...item, intake_source: 'partner_api', reading: expect.objectContaining({ inbox_item_id: item.id }) })
  })

  it("reads an unstamped 'upload' item over an 'api' document as mcp, and a mail-hunt item by its channel", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...row(), channel_context: null, document_attachments: { id: 'd', file_name: 'k.pdf', upload_source: 'api' } }, error: null })
    expect(await get.execute({ inbox_item_id: 'x' }, 'company-1', 'user-1', supabase as never)).toMatchObject({ intake_source: 'mcp' })
    enqueue({ data: { ...row({ source: 'mail_hunt' }), channel_context: { channel: 'mail_hunt', mail_provider: 'gmail' } }, error: null })
    expect(await get.execute({ inbox_item_id: 'x' }, 'company-1', 'user-1', supabase as never)).toMatchObject({ intake_source: 'mailbox' })
  })

  it('answers the same not-found error as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    await expect(get.execute({ inbox_item_id: 'x' }, 'company-1', 'user-1', supabase as never)).rejects.toThrow('Inbox item not found')
  })
})
