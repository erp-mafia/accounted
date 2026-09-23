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

// The source-type predicate stays real: which vouchers the route syncs in TS
// is the contract under test. Only the I/O is mocked.
vi.mock('@/lib/bookkeeping/payment-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/payment-sync')>()),
  loadPaymentEntryLinks: vi.fn().mockResolvedValue(null),
  syncInvoiceStatusFromPaymentEntry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  reanchorOrphanedSupplierInvoiceDocuments: vi.fn().mockResolvedValue(0),
}))

import { reanchorOrphanedSupplierInvoiceDocuments } from '@/lib/core/documents/supplier-invoice-underlag'
import { loadPaymentEntryLinks, syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'

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

  // Utlägg and the supplier side are reverted INSIDE delete_last_voucher, in
  // the same transaction as the delete (tests/pg/voucher-delete-registers).
  // The route must not revert them a second time: on a part payment the TS
  // sync would take the already-reverted paid_amount down to zero and wipe
  // the payment that should stand.
  it.each([
    ['an utlägg voucher', 'expense_claim', 'claim-1'],
    ['a supplier payment voucher', 'supplier_invoice_paid', 'si-1'],
    ['a supplier cash payment voucher', 'supplier_invoice_cash_payment', 'si-1'],
  ])('leaves %s to the RPC: no TS load, no TS sync', async (_label, sourceType, sourceId) => {
    enqueue({ data: { id: 'je-1', source_type: sourceType, source_id: sourceId } })
    enqueue({ data: [] })
    enqueue({ data: { deleted: true, voucher_series: 'A', voucher_number: 44 } })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBe(200)
    expect(loadPaymentEntryLinks).not.toHaveBeenCalled()
    expect(syncInvoiceStatusFromPaymentEntry).not.toHaveBeenCalled()
  })

  // The RPC refuses BEFORE deleting when the utlägg carries payout state. Its
  // message is already user-facing Swedish and must reach the user as written.
  it('answers 400 with the RPC refusal verbatim when the utlägg is already paid out', async () => {
    const refusal =
      'Verifikatet kan inte raderas: utlägget är redan utbetalt eller ligger i en utbetalning. Ångra utbetalningen först.'
    enqueue({ data: { id: 'je-1', source_type: 'expense_claim', source_id: 'claim-1' } })
    enqueue({ data: [] })
    enqueue({ error: { message: refusal, code: 'P0001' } })

    const { status, body } = await parseJsonResponse<{ error: string }>(await run())

    expect(status).toBe(400)
    expect(body.error).toBe(refusal)
    expect(reanchorOrphanedSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })

  // The payment row and bank rows are linked by ON DELETE SET NULL FKs, so the
  // route must read them while the entry exists and hand them to the sync:
  // looked up after the RPC they are gone, and the payment row stayed in the
  // invoice's history.
  it('loads the payment links before the delete and passes them to the sync', async () => {
    const links = {
      paymentRows: [{ id: 'ip-1', amount: 1500, transaction_id: null }],
      transactionIds: [],
    }
    const order: string[] = []
    vi.mocked(loadPaymentEntryLinks).mockImplementationOnce(async () => {
      order.push('load')
      return links
    })
    const rpc = mockSupabase.rpc
    enqueue({ data: { id: 'je-1', source_type: 'invoice_paid', source_id: 'inv-1' } })
    enqueue({ data: [] })
    enqueue({ data: { deleted: true, voucher_series: 'K', voucher_number: 67 } })
    vi.mocked(syncInvoiceStatusFromPaymentEntry).mockImplementationOnce(async () => {
      order.push('sync')
    })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBe(200)
    expect(order).toEqual(['load', 'sync'])
    expect(vi.mocked(loadPaymentEntryLinks).mock.invocationCallOrder[0]).toBeLessThan(
      rpc.mock.invocationCallOrder[0],
    )
    expect(syncInvoiceStatusFromPaymentEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      { id: 'je-1', source_type: 'invoice_paid', source_id: 'inv-1' },
      links,
    )
  })

  it('refuses the delete when the payment links cannot be read', async () => {
    vi.mocked(loadPaymentEntryLinks).mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    )
    enqueue({ data: { id: 'je-1', source_type: 'invoice_paid', source_id: 'inv-1' } })

    const { status } = await parseJsonResponse(await run())

    expect(status).toBeGreaterThanOrEqual(500)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(syncInvoiceStatusFromPaymentEntry).not.toHaveBeenCalled()
  })
})
