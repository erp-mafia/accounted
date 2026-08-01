import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((candidate) => candidate.name === 'gnubok_list_inbox_items')!

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

function makeInboxItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'received',
    source: 'upload',
    created_at: '2026-07-01T12:00:00Z',
    extracted_data: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: null,
    email_subject: null,
    error_message: null,
    document_attachments: [],
    ...overrides,
  }
}

function makeRecordingChain(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => void) => resolve(result)
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

  it('advertises optional cursor pagination without changing required output fields', () => {
    const inputSchema = tool.inputSchema as { properties: Record<string, unknown> }
    const outputSchema = tool.outputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }

    expect(inputSchema.properties.cursor).toBeDefined()
    expect(outputSchema.properties.next_cursor).toBeDefined()
    expect(outputSchema.required).toEqual(['items', 'count'])
  })

  it('joins the document and returns its file_name on each list row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        makeInboxItem({
          id: 'inbox-1',
          created_at: '2026-07-31T12:00:00Z',
          document_attachments: [{ file_name: 'dooer-export-2026-07.pdf' }],
        }),
        makeInboxItem({
          id: 'inbox-2',
          source: 'email',
          created_at: '2026-07-30T12:00:00Z',
        }),
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

  it('preserves the first-page response when there are no more items', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [makeInboxItem()], error: null })

    const result = await tool.execute({}, 'company-1', 'user-1', supabase as never)

    expect(result).toMatchObject({
      count: 1,
      items: [{ id: '11111111-1111-4111-8111-111111111111', created_at: '2026-07-01T12:00:00Z' }],
    })
    expect(result).not.toHaveProperty('next_cursor')
  })

  it('returns a composite cursor for a full page', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        makeInboxItem({ id: '22222222-2222-4222-8222-222222222222', created_at: '2026-07-02T12:00:00Z' }),
        makeInboxItem({ id: '11111111-1111-4111-8111-111111111111', created_at: '2026-07-01T12:00:00Z' }),
      ],
      error: null,
    })

    const result = await tool.execute({ limit: 2 }, 'company-1', 'user-1', supabase as never)

    expect(result).toMatchObject({
      count: 2,
      next_cursor: '2026-07-01T12:00:00Z__11111111-1111-4111-8111-111111111111',
    })
  })

  it('uses stable keyset ordering and applies a composite cursor exclusively', async () => {
    const query = makeRecordingChain({ data: [], error: null })
    const supabase = { from: vi.fn().mockReturnValue(query.proxy) }

    await tool.execute(
      { cursor: '2026-07-01T12:00:00Z__11111111-1111-4111-8111-111111111111' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(query.calls.filter((call) => call.method === 'order')).toEqual([
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
    ])
    expect(query.calls).toContainEqual({
      method: 'or',
      args: [
        'created_at.lt.2026-07-01T12:00:00Z,and(created_at.eq.2026-07-01T12:00:00Z,id.lt.11111111-1111-4111-8111-111111111111)',
      ],
    })
  })

  it.each([
    'not-a-timestamp',
    '2026-07-01T12:00:00Z__11111111-1111-4111-8111-111111111111,created_at.gt.1900-01-01',
  ])('rejects a malformed cursor before querying the database: %s', async (cursor) => {
    const supabase = { from: vi.fn() }

    await expect(
      tool.execute({ cursor }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Invalid cursor/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('advances a full unprocessed scan window even when every row is processed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = Array.from({ length: 200 }, (_, index) =>
      makeInboxItem({
        id: `00000000-0000-4000-8000-${String(200 - index).padStart(12, '0')}`,
        created_at: `2026-07-01T11:${String(59 - (index % 60)).padStart(2, '0')}:00Z`,
        matched_transaction_id: `transaction-${index}`,
      }),
    )
    enqueue({ data: rows, error: null })

    const result = await tool.execute(
      { unprocessed_only: true },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(result).toEqual({
      items: [],
      count: 0,
      next_cursor: `${rows[199].created_at}__${rows[199].id}`,
    })
  })

  it('supports the legacy timestamp-only cursor form', async () => {
    const query = makeRecordingChain({ data: [], error: null })
    const supabase = { from: vi.fn().mockReturnValue(query.proxy) }

    await tool.execute(
      { cursor: '2026-07-01T12:00:00Z' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(query.calls).toContainEqual({
      method: 'lt',
      args: ['created_at', '2026-07-01T12:00:00Z'],
    })
  })
})
