/**
 * Tests for gnubok_get_invoice_deliveries.
 *
 * The tool is the agent-facing window into invoice email delivery history,
 * including the provider outcome (delivered/bounced/...), so an agent chasing
 * an unpaid invoice can see the mail never arrived. Privacy contract under
 * test: recipients arrive pre-masked from the service RPC (migration
 * 20260727100000), and the exact payload (body_html, body_text, bcc_addresses)
 * must never reach the MCP surface even if the RPC were ever widened: the tool
 * maps an explicit field list, and this suite pins that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

import { tools } from '../server'

const getDeliveries = tools.find((t) => t.name === 'gnubok_get_invoice_deliveries')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DELIVERY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

// Shape of one row as the service RPC returns it: recipients already masked,
// no payload columns present.
const BOUNCED_ROW = {
  id: DELIVERY_ID,
  channel: 'email',
  status: 'sent',
  to_addresses: ['***@example.com'],
  cc_addresses: ['***@example.org'],
  provider: 'resend',
  provider_status: 'bounced',
  provider_status_at: '2026-07-20T10:00:00+00:00',
  provider_status_detail: 'smtp; 550 5.1.1 ***@example.com recipient rejected',
  provider_recipient_statuses: {
    'to:1': { status: 'bounced', status_at: '2026-07-20T10:00:00+00:00' },
    'cc:1': { status: 'delivered', status_at: '2026-07-20T09:59:00+00:00' },
  },
  error_code: null,
  document_attachment_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  attachment_filename: 'faktura-1042.pdf',
  sent_at: '2026-07-19T09:00:00+00:00',
  failed_at: null,
  created_at: '2026-07-19T09:00:00+00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_invoice_deliveries: registration', () => {
  it('is registered as a plain read-only tool (not a staged operation)', () => {
    expect(getDeliveries).toBeDefined()
    expect(getDeliveries.annotations.readOnlyHint).toBe(true)
    expect(getDeliveries.annotations.destructiveHint).toBe(false)
    // Read tools return their data directly; the staged-operation envelope
    // (staged/risk_level/actor) must not appear here.
    const outputProps = (getDeliveries.outputSchema as { properties: Record<string, unknown> })
      .properties
    expect(outputProps.deliveries).toBeDefined()
    expect(outputProps.staged).toBeUndefined()
  })

  it('requires invoice_id and rejects unknown input properties', () => {
    const schema = getDeliveries.inputSchema as {
      additionalProperties: boolean
      required: string[]
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['invoice_id'])
  })

  it('is mapped to invoices:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_invoice_deliveries).toBe('invoices:read')
  })

  it('is search-only in the catalog (tools/list context budget)', () => {
    // Deliberate: a specialized per-invoice diagnostic stays out of the
    // default tools/list (payload-size.bench.test.ts ceiling) and is found
    // through gnubok_search_tools, like the company-settings tools.
    expect(getDeliveries.catalogVisibility).toBe('search')
  })

  it('uses only qualified identifiers in the output schema', () => {
    const itemProps = (
      getDeliveries.outputSchema as {
        properties: { deliveries: { items: { properties: Record<string, unknown> } } }
      }
    ).properties.deliveries.items.properties
    expect(itemProps.invoice_delivery_id).toBeDefined()
    expect(itemProps.id).toBeUndefined()
  })
})

describe('gnubok_get_invoice_deliveries: execute', () => {
  it('returns delivery attempts with the provider outcome and masked recipients', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID } }) // invoice existence check
    enqueue({ data: [BOUNCED_ROW] }) // RPC result

    const result = (await getDeliveries.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { deliveries: Array<Record<string, unknown>>; count: number }

    expect(result.count).toBe(1)
    const delivery = result.deliveries[0]
    expect(delivery.invoice_delivery_id).toBe(DELIVERY_ID)
    expect('id' in delivery).toBe(false)
    expect(delivery.channel).toBe('email')
    expect(delivery.status).toBe('sent')
    expect(delivery.provider).toBe('resend')
    expect(delivery.provider_status).toBe('bounced')
    expect(delivery.provider_status_at).toBe('2026-07-20T10:00:00+00:00')
    expect(delivery.provider_status_detail).toContain('550 5.1.1')
    expect(delivery.provider_recipient_statuses).toEqual({
      'to:1': { status: 'bounced', status_at: '2026-07-20T10:00:00+00:00' },
      'cc:1': { status: 'delivered', status_at: '2026-07-20T09:59:00+00:00' },
    })
    expect(delivery.error_code).toBeNull()
    expect(delivery.to_addresses).toEqual(['***@example.com'])
    expect(delivery.cc_addresses).toEqual(['***@example.org'])
    expect(delivery.attachment_filename).toBe('faktura-1042.pdf')
    expect(delivery.sent_at).toBe('2026-07-19T09:00:00+00:00')
    expect(delivery.failed_at).toBeNull()
    expect(delivery.created_at).toBe('2026-07-19T09:00:00+00:00')
  })

  it('calls the service RPC with the routed company and acting user, never the table', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID } })
    enqueue({ data: [] })

    await getDeliveries.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )

    expect(supabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries_for_service', {
      p_company_id: COMPANY_ID,
      p_user_id: USER_ID,
      p_invoice_id: INVOICE_ID,
    })
    // The invoice_deliveries table carries the exact subject/body/BCC of a
    // customer mail: the tool must never select it directly.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('invoices')
  })

  it('drops payload fields even if the RPC were widened to return them', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID } })
    enqueue({
      data: [
        {
          ...BOUNCED_ROW,
          // A hypothetical future regression in the RPC: these must not
          // survive the tool's explicit field mapping.
          subject: 'LEAKED-SUBJECT',
          body_text: 'LEAKED-BODY-TEXT',
          body_html: '<p>LEAKED-BODY-HTML</p>',
          bcc_addresses: ['leaked.bcc@example.net'],
          provider_recipient_statuses: {
            ...BOUNCED_ROW.provider_recipient_statuses,
            'bcc:1': { status: 'bounced', status_at: '2026-07-20T10:00:00+00:00' },
            'leaked.bcc@example.net': {
              status: 'bounced',
              status_at: '2026-07-20T10:00:00+00:00',
            },
          },
        },
      ],
    })

    const result = await getDeliveries.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('LEAKED-SUBJECT')
    expect(serialized).not.toContain('LEAKED-BODY-TEXT')
    expect(serialized).not.toContain('LEAKED-BODY-HTML')
    expect(serialized).not.toContain('leaked.bcc')
    expect(serialized).not.toContain('bcc_addresses')
    expect(serialized).not.toContain('bcc:1')
  })

  it('throws Invoice not found for an invoice outside the routed company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // maybeSingle miss

    await expect(
      getDeliveries.execute(
        { invoice_id: INVOICE_ID },
        COMPANY_ID,
        USER_ID,
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toThrow(/invoice not found/i)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      getDeliveries.execute({}, COMPANY_ID, USER_ID, supabase as never, {
        type: 'api_key',
      } as never),
    ).rejects.toThrow(/invoice_id is required/)
  })

  it('surfaces an RPC failure instead of reporting zero deliveries', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID } })
    enqueue({ data: null, error: { message: 'permission denied for function' } })

    await expect(
      getDeliveries.execute(
        { invoice_id: INVOICE_ID },
        COMPANY_ID,
        USER_ID,
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toThrow(/Database error/)
  })

  it('returns an empty list for an invoice with no delivery attempts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID } })
    enqueue({ data: [] })

    const result = (await getDeliveries.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { deliveries: unknown[]; count: number }

    expect(result.deliveries).toEqual([])
    expect(result.count).toBe(0)
  })
})
