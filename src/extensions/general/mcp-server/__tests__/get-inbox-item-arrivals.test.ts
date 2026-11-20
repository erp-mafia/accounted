import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { tools } from '../server'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const itemId = '44444444-4444-4444-8444-444444444444'
const documentId = '33333333-3333-4333-8333-333333333333'
const arrivalId = '55555555-5555-4555-8555-555555555555'

const tool = tools.find((t) => t.name === 'gnubok_get_inbox_item')!

const outputsTable: TableMockResolver = (calls) => {
  const inCall = calls.find((c) => c.method === 'in')
  if (inCall?.args[0] === 'arrival_id') {
    return {
      data: [
        { arrival_id: arrivalId, output_kind: 'document', output_id: documentId, role: 'attachment', position: 0 },
        { arrival_id: arrivalId, output_kind: 'inbox_item', output_id: itemId, role: 'attachment', position: 0 },
      ],
    }
  }
  return { data: [{ arrival_id: arrivalId }] }
}

function db(arrivals: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({
    invoice_inbox_items: { data: { id: itemId, company_id: companyId, document_id: documentId, status: 'received' } },
    arrival_outputs: outputsTable,
    arrivals,
  })
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: {
      // As Storage signs it for summariseArrivals: the token, then the download name.
      signedUrl: `https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/sign/documents/${companyId}/arrivals/${arrivalId}/em_1.eml?token=t&download=em_1.eml`,
    },
    error: null,
  })
  Object.assign(mock.supabase, { storage: { from: vi.fn(() => ({ createSignedUrl })) } })
  return { ...mock, createSignedUrl, client: mock.supabase as unknown as SupabaseClient }
}

const ARRIVAL_ROW = {
  id: arrivalId,
  company_id: companyId,
  source: 'intake_email',
  source_ref: 'em_1',
  received_at: '2026-10-15T08:00:00Z',
  sender: { from: 'faktura@leverantor.example' },
  subject: 'Faktura 1001',
  message_text: 'Hej!',
  original_path: `documents/${companyId}/arrivals/${arrivalId}/em_1.eml`,
  original_sha256: null,
  original_mime: 'message/rfc822',
  original_size: 100,
  fetched_by: { type: 'webhook', label: 'resend-inbound' },
  source_meta: {},
  created_at: '2026-10-15T08:00:01Z',
}

describe('gnubok_get_inbox_item arrivals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('adds how the item came in, with the original served from the app origin and its token in original_url_headers', async () => {
    const { client, findCalls } = db({ data: [ARRIVAL_ROW] })
    const result = (await tool.execute({ inbox_item_id: itemId }, companyId, userId, client)) as Record<string, unknown>

    expect(result).toMatchObject({ id: itemId, document_id: documentId, status: 'received' })
    expect(result.arrivals).toEqual([
      expect.objectContaining({
        id: arrivalId,
        source: 'intake_email',
        subject: 'Faktura 1001',
        message_text: 'Hej!',
        has_original: true,
        original_mime: 'message/rfc822',
        // No token in the URL; the download name stays.
        original_url: `https://app.accounted.se/api/storage/sign/documents/${companyId}/arrivals/${arrivalId}/em_1.eml?download=em_1.eml`,
        original_url_headers: { Authorization: 'Bearer t' },
      }),
    ])
    // Asked through both the item and its document, scoped to the company.
    expect(findCalls('arrival_outputs', 'eq').filter((args) => args[0] === 'output_kind').map((args) => args[1])).toEqual([
      'inbox_item',
      'document',
    ])
    expect(findCalls('arrival_outputs', 'eq').filter((args) => args[0] === 'company_id').every((args) => args[1] === companyId)).toBe(true)
  })

  it('still returns the item when the arrivals cannot be read', async () => {
    const { client } = db({ data: null, error: { message: 'relation "arrivals" does not exist' } })
    const result = (await tool.execute({ inbox_item_id: itemId }, companyId, userId, client)) as Record<string, unknown>
    expect(result).toMatchObject({ id: itemId, arrivals: [] })
  })
})
