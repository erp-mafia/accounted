import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { recordWhatsAppArrival } from '../lib/arrival'
import type { WhatsAppMessage } from '@/types'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DOC = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const LINK = { id: 'link-1', user_id: 'user-1', phone_masked: '+46 70 *** ** 12' }

function message(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: 'msg-row-1',
    direction: 'inbound',
    wamid: 'wamid.HBgLNDY3MDAwMDAwMDA',
    sender_phone_hash: 'hash',
    phone_link_id: LINK.id,
    conversation_id: 'conv-1',
    message_type: 'image',
    body_text: 'Lunch med kund',
    media_id: 'media-1',
    media_mime: 'image/jpeg',
    media_sha256: 'meta-sha',
    media_filename: null,
    // Already without the sender number (redactRawPayload drops `from`).
    raw_payload: { id: 'wamid.HBgLNDY3MDAwMDAwMDA', timestamp: '1760518800', type: 'image', image: { id: 'media-1', caption: 'Lunch med kund' } },
    processing_status: 'processing',
    attempts: 1,
    error_message: null,
    inbox_item_id: null,
    delivery_status: null,
    correlation_id: null,
    acked_at: null,
    created_at: '2026-10-15T09:00:05Z',
    updated_at: '2026-10-15T09:00:05Z',
    ...overrides,
  }
}

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T09:00:06Z' }] }
  return { data: null }
}

function db(overrides: Record<string, unknown> = {}) {
  const mock = createTableMockSupabase({ arrivals, arrival_outputs: { data: null }, ...overrides } as never)
  const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
  Object.assign(mock.supabase, { storage: { from: vi.fn(() => ({ upload })) } })
  return { ...mock, upload, client: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => vi.clearAllMocks())

describe('recordWhatsAppArrival', () => {
  it('records the message with its masked sender, and keeps no chat text or payload', async () => {
    const { client, payloads, upload } = db()
    await recordWhatsAppArrival(client, { row: message(), link: LINK, companyId: COMPANY, documentId: DOC, inboxItemId: ITEM })

    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY,
      source: 'whatsapp',
      source_ref: 'wamid.HBgLNDY3MDAwMDAwMDA',
      received_at: new Date(1760518800 * 1000).toISOString(),
      message_text: null,
      sender: { phone_masked: '+46 70 *** ** 12', phone_link_id: 'link-1', user_id: 'user-1' },
      fetched_by: { type: 'webhook', label: 'whatsapp-inbound' },
      // The RoPA purges chat transcripts at 90 days: never copied into the arrival.
      original_path: null,
      original_sha256: null,
      original_mime: null,
    })
    expect(arrival!.source_meta).toMatchObject({ original_missing: 'chat_transcript_not_kept', whatsapp_message_id: 'msg-row-1' })
    // No part of the payload rides along in source_meta either.
    expect(JSON.stringify(arrival)).not.toContain('"timestamp"')
    expect(upload).not.toHaveBeenCalled()

    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC],
      ['inbox_item', ITEM],
    ])
  })

  it('records a duplicate receipt against the document it matched, without an inbox item', async () => {
    const { client, payloads } = db()
    await recordWhatsAppArrival(client, { row: message(), link: LINK, companyId: COMPANY, documentId: DOC })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => o.output_kind)).toEqual(['document'])
  })

  it('falls back to the row id and the receive time without a payload', async () => {
    const { client, payloads, upload } = db()
    await recordWhatsAppArrival(client, {
      row: message({ wamid: null, raw_payload: null }),
      link: LINK,
      companyId: COMPANY,
      documentId: DOC,
    })
    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({ source_ref: 'msg-row-1', received_at: '2026-10-15T09:00:05.000Z', original_path: null })
    expect(upload).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const { client } = db({ arrivals: { data: null, error: { message: 'boom' } } })
    await expect(
      recordWhatsAppArrival(client, { row: message(), link: LINK, companyId: COMPANY, documentId: DOC }),
    ).resolves.toBeUndefined()
  })
})
