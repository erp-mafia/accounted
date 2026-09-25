import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listArchiveHistory } from '../history'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('listArchiveHistory', () => {
  it('merges the audit trail, the classifications, the processing history and the activities into one list, newest first, with file names', async () => {
    enqueue({
      data: [
        // A person's retype: the audit row is not the event, the classification row below is.
        { id: 'a1', action: 'UPDATE', record_id: 'd1', user_id: 'u1', actor_type: 'user', actor_label: 'Jakob', old_state: { doc_type: 'agreement.subscription', pages_read_at: 'x' }, new_state: { doc_type: 'supplier_invoice', file_name: 'Bitwarden.pdf', pages_read_at: 'x' }, created_at: '2026-09-22T14:02:00Z' },
        // The classifier types and admits in one write: Arkiv admitted it.
        { id: 'a2', action: 'UPDATE', record_id: 'd2', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: { doc_type: null, admission_state: 'held' }, new_state: { doc_type: 'decision.skatteverket', admission_state: 'admitted', file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:35:00Z' },
        // The pipeline read it: the trigger says the uploader, the history says Arkiv.
        { id: 'a3', action: 'UPDATE', record_id: 'd2', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: { pages_read_at: null }, new_state: { pages_read_at: '2026-09-22T13:33:00Z', read_error: null, file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:33:00Z' },
        // A read that failed is not "read".
        { id: 'a4', action: 'UPDATE', record_id: 'd4', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: { pages_read_at: null }, new_state: { pages_read_at: '2026-09-22T13:32:00Z', read_error: 'unsupported_mime', file_name: 'IMG_7484.heic' }, created_at: '2026-09-22T13:32:00Z' },
        { id: 'a5', action: 'INSERT', record_id: 'd2', user_id: 'u1', actor_type: 'user', actor_label: 'Jakob', old_state: null, new_state: { file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:31:00Z' },
        // A bank response archived by the sync: a file, not a document.
        { id: 'a6', action: 'INSERT', record_id: 'd5', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: null, new_state: { file_name: 'psd2-response_x_p1.json', mime_type: 'application/json' }, created_at: '2026-09-22T13:30:00Z' },
        // Arrived through a channel with nobody behind it.
        { id: 'a7', action: 'INSERT', record_id: 'd3', user_id: null, actor_type: 'user', actor_label: null, old_state: null, new_state: { file_name: 'Anmälan.pdf' }, created_at: '2026-09-22T13:20:00Z' },
      ],
    })
    enqueue({ data: [{ event_id: 'p1', event_type: 'DocumentDuplicateSkipped', aggregate_id: 'd3', payload: {}, actor: { type: 'system', id: 'resend-inbound' }, occurred_at: '2026-09-22T13:40:00Z' }] })
    enqueue({ data: [{ id: 'x1', document_id: 'd1', kind: 'extract', started_at: '2026-09-22T14:03:00Z', outcome: 'settled' }, { id: 'x2', document_id: 'd5', kind: 'extract', started_at: '2026-09-22T13:30:30Z', outcome: 'ok' }] })
    enqueue({
      data: [
        { id: 'c3', document_id: 'd1', doc_type: 'supplier_invoice', decided_by: 'human', created_at: '2026-09-22T14:02:00Z' },
        { id: 'c2', document_id: 'd2', doc_type: 'decision.skatteverket', decided_by: 'model', created_at: '2026-09-22T13:35:00Z' },
        { id: 'c1', document_id: 'd1', doc_type: 'agreement.subscription', decided_by: 'model', created_at: '2026-09-22T12:00:00Z' },
      ],
    })
    enqueue({
      data: [
        { id: 'd1', file_name: 'Bitwarden.pdf', mime_type: 'application/pdf' },
        { id: 'd2', file_name: 'IMG_7484.jpg', mime_type: 'image/jpeg' },
        { id: 'd3', file_name: 'Anmälan.pdf', mime_type: 'application/pdf' },
        { id: 'd4', file_name: 'IMG_7484.heic', mime_type: 'image/heic' },
        { id: 'd5', file_name: 'psd2-response_x_p1.json', mime_type: 'application/json' },
      ],
    })

    const events = await listArchiveHistory(supabase, 'co-1', 50)
    expect(events.map((e) => [e.kind, e.actor.kind, e.actor.label, e.document?.file_name, e.detail])).toEqual([
      ['extracted', 'arkiv', null, 'Bitwarden.pdf', null],
      ['retyped', 'user', null, 'Bitwarden.pdf', 'supplier_invoice'],
      ['duplicate', 'system', 'resend-inbound', 'Anmälan.pdf', null],
      ['admitted', 'arkiv', null, 'IMG_7484.jpg', null],
      ['typed', 'arkiv', null, 'IMG_7484.jpg', 'decision.skatteverket'],
      ['read', 'arkiv', null, 'IMG_7484.jpg', null],
      ['ingested', 'user', 'Jakob', 'IMG_7484.jpg', null],
      ['ingested', 'system', null, 'Anmälan.pdf', null],
      ['typed', 'arkiv', null, 'Bitwarden.pdf', 'agreement.subscription'],
    ])
    expect(events.find((e) => e.id === 'audit:a4')).toBeUndefined()
    expect(events.find((e) => e.document?.id === 'd5')).toBeUndefined()
    expect(findCalls('audit_log', 'eq')).toEqual(expect.arrayContaining([['company_id', 'co-1'], ['table_name', 'document_attachments']]))
    expect(findCalls('document_classifications', 'eq')).toEqual([['company_id', 'co-1']])
    expect(findCalls('processing_history', 'in')[0]).toEqual(['event_type', ['DocumentDuplicateSkipped', 'ChannelQuestionAsked', 'ChannelQuestionAnswered', 'TransactionDocumentReplaced']])
  })

  it('names a removed document from the audit row and lists one removal per document, not one per stored version', async () => {
    enqueue({
      data: [
        { id: 'r2', action: 'DELETE', record_id: 'd9', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: { file_name: 'TEST-kvitto.pdf', mime_type: 'application/pdf' }, new_state: null, created_at: '2026-09-24T16:06:02Z' },
        { id: 'r1', action: 'DELETE', record_id: 'd9', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: { file_name: 'TEST-kvitto.pdf', mime_type: 'application/pdf' }, new_state: null, created_at: '2026-09-24T16:06:01Z' },
        { id: 'r0', action: 'INSERT', record_id: 'd9', user_id: 'u1', actor_type: 'user', actor_label: null, old_state: null, new_state: { file_name: 'TEST-kvitto.pdf' }, created_at: '2026-09-24T15:34:00Z' },
      ],
    })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'x9', document_id: 'd9', kind: 'extract', started_at: '2026-09-24T15:35:00Z' }] })
    enqueue({ data: [] })
    enqueue({ data: [] }) // the document row is gone
    const events = await listArchiveHistory(supabase, 'co-1', 50)
    expect(events.map((e) => [e.kind, e.document?.file_name])).toEqual([
      ['deleted', 'TEST-kvitto.pdf'],
      ['extracted', 'TEST-kvitto.pdf'],
      ['ingested', 'TEST-kvitto.pdf'],
    ])
  })

  it('throws with the failing read', async () => {
    enqueue({ error: { message: 'timeout' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(listArchiveHistory(supabase, 'co-1')).rejects.toThrow('history read failed: timeout')
  })
})
