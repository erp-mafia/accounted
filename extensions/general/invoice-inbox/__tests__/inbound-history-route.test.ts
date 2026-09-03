import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

const route = invoiceInboxExtension.apiRoutes!.find(
  (r) => r.method === 'GET' && r.path === '/inbound-history'
)!

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const EVENT_ROW = {
  event_id: 'evt-1',
  correlation_id: '6ec3164f-1f59-40e7-acd2-ebedf9c4d56e',
  occurred_at: '2026-09-02T14:21:56Z',
  payload: {
    recipients: ['acme-ab-x7f2+ver@arcim.io'],
    tags: ['ver'],
    inbox_id: 'inbox-1',
    kind_hint: 'receipt',
    tag_conflict: false,
    outcome: 'attachments',
    attachment_count: 2,
    inbox_item_id: null,
    attachments: [
      { id: 'att-1', outcome: 'filed', inbox_item_id: 'item-1' },
      { id: 'att-2', outcome: 'failed', inbox_item_id: 'item-2' },
    ],
  },
}

describe('GET /inbound-history (#2181)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without context', async () => {
    const res = await route.handler(createMockRequest('/inbound-history'), undefined)
    expect(res.status).toBe(401)
  })

  it.each(['0', '-1', '366', 'abc', '1.5'])('returns 400 for days=%s', async (days) => {
    const { supabase } = createQueuedMockSupabase()
    const res = await route.handler(
      createMockRequest(`/inbound-history?days=${days}`),
      buildCtx(supabase)
    )
    expect(res.status).toBe(400)
  })

  it('returns the company-scoped InboundMailReceived events, newest first, 30 days by default', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: [EVENT_ROW] })
    const res = await route.handler(createMockRequest('/inbound-history'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{
      data: { days: number; mails: Array<Record<string, unknown>> }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.days).toBe(30)
    expect(body.data.mails).toEqual([
      {
        event_id: 'evt-1',
        email_id: '6ec3164f-1f59-40e7-acd2-ebedf9c4d56e',
        occurred_at: '2026-09-02T14:21:56Z',
        ...EVENT_ROW.payload,
      },
    ])

    const eqs = calls.filter((c) => c.table === 'processing_history' && c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual([
      ['company_id', 'company-1'],
      ['event_type', 'InboundMailReceived'],
    ])
    const gte = calls.find((c) => c.table === 'processing_history' && c.method === 'gte')
    expect(gte?.args[0]).toBe('occurred_at')
    const order = calls.find((c) => c.table === 'processing_history' && c.method === 'order')
    expect(order?.args).toEqual(['occurred_at', { ascending: false }])
  })

  it('honours an explicit window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const res = await route.handler(createMockRequest('/inbound-history?days=7'), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ data: { days: number; mails: unknown[] } }>(res)
    expect(body.data).toEqual({ days: 7, mails: [] })
  })

  it('returns 500 when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    const res = await route.handler(createMockRequest('/inbound-history'), buildCtx(supabase))
    expect(res.status).toBe(500)
  })
})
