import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listArchiveHistory } from '../history'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('listArchiveHistory', () => {
  it('merges the audit trail, the processing history and the activities into one list, newest first, with file names', async () => {
    enqueue({
      data: [
        { id: 'a1', action: 'UPDATE', record_id: 'd1', actor_type: 'user', actor_label: 'Jakob', old_state: { doc_type: 'agreement.subscription', pages_read_at: 'x' }, new_state: { doc_type: 'supplier_invoice', file_name: 'Bitwarden.pdf', pages_read_at: 'x' }, created_at: '2026-09-22T14:02:00Z' },
        { id: 'a2', action: 'UPDATE', record_id: 'd2', actor_type: 'system', actor_label: null, old_state: { doc_type: null, pages_read_at: null }, new_state: { doc_type: 'decision.skatteverket', file_name: 'IMG_7484.jpg', pages_read_at: null }, created_at: '2026-09-22T13:35:00Z' },
        { id: 'a3', action: 'UPDATE', record_id: 'd2', actor_type: 'system', actor_label: null, old_state: { pages_read_at: null }, new_state: { pages_read_at: '2026-09-22T13:33:00Z', file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:33:00Z' },
        { id: 'a4', action: 'UPDATE', record_id: 'd2', actor_type: 'system', actor_label: null, old_state: { read_error: null }, new_state: { read_error: 'x', file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:32:00Z' },
        { id: 'a5', action: 'INSERT', record_id: 'd2', actor_type: 'user', actor_label: 'Jakob', old_state: null, new_state: { file_name: 'IMG_7484.jpg' }, created_at: '2026-09-22T13:31:00Z' },
      ],
    })
    enqueue({ data: [{ event_id: 'p1', event_type: 'DocumentDuplicateSkipped', aggregate_id: 'd3', payload: {}, actor: { type: 'system', id: 'resend-inbound' }, occurred_at: '2026-09-22T13:40:00Z' }] })
    enqueue({ data: [{ id: 'x1', document_id: 'd1', kind: 'extract', started_at: '2026-09-22T14:03:00Z', outcome: 'ok' }] })
    enqueue({ data: [{ id: 'd1', file_name: 'Bitwarden.pdf' }, { id: 'd2', file_name: 'IMG_7484.jpg' }, { id: 'd3', file_name: 'Anmälan.pdf' }] })

    const events = await listArchiveHistory(supabase, 'co-1', 50)
    expect(events.map((e) => [e.kind, e.actor.kind, e.actor.label, e.document?.file_name, e.detail])).toEqual([
      ['extracted', 'arkiv', null, 'Bitwarden.pdf', 'ok'],
      ['retyped', 'user', 'Jakob', 'Bitwarden.pdf', 'supplier_invoice'],
      ['duplicate', 'system', 'resend-inbound', 'Anmälan.pdf', null],
      ['typed', 'system', null, 'IMG_7484.jpg', 'decision.skatteverket'],
      ['read', 'system', null, 'IMG_7484.jpg', null],
      ['ingested', 'user', 'Jakob', 'IMG_7484.jpg', null],
    ])
    // A write that changed nothing a person would call an event (a read error) is not listed.
    expect(events.find((e) => e.id === 'audit:a4')).toBeUndefined()
    expect(findCalls('audit_log', 'eq')).toEqual(expect.arrayContaining([['company_id', 'co-1'], ['table_name', 'document_attachments']]))
    expect(findCalls('processing_history', 'in')[0]).toEqual(['event_type', ['DocumentDuplicateSkipped', 'ChannelQuestionAsked', 'ChannelQuestionAnswered', 'TransactionDocumentReplaced']])
  })

  it('throws with the failing read', async () => {
    enqueue({ error: { message: 'timeout' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(listArchiveHistory(supabase, 'co-1')).rejects.toThrow('history read failed: timeout')
  })
})
