/**
 * linkToJournalEntry pins a document to a line only when the line is one of
 * the verifikat's. The line FK only checks existence and bypasses
 * RLS, and the immutability trigger makes a set line permanent, so a line of
 * another verifikat (or company) used to be pinned for good by every caller
 * that did not check it itself (the dashboard route, the MCP approvals).
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { linkToJournalEntry } from '../document-service'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('linkToJournalEntry: line check', () => {
  it('refuses a line that is not on the verifikat and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'je-1' } }) // the verifikat is the company's
    enqueue({ data: null }) // no such line on it

    await expect(
      linkToJournalEntry(supabase as unknown as SupabaseClient, 'company-1', 'doc-1', 'je-1', { link_basis: 'user_confirmed', link_evidence: null }, 'line-of-another-entry'),
    ).rejects.toThrow(/journal entry line not found/)
    expect(findCalls('journal_entry_lines', 'eq')).toEqual([
      ['id', 'line-of-another-entry'],
      ['journal_entry_id', 'je-1'],
    ])
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
  })

  it('pins a line of the verifikat', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'je-1' } })
    enqueue({ data: { id: 'line-1' } })
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1', journal_entry_line_id: 'line-1' } })

    const linked = await linkToJournalEntry(supabase as unknown as SupabaseClient, 'company-1', 'doc-1', 'je-1', { link_basis: 'user_confirmed', link_evidence: null }, 'line-1')

    expect(linked).toMatchObject({ journal_entry_line_id: 'line-1' })
    expect(findCall('document_attachments', 'update')).toEqual([
      { journal_entry_id: 'je-1', journal_entry_line_id: 'line-1', link_basis: 'user_confirmed', link_evidence: null },
    ])
  })

  it('needs no line lookup without a line', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'je-1' } })
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1', journal_entry_line_id: null } })

    await linkToJournalEntry(supabase as unknown as SupabaseClient, 'company-1', 'doc-1', 'je-1', { link_basis: 'system_derived', link_evidence: null })

    expect(findCalls('journal_entry_lines', 'select')).toHaveLength(0)
  })

  it('records why the document is the underlag (link basis)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'je-1' } })
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1', journal_entry_line_id: null } })

    await linkToJournalEntry(supabase as unknown as SupabaseClient, 'company-1', 'doc-1', 'je-1', {
      link_basis: 'system_derived',
      link_evidence: { rule_id: 'invoice_document_anchor' },
    })

    expect(findCall('document_attachments', 'update')).toEqual([
      {
        journal_entry_id: 'je-1',
        journal_entry_line_id: null,
        link_basis: 'system_derived',
        link_evidence: { rule_id: 'invoice_document_anchor' },
      },
    ])
  })
})
