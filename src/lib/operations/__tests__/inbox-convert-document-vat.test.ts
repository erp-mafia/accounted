/**
 * The inbox convert books VAT per rate as the document has it, the same rule
 * as createSupplierInvoice (lib/vat/document-vat.ts, crm#1367): the VAT on the
 * summed base of each rate, or the stated vat_breakdown, spread over the lines.
 * It also keeps a line's own vat_amount, which it used to drop silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const refuseWhenPairBookedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations/inbox-pair-guard', () => ({
  refuseWhenPairBooked: (...args: unknown[]) => refuseWhenPairBookedMock(...args),
}))

import { createLogger } from '@/lib/logger'
import {
  createQueuedMockSupabase,
  makeCompanySettings,
  makeInvoiceInboxItem,
  makeSupplier,
} from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'
import type { SupabaseClient } from '@supabase/supabase-js'

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'

const SELF_BILL_LINES = [
  { description: 'Flexintäkt', amount: 17564.15, account_number: '4010', vat_rate: 0.25 },
  { description: 'Handelsavgift', amount: -2107.7, account_number: '4010', vat_rate: 0.25 },
]

function body(overrides: Record<string, unknown> = {}) {
  return CreateSupplierInvoiceSchema.parse({
    supplier_id: SUPPLIER_UUID,
    supplier_invoice_number: 'SF-CE-202608',
    invoice_date: '2026-09-30',
    due_date: '2026-10-30',
    items: SELF_BILL_LINES,
    ...overrides,
  })
}

function ctx(supabase: unknown) {
  return {
    supabase: supabase as SupabaseClient,
    companyId: 'company-1',
    userId: 'user-1',
    log: createLogger('inbox-convert-document-vat-test'),
  }
}

async function preview(input: ReturnType<typeof body>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
  enqueue({ data: makeSupplier({ id: SUPPLIER_UUID, supplier_type: 'swedish_business' }) })
  enqueue({ data: makeCompanySettings({ accounting_method: 'accrual', defer_invoice_booking: true, vat_registered: true }) })
  return convertInboxItemToSupplierInvoice(ctx(supabase), 'item-1', input, { dryRun: true, emit: vi.fn() })
}

type PreviewItem = { vat_amount: number }

describe('inbox convert: VAT as the document states it (crm#1367)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refuseWhenPairBookedMock.mockResolvedValue(null)
  })

  it('books the VAT on the summed base per rate: 3 864,11, not 3 864,12 line by line', async () => {
    const outcome = await preview(body())

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry-run preview')
    expect(outcome.preview).toMatchObject({ subtotal: 15456.45, vat_amount: 3864.11, total: 19320.56 })
    expect((outcome.preview.items as PreviewItem[]).map((i) => i.vat_amount)).toEqual([4391.04, -526.93])
    expect(outcome.preview.vat_by_rate).toEqual([{ rate: 0.25, base: 15456.45, vat: 3864.11, source: 'computed' }])
  })

  it('books the stated vat_breakdown within the per-line rounding', async () => {
    const outcome = await preview(body({ vat_breakdown: [{ vat_rate: 0.25, vat_amount: 3864.12 }] }))

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry-run preview')
    expect(outcome.preview).toMatchObject({ vat_amount: 3864.12, total: 19320.57 })
  })

  it('refuses a vat_breakdown the lines cannot carry', async () => {
    const outcome = await preview(body({ vat_breakdown: [{ vat_rate: 0.12, vat_amount: 10 }] }))

    expect(outcome).toMatchObject({ ok: false, code: 'VAT_BREAKDOWN_MISMATCH', details: { reason: 'rate_not_on_lines' } })
  })

  it('keeps a line\'s own vat_amount instead of dropping it', async () => {
    const outcome = await preview(body({
      items: [{ description: 'Bil', amount: 1000, account_number: '5611', vat_rate: 0.25, vat_amount: 125 }],
    }))

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry-run preview')
    expect((outcome.preview.items as PreviewItem[])[0].vat_amount).toBe(125)
    expect(outcome.preview.vat_amount).toBe(125)
  })
})
