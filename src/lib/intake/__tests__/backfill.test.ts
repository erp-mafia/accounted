import { describe, it, expect } from 'vitest'
import {
  documentIdsToRead,
  planArrivals,
  whatsappIdsToRead,
  type BackfillDocument,
  type BackfillInboxItem,
  type BackfillWhatsAppMessage,
} from '../backfill'

const COMPANY = '11111111-1111-4111-8111-111111111111'

function item(overrides: Partial<BackfillInboxItem>): BackfillInboxItem {
  return {
    id: 'item-1',
    company_id: COMPANY,
    user_id: 'user-1',
    source: 'email',
    document_id: 'doc-1',
    created_at: '2026-09-01T10:00:00Z',
    email_from: 'faktura@leverantor.example',
    email_subject: 'Faktura 1001',
    email_received_at: '2026-09-01T09:59:00Z',
    email_body_text: 'Se bifogad faktura.',
    resend_email_id: 'em_1',
    resend_attachment_id: 'att_1',
    raw_email_payload: { messageId: '<m@x>' },
    whatsapp_message_id: null,
    channel_context: null,
    ...overrides,
  }
}

const noLookups = { whatsapp: new Map<string, BackfillWhatsAppMessage>(), documents: new Map<string, BackfillDocument>() }

describe('planArrivals', () => {
  it('folds the attachments and body of one mail into one arrival, in order', () => {
    const { planned } = planArrivals(
      [
        item({ id: 'item-1', document_id: 'doc-1', resend_attachment_id: 'att_1' }),
        item({ id: 'item-2', document_id: 'doc-2', resend_attachment_id: null }),
        item({ id: 'item-3', document_id: null, resend_attachment_id: 'att_3' }),
      ],
      noLookups,
    )
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({
      key: `${COMPANY}|intake_email|em_1`,
      source: 'intake_email',
      sourceRef: 'em_1',
      receivedAt: '2026-09-01T09:59:00Z',
      sender: { from: 'faktura@leverantor.example' },
      subject: 'Faktura 1001',
      messageText: 'Se bifogad faktura.',
      sourceMeta: { backfilled: true, original_missing: 'backfilled_without_raw', message_id: '<m@x>' },
    })
    expect(planned[0]!.outputs.map((o) => [o.kind, o.id, o.role, o.position])).toEqual([
      ['document', 'doc-1', 'attachment', 0],
      ['inbox_item', 'item-1', 'attachment', 0],
      ['document', 'doc-2', 'body', 1],
      ['inbox_item', 'item-2', 'body', 1],
      ['inbox_item', 'item-3', 'attachment', 2],
    ])
  })

  it('keeps one mail to two companies as two arrivals', () => {
    const other = '22222222-2222-4222-8222-222222222222'
    const { planned } = planArrivals([item({}), item({ id: 'item-9', company_id: other })], noLookups)
    expect(planned.map((p) => p.companyId)).toEqual([COMPANY, other])
  })

  it('reads WhatsApp from its message row, caption only: the chat payload is never the original', () => {
    const whatsapp = new Map<string, BackfillWhatsAppMessage>([
      ['wa-1', { id: 'wa-1', wamid: 'wamid.1', body_text: null, raw_payload: { timestamp: '1756720800', type: 'image' }, created_at: '2026-09-01T10:00:00Z', phone_link_id: 'link-1', message_type: 'image', media_mime: 'image/jpeg' }],
      ['wa-2', { id: 'wa-2', wamid: null, body_text: null, raw_payload: null, created_at: '2026-06-01T10:00:00Z', phone_link_id: 'link-1', message_type: 'image', media_mime: 'image/jpeg' }],
    ])
    const { planned, skipped } = planArrivals(
      [
        item({ id: 'i-1', source: 'whatsapp', whatsapp_message_id: 'wa-1', channel_context: { channel: 'whatsapp', caption: 'Taxi' } }),
        item({ id: 'i-2', source: 'whatsapp', whatsapp_message_id: 'wa-2' }),
        item({ id: 'i-3', source: 'whatsapp', whatsapp_message_id: 'wa-gone' }),
      ],
      { ...noLookups, whatsapp },
    )
    expect(skipped).toEqual({ whatsapp_without_message: 1 })
    expect(planned[0]).toMatchObject({
      source: 'whatsapp',
      sourceRef: 'wamid.1',
      messageText: 'Taxi',
      receivedAt: new Date(1756720800 * 1000).toISOString(),
      sourceMeta: { original_missing: 'chat_transcript_not_kept' },
    })
    expect(planned[0]!.originalRef).toBeUndefined()
    expect(planned[1]).toMatchObject({ sourceRef: 'wa-2', receivedAt: '2026-06-01T10:00:00Z' })
  })

  it('points a Peppol arrival at the archived XML and an upload at its own document', () => {
    const documents = new Map<string, BackfillDocument>([
      ['xml-1', { id: 'xml-1', storage_path: 'documents/c/u/peppol.xml', sha256_hash: 'a'.repeat(64), mime_type: 'application/xml', file_size_bytes: 900, file_name: 'peppol.xml', upload_source: 'e_invoice' }],
      ['up-1', { id: 'up-1', storage_path: 'documents/c/u/kvitto.pdf', sha256_hash: 'b'.repeat(64), mime_type: 'application/pdf', file_size_bytes: 100, file_name: 'kvitto.pdf', upload_source: 'file_upload' }],
      ['api-1', { id: 'api-1', storage_path: 'documents/c/u/api.pdf', sha256_hash: null, mime_type: 'application/pdf', file_size_bytes: 100, file_name: 'api.pdf', upload_source: 'api' }],
    ])
    const items = [
      item({ id: 'p-1', source: 'peppol', document_id: 'pdf-1', channel_context: { channel: 'peppol', peppol_document_id: 'prov-1', peppol_xml_document_id: 'xml-1', peppol_provider: 'qvalia' } }),
      item({ id: 'u-1', source: 'upload', document_id: 'up-1' }),
      item({ id: 'u-2', source: 'upload', document_id: 'api-1' }),
    ]
    expect(documentIdsToRead(items).sort()).toEqual(['api-1', 'up-1', 'xml-1'])
    const { planned } = planArrivals(items, { ...noLookups, documents })
    expect(planned[0]).toMatchObject({ source: 'peppol', sourceRef: 'prov-1', originalRef: { path: 'documents/c/u/peppol.xml', sha256: 'a'.repeat(64) } })
    expect(planned[0]!.outputs.map((o) => [o.kind, o.id, o.role])).toEqual([
      ['document', 'xml-1', 'xml'],
      ['document', 'pdf-1', 'rendering'],
      ['inbox_item', 'p-1', 'rendering'],
    ])
    expect(planned[1]).toMatchObject({ source: 'upload', sourceRef: 'up-1', fetchedBy: { type: 'user', user_id: 'user-1' }, originalRef: { path: 'documents/c/u/kvitto.pdf' } })
    expect(planned[2]).toMatchObject({ source: 'mcp', sourceRef: 'api-1' })
  })

  it('groups a hunted message per mailbox door, whatever the provider, and skips what it cannot place', () => {
    const hunt = (id: string, extra: Record<string, unknown>) =>
      item({ id, source: 'mail_hunt', document_id: `doc-${id}`, channel_context: { channel: 'mail_hunt', mail_provider: 'gmail', mail_message_id: 'g-1', mail_from: 'kvitto@sj.example', mail_subject: 'Ditt kvitto', mail_mailbox: 'me@x.example', ...extra } })
    const { planned, skipped } = planArrivals(
      [
        hunt('h-1', {}),
        hunt('h-2', {}),
        hunt('h-3', { mail_provider: 'microsoft', mail_message_id: 'o-1', mail_mailbox: 'me@y.example' }),
        hunt('h-4', { mail_message_id: null }),
        item({ id: 'e-0', resend_email_id: null }),
        item({ id: 'x-0', source: 'portal' }),
        item({ id: 'u-0', source: 'upload', document_id: 'missing' }),
      ],
      noLookups,
    )
    expect(planned).toHaveLength(2)
    expect(planned[0]).toMatchObject({
      source: 'mailbox',
      sourceRef: 'g-1',
      sender: { from: 'kvitto@sj.example' },
      messageText: null,
      sourceMeta: { provider: 'gmail', mailbox: 'me@x.example' },
    })
    expect(planned[0]!.outputs.filter((o) => o.kind === 'inbox_item').map((o) => [o.id, o.position])).toEqual([
      ['h-1', 0],
      ['h-2', 1],
    ])
    expect(planned[1]).toMatchObject({ source: 'mailbox', sourceRef: 'o-1', sourceMeta: { provider: 'microsoft', mailbox: 'me@y.example' } })
    expect(skipped).toEqual({
      mail_hunt_without_message_id: 1,
      email_without_resend_id: 1,
      unknown_source: 1,
      upload_without_document: 1,
    })
  })

  it('lists the WhatsApp rows a page needs', () => {
    expect(whatsappIdsToRead([item({ source: 'whatsapp', whatsapp_message_id: 'wa-1' }), item({ source: 'whatsapp', whatsapp_message_id: 'wa-1' }), item({})])).toEqual(['wa-1'])
  })
})
