import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadDocumentClaims, sharedDocumentWarning } from '../document-claims'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
beforeEach(() => reset())

describe('loadDocumentClaims', () => {
  it('collects waiting links (single and batch) and transactions the document is attached to', async () => {
    enqueue({ data: [
      { id: 'op-a', params: { document_id: 'doc-1', transaction_id: 'tx-1' } },
      { id: 'op-b', params: { links: [{ document_id: 'doc-2', journal_entry_id: 'je-9' }, { document_id: 'doc-other', journal_entry_id: 'je-8' }] } },
    ] })
    enqueue({ data: [{ id: 'tx-7', document_id: 'doc-1' }] })
    const claims = await loadDocumentClaims(supabase as never, 'company-a', ['doc-1', 'doc-2'])
    expect(claims.get('doc-1')).toEqual([
      { document_id: 'doc-1', operation_id: 'op-a', transaction_id: 'tx-1', journal_entry_id: null },
      { document_id: 'doc-1', operation_id: null, transaction_id: 'tx-7', journal_entry_id: null },
    ])
    expect(claims.get('doc-2')).toEqual([{ document_id: 'doc-2', operation_id: 'op-b', transaction_id: null, journal_entry_id: 'je-9' }])
    expect(claims.has('doc-other')).toBe(false)
  })

  it('asks nothing when there are no documents', async () => {
    expect((await loadDocumentClaims(supabase as never, 'company-a', [])).size).toBe(0)
  })
})

describe('sharedDocumentWarning', () => {
  const pendingFirst = { document_id: 'doc-1', operation_id: '9d329d0d-061f', transaction_id: '331ace55-cc90', journal_entry_id: null }

  it('warns when the same invoice is proposed for the twin charge', () => {
    const note = sharedDocumentWarning([pendingFirst], { transaction_id: '9158cf8d-11de' })
    expect(note).toContain('förslag 9d329d0d')
    expect(note).toContain('banktransaktion 331ace55')
    expect(note).toContain('betalats i flera delar')
  })

  it('does not warn about the link being staged itself', () => {
    expect(sharedDocumentWarning([pendingFirst], { transaction_id: '331ace55-cc90' })).toBeNull()
    expect(sharedDocumentWarning([], { transaction_id: 'tx-1' })).toBeNull()
  })

  it('names a transaction the document is already attached to', () => {
    const note = sharedDocumentWarning([{ document_id: 'doc-1', operation_id: null, transaction_id: 'abcdef12-3456', journal_entry_id: null }], { journal_entry_id: 'je-1' })
    expect(note).toContain('banktransaktion abcdef12')
  })
})
