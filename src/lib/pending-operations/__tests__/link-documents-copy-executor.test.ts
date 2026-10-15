/**
 * link_documents_to_vouchers approval with copy rows (crm#1207): a row
 * staged with copy: true archives a byte-identical copy for its verifikat
 * through linkDocumentCopyToVoucher; every other row links the document
 * itself through linkDocumentToVoucher, as before. The result names the
 * copy and the document it was made from, which is the audit trail of where
 * the new file came from.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const linkDocumentToVoucher = vi.fn()
const linkDocumentCopyToVoucher = vi.fn()
vi.mock('@/lib/documents/link-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/link-document')>()),
  linkDocumentToVoucher: (...args: unknown[]) => linkDocumentToVoucher(...args),
  linkDocumentCopyToVoucher: (...args: unknown[]) => linkDocumentCopyToVoucher(...args),
}))

import { commitPendingOperation } from '../commit'

function op(links: unknown[]): PendingOperation {
  return {
    id: 'op-1', user_id: 'user-1', company_id: 'company-1', operation_type: 'link_documents_to_vouchers',
    status: 'pending', title: 'test', params: { links }, preview_data: {}, result_data: null,
    actor_type: 'api_key', actor_id: null, actor_label: null, risk_level: 'medium',
    created_at: '2026-10-15T00:00:00Z', resolved_at: null, updated_at: '2026-10-15T00:00:00Z',
  } as unknown as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  linkDocumentToVoucher.mockResolvedValue({
    ok: true, dryRun: false, target: {}, document: { id: 'invoice', journal_entry_id: 'je-a2' },
  })
  linkDocumentCopyToVoucher.mockResolvedValue({
    ok: true, reused: false, source_document_id: 'invoice', document: { id: 'copy-1', journal_entry_id: 'je-a27' },
  })
})

describe('commitPendingOperation: link_documents_to_vouchers with a copy row', () => {
  it('links the document to A2 and a copy of it to A27, naming the source of the copy', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // dispatcher commit update

    const result = await commitPendingOperation(supabase as never, 'user-approver', 'company-1', op([
      { document_id: 'invoice', journal_entry_id: 'je-a2', journal_entry_line_id: null },
      { document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null, copy: true },
    ]))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      linked_count: 2,
      skipped_count: 0,
      linked: [
        { document_id: 'invoice', journal_entry_id: 'je-a2' },
        { document_id: 'copy-1', journal_entry_id: 'je-a27', copy_of_document_id: 'invoice' },
      ],
    })
    expect(linkDocumentToVoucher).toHaveBeenCalledTimes(1)
    expect(linkDocumentCopyToVoucher).toHaveBeenCalledWith(supabase, 'company-1', 'user-approver', {
      document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null,
    })
  })

  it('skips a copy row its rules refuse, in Swedish, and keeps the other rows', async () => {
    linkDocumentCopyToVoucher.mockResolvedValueOnce({ ok: false, code: 'PERIOD_LOCKED', details: { period: {} } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op([
      { document_id: 'invoice', journal_entry_id: 'je-a2', journal_entry_line_id: null },
      { document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null, copy: true },
    ]))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      linked_count: 1,
      skipped: [{ document_id: 'invoice', journal_entry_id: 'je-a27', reason: 'Verifikationens period är låst: bilagan kan inte länkas.' }],
    })
  })

  it('rejects the operation when the only row, a copy, fails: a batch that changed nothing is no commit', async () => {
    linkDocumentCopyToVoucher.mockRejectedValueOnce(new Error('document copy: the source file failed its integrity check'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op([
      { document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null, copy: true },
    ]))

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(linkDocumentToVoucher).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: link_document_to_voucher staged as a copy (crm#1171 item 9)', () => {
  function single(params: Record<string, unknown>): PendingOperation {
    return { ...op([]), operation_type: 'link_document_to_voucher', params } as PendingOperation
  }

  it('archives a copy for the verifikat and names the document it was made from', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // dispatcher commit update

    const result = await commitPendingOperation(supabase as never, 'user-approver', 'company-1', single({
      document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null, copy: true,
    }))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ document_id: 'copy-1', journal_entry_id: 'je-a27', copy_of_document_id: 'invoice' })
    expect(linkDocumentCopyToVoucher).toHaveBeenCalledWith(supabase, 'company-1', 'user-approver', {
      document_id: 'invoice', journal_entry_id: 'je-a27', journal_entry_line_id: null,
    })
    expect(linkDocumentToVoucher).not.toHaveBeenCalled()
  })

  it('rejects in Swedish when the copy rules refuse it', async () => {
    linkDocumentCopyToVoucher.mockResolvedValueOnce({ ok: false, code: 'PERIOD_LOCKED', details: { period: {} } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', single({
      document_id: 'invoice', journal_entry_id: 'je-a27', copy: true,
    }))

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toBe('Verifikationens period är låst: bilagan kan inte länkas.')
  })

  it('links the document itself when the operation was not staged as a copy', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', single({
      document_id: 'invoice', journal_entry_id: 'je-a2',
    }))

    expect(result.status).toBe('committed')
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
    expect(linkDocumentToVoucher).toHaveBeenCalledTimes(1)
  })
})
