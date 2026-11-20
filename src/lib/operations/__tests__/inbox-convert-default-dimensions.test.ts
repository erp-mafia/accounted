/**
 * The Inkorg's convert door takes the supplier's default dimension bag when
 * the request names none (accounted#144). This door is behind the Inkorg
 * editor, its one click, register-and-settle and the v1 inbox convert, so
 * one test here covers every path that registers an inbox item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/operations/inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))

import { createLogger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'

const SUPPLIER_ID = '00000000-0000-4000-8000-000000000001'

const { supabase, setTable, reset } = createTableMockSupabase()
const ctx = { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }

function body(extra: Record<string, unknown> = {}) {
  return CreateSupplierInvoiceSchema.parse({
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'EL-2026-10',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    items: [{ description: 'El oktober', amount: 800, account_number: '5020', vat_rate: 0.25 }],
    ...extra,
  })
}

beforeEach(() => {
  reset()
  setTable('invoice_inbox_items', { data: makeInvoiceInboxItem({ status: 'received' }) })
  setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID, default_dimensions: { '1': 'FAST01' } }) })
  setTable('company_settings', { data: makeCompanySettings({ accounting_method: 'accrual' }) })
})

describe('convertInboxItemToSupplierInvoice: the supplier default dimensions', () => {
  it("registers the invoice with the supplier's default when the request names none", async () => {
    const outcome = await convertInboxItemToSupplierInvoice(ctx, 'item-1', body(), { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { default_dimensions: { '1': 'FAST01' } } })
  })

  it('keeps a bag the request sends, {} included', async () => {
    const own = await convertInboxItemToSupplierInvoice(ctx, 'item-1', body({ default_dimensions: { '6': 'P001' } }), { dryRun: true })
    expect(own).toMatchObject({ ok: true, preview: { default_dimensions: { '6': 'P001' } } })
    const none = await convertInboxItemToSupplierInvoice(ctx, 'item-1', body({ default_dimensions: {} }), { dryRun: true })
    expect(none).toMatchObject({ ok: true, preview: { default_dimensions: {} } })
  })
})
