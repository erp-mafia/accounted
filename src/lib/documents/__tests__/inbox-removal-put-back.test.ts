/**
 * removalCanBePutBack (lib/documents/inbox-item-state.ts): the one answer to
 * "can taking this item out of the inbox be undone?", behind the confirm's
 * sentence, the toast's Ångra and a staged removal's approval sentence. A
 * removal was promised a way back ("Du kan lägga tillbaka det från Senast
 * borttagna", Ångra) also for an item that keeps no copy: one without a
 * document (a mail whose attachment was refused) writes no decision row, so
 * Ångra answered 404 and the item was never listed.
 */
import { describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { deleteInboxItem } from '../inbox-item-actions'
import { removalCanBePutBack, withDocumentHold } from '../inbox-item-state'

const OPEN = {
  id: 'item-1',
  status: 'received',
  document_id: 'doc-1',
  matched_transaction_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  routed_to_arkiv_at: null,
}

describe('removalCanBePutBack', () => {
  it('is true for an item that carries a document and that nothing holds', () => {
    expect(removalCanBePutBack(OPEN)).toBe(true)
  })

  it('is false for an item without a document: its removal keeps no copy', () => {
    // The row a refused attachment leaves: an error, the mail fields, no file.
    expect(removalCanBePutBack({ ...OPEN, status: 'error', document_id: null })).toBe(false)
    expect(removalCanBePutBack({ status: 'received' })).toBe(false)
  })

  it('is false while something holds the item: its bank row, or a verifikat on its document', () => {
    expect(removalCanBePutBack({ ...OPEN, matched_transaction_id: 'tx-1' })).toBe(false)
    expect(removalCanBePutBack({ ...OPEN, document_journal_entry_id: 'je-1' })).toBe(false)
    const held = withDocumentHold({ ...OPEN, document_hold: { journal_entry_id: 'je-1', entry: { status: 'posted' } } })
    expect(removalCanBePutBack(held)).toBe(false)
  })

  it('is true when the verifikat that held its document is reversed: nothing books it any more', () => {
    const released = withDocumentHold({ ...OPEN, document_hold: { journal_entry_id: 'je-1', entry: { status: 'reversed' } } })
    expect(removalCanBePutBack(released)).toBe(true)
  })

  it('does not ask where the item stood in the queue: Arkiv routing and a failed reading come back too', () => {
    expect(removalCanBePutBack({ ...OPEN, routed_to_arkiv_at: '2026-11-01T00:00:00.000Z' })).toBe(true)
    expect(removalCanBePutBack({ ...OPEN, status: 'error' })).toBe(true)
  })
})

describe('deleteInboxItem: the dry run says whether the removal can be put back', () => {
  const row = (over: Record<string, unknown> = {}) => ({ ...OPEN, extracted_data: null, email_from: null, email_subject: null, created_at: '2026-10-28T08:15:00.000Z', ...over })
  const ctx = (supabase: unknown) =>
    ({ supabase, companyId: 'company-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } }) as never

  async function preview(item: Record<string, unknown>, document?: Record<string, unknown>) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: item })
    if (item.document_id) enqueue({ data: document ?? { file_name: 'faktura.pdf', journal_entry_id: null, entry: null } })
    const outcome = await deleteInboxItem(ctx(supabase), 'item-1', { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    return outcome.preview
  }

  it('true for an open item with its document', async () => {
    expect(await preview(row())).toMatchObject({ document_id: 'doc-1', file_name: 'faktura.pdf', can_be_put_back: true })
  })

  it('false without a document, when a bank row has it, and when a verifikat holds its document', async () => {
    expect(await preview(row({ status: 'error', document_id: null }))).toMatchObject({ document_id: null, can_be_put_back: false })
    expect(await preview(row({ matched_transaction_id: 'tx-1' }))).toMatchObject({ can_be_put_back: false })
    expect(
      await preview(row(), { file_name: 'faktura.pdf', journal_entry_id: 'je-1', entry: { status: 'posted' } }),
    ).toMatchObject({ can_be_put_back: false })
  })

  it('true again when that verifikat is reversed', async () => {
    expect(
      await preview(row(), { file_name: 'faktura.pdf', journal_entry_id: 'je-1', entry: { status: 'reversed' } }),
    ).toMatchObject({ can_be_put_back: true })
  })
})
