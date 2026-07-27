import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/bookkeeping/payment-sync', () => ({
  syncInvoiceStatusFromPaymentEntry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  reanchorOrphanedSupplierInvoiceDocuments: vi.fn().mockResolvedValue(0),
}))

import { reanchorOrphanedSupplierInvoiceDocuments } from '@/lib/core/documents/supplier-invoice-underlag'

import { DELETE } from '../route'

/**
 * The DELETE handler's `.from()` / `.rpc()` order, one queued result each:
 *   1. journal_entries      (source_type/source_id, read before the teardown)
 *   2. document_attachments (documents about to be orphaned by the RPC)
 *   3. rpc delete_last_voucher
 */
describe('DELETE /api/bookkeeping/journal-entries/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  const run = () =>
    DELETE(
      createMockRequest('/api/bookkeeping/journal-entries/je-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'je-1' }),
    )

  it('re-anchors the documents the deleted voucher orphaned', async () => {
    // delete_last_voucher has to clear journal_entry_id on every attached
    // document (the FK is ON DELETE RESTRICT). A supplier invoice's retained
    // PDF must not be left floating: unanchored, it stops counting as underlag
    // everywhere while still showing up on the invoice's other verifikat.
    enqueue({ data: { id: 'je-1', source_type: 'correction', source_id: null } })
    enqueue({ data: [{ id: 'doc-1' }, { id: 'doc-2' }] })
    enqueue({ data: { deleted: true, voucher_series: 'A', voucher_number: 12 } })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBe(200)
    expect(reanchorOrphanedSupplierInvoiceDocuments).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      ['doc-1', 'doc-2'],
    )
  })

  it('does not re-anchor when the RPC refused the delete', async () => {
    enqueue({ data: { id: 'je-1', source_type: 'manual', source_id: null } })
    enqueue({ data: [{ id: 'doc-1' }] })
    enqueue({ error: { message: 'Kan bara radera det sista verifikatet i serien.' } })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBe(400)
    expect(reanchorOrphanedSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })

  it('passes an empty list when the voucher had no documents', async () => {
    enqueue({ data: { id: 'je-1', source_type: 'manual', source_id: null } })
    enqueue({ data: [] })
    enqueue({ data: { deleted: true, voucher_series: 'A', voucher_number: 3 } })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBe(200)
    expect(reanchorOrphanedSupplierInvoiceDocuments).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      [],
    )
  })
})
