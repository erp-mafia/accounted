/**
 * A staged create_supplier_invoice_from_inbox whose inbox item became a
 * supplier invoice another way stops looking approvable (crm#1074): the
 * helper alone, and wired into the dashboard / v1 conversion door.
 */
import { describe, it, expect, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { createQueuedMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({ createSupplierInvoiceRegistrationEntry: vi.fn() }))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { rejectSupersededInboxConversions } from '../supersede'

const SUPPLIER = '00000000-0000-4000-8000-000000000001'
const BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: SUPPLIER,
  supplier_invoice_number: 'F-2026-001',
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  items: [{ description: 'Konsulttjänster', amount: 10000, account_number: '6200', vat_rate: 0.25 }],
})
const convert = (mock: ReturnType<typeof createQueuedMockSupabase>, dryRun = false) =>
  convertInboxItemToSupplierInvoice(
    { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') },
    'item-1',
    BODY,
    { dryRun, emit: async () => {} },
  )

describe('rejectSupersededInboxConversions', () => {
  it('writes the dispatcher auto-reject row on the pending conversions of that item only', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ id: 'op-1' }, { id: 'op-2' }] })
    expect(await rejectSupersededInboxConversions(mock.supabase as never, 'company-1', 'item-1', 'invoice-1')).toBe(2)
    expect(mock.findCall('pending_operations', 'update')?.[0]).toMatchObject({
      status: 'rejected',
      // Handled another way: a system rejection, not a person's verdict.
      rejection_category: 'superseded',
      result_data: {
        auto_rejected: true,
        reason: 'Posten är redan kopplad till en leverantörsfaktura.',
        error_code: 'INBOX_ITEM_ALREADY_CONVERTED',
        details: { inbox_item_id: 'item-1', supplier_invoice_id: 'invoice-1' },
      },
    })
    // An operation being approved right now ('committing') is not touched.
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'pending'],
      ['operation_type', 'create_supplier_invoice_from_inbox'],
    ])
    expect(mock.findCall('pending_operations', 'contains')).toEqual(['params', { inbox_item_id: 'item-1' }])
  })

  it('never fails the conversion it follows', async () => {
    const failing = createQueuedMockSupabase()
    failing.enqueue({ error: { message: 'permission denied' } })
    expect(await rejectSupersededInboxConversions(failing.supabase as never, 'company-1', 'item-1', 'invoice-1')).toBe(0)
  })
})

describe('converting an inbox item in the dashboard or through v1', () => {
  it('rejects the staged registration of the same item, naming the invoice it became', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    mock.enqueue({ data: makeSupplier({ id: SUPPLIER }) })
    mock.enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) }) // no registration verifikat
    mock.enqueue({ data: 42 }) // ankomstnummer
    mock.enqueue({ data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } })
    mock.enqueue({ data: [{ id: 'row-1', sort_order: 0 }] }) // items
    mock.enqueue({ data: null }) // inbox item stamped
    mock.enqueue({ data: [{ id: 'op-1' }] }) // the agent's staged operation

    expect((await convert(mock)).ok).toBe(true)
    expect(mock.findCall('pending_operations', 'update')?.[0]).toMatchObject({
      status: 'rejected',
      result_data: { details: { inbox_item_id: 'item-1', supplier_invoice_id: 'invoice-1' } },
    })
  })

  it('rejects nothing when the conversion did not happen: an item already converted, a dry run', async () => {
    const converted = createQueuedMockSupabase()
    converted.enqueue({ data: makeInvoiceInboxItem({ status: 'received', created_supplier_invoice_id: 'invoice-0' }) })
    expect(await convert(converted)).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED' })
    expect(converted.findCall('pending_operations', 'update')).toBeUndefined()

    const preview = createQueuedMockSupabase()
    preview.enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    preview.enqueue({ data: makeSupplier({ id: SUPPLIER }) })
    preview.enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    expect(await convert(preview, true)).toMatchObject({ ok: true, dryRun: true })
    expect(preview.findCall('pending_operations', 'update')).toBeUndefined()
  })
})
