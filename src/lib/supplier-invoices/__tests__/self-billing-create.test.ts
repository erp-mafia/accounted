/**
 * Självfaktura on the purchase side (crm#1367): createSupplierInvoice with
 * is_self_billed. The number is the database's (assign_self_billing_number),
 * the parties are frozen on the row, the document is archived after the
 * registration, and what the document cannot lawfully carry yet is refused
 * before anything is drawn or written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeSupplier } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mockRegistrationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries',
  )
  return {
    ...actual,
    createSupplierInvoiceRegistrationEntry: (...args: unknown[]) => mockRegistrationEntry(...args),
  }
})

const mockArchive = vi.fn()
vi.mock('@/lib/supplier-invoices/self-billing/archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supplier-invoices/self-billing/archive')>(
    '@/lib/supplier-invoices/self-billing/archive',
  )
  return { ...actual, archiveSelfBillingDocument: (...args: unknown[]) => mockArchive(...args) }
})

import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '../create'

const SUPPLIER_ID = '550e8400-e29b-41d4-a716-446655440000'
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger

const SETTINGS = {
  accounting_method: 'accrual',
  vat_registered: true,
  company_name: 'Exempelbolaget AB',
  org_number: '5566778899',
  vat_number: 'SE556677889901',
  address_line1: 'Storgatan 1',
  address_line2: null,
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  self_billing_acceptance_text: null,
}

const CREATED = {
  id: 'invoice-1',
  supplier_invoice_number: 'SF-007',
  self_billing_number: 7,
  arrival_number: 12,
  invoice_date: '2026-09-30',
  due_date: '2026-10-30',
  delivery_date: null,
  currency: 'SEK',
  is_self_billed: true,
}

let db: ReturnType<typeof createTableMockSupabase>

function setUp(card: Record<string, unknown> = {}, settings: Record<string, unknown> = SETTINGS) {
  db = createTableMockSupabase({
    suppliers: {
      data: makeSupplier({
        id: SUPPLIER_ID,
        name: 'Exempel Energi AB',
        vat_number: 'SE559988776601',
        self_billing_agreement_ref: 'Flexavtal 2026',
        default_payment_terms: 30,
        ...card,
      }),
    },
    company_settings: { data: settings },
    'rpc:get_next_arrival_number': { data: 12 },
    supplier_invoices: { data: CREATED },
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

const ctx = () => ({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })

function body(overrides: Partial<CreateSupplierInvoiceInput> = {}): CreateSupplierInvoiceInput {
  return {
    supplier_id: SUPPLIER_ID,
    is_self_billed: true,
    invoice_date: '2026-09-30',
    items: [
      { description: 'Flexintäkt augusti', amount: 17564.15, account_number: '4010', vat_rate: 0.25 },
      { description: 'Handelsavgift', amount: -2107.7, account_number: '4010', vat_rate: 0.25 },
    ],
    ...overrides,
  } as CreateSupplierInvoiceInput
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRegistrationEntry.mockResolvedValue({ id: 'je-1' })
  mockArchive.mockResolvedValue('doc-1')
})

describe('createSupplierInvoice: självfaktura', () => {
  it('previews a self-billing invoice with the supplier\'s agreement and terms, drawing nothing', async () => {
    setUp()
    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({
      is_self_billed: true,
      supplier_invoice_number: null,
      self_billing_number: null,
      self_billing_agreement_ref: 'Flexavtal 2026',
      // invoice_date + the supplier's 30 days
      due_date: '2026-10-30',
    })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(db.calls.filter((c) => ['insert', 'update', 'delete'].includes(c.method))).toEqual([])
  })

  it('inserts without a number, with the agreement and the frozen parties, then archives the document', async () => {
    setUp()
    const result = await createSupplierInvoice(ctx(), body({ self_billing_agreement_ref: 'Avtal 2026-03' }))

    if (!result.ok || result.dryRun) throw new Error('expected a registration')
    const inserted = db.payloads('supplier_invoices', 'insert')[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      is_self_billed: true,
      supplier_invoice_number: null,
      self_billing_agreement_ref: 'Avtal 2026-03',
    })
    expect(inserted.self_billing_snapshot).toMatchObject({
      v: 1,
      seller: { name: 'Exempel Energi AB', vat_number: 'SE559988776601' },
      buyer: { name: 'Exempelbolaget AB', org_number: '5566778899' },
      agreement_ref: 'Avtal 2026-03',
      pay_to: { bankgiro: '123-4567' },
      credits: null,
    })
    expect(mockArchive).toHaveBeenCalledTimes(1)
    expect(mockArchive.mock.calls[0][1]).toMatchObject({
      supplierInvoiceId: 'invoice-1',
      journalEntryId: 'je-1',
      invoice: { supplier_invoice_number: 'SF-007', is_credit_note: false },
    })
    expect(result.invoice.document_id).toBe('doc-1')
    expect(result.warnings.map((w) => w.code)).not.toContain('SELF_BILL_DOCUMENT_ARCHIVE_FAILED')
  })

  it('warns, and keeps the registration, when the document could not be archived', async () => {
    setUp()
    mockArchive.mockResolvedValue(null)
    const result = await createSupplierInvoice(ctx(), body())

    if (!result.ok || result.dryRun) throw new Error('expected a registration')
    expect(result.warnings.map((w) => w.code)).toContain('SELF_BILL_DOCUMENT_ARCHIVE_FAILED')
  })

  it('refuses without an agreement on the body or the supplier card', async () => {
    setUp({ self_billing_agreement_ref: null })
    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })
    expect(result).toMatchObject({ ok: false, code: 'SI_SELF_BILL_AGREEMENT_MISSING' })
  })

  it('refuses reverse charge, another currency and a document of the supplier\'s', async () => {
    setUp({ supplier_type: 'eu_business' })
    expect(await createSupplierInvoice(ctx(), body(), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'SI_SELF_BILL_UNSUPPORTED',
      details: { reason: 'reverse_charge' },
    })

    setUp()
    expect(await createSupplierInvoice(ctx(), body({ currency: 'EUR' }), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'SI_SELF_BILL_UNSUPPORTED',
      details: { reason: 'currency' },
    })
    expect(
      await createSupplierInvoice(ctx(), body({ document_id: '550e8400-e29b-41d4-a716-446655440009' }), { dryRun: true }),
    ).toMatchObject({ ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: 'document_id' } })
  })

  it('names every party field the document needs and lacks, before anything is drawn', async () => {
    setUp({ vat_number: null, address_line1: null }, { ...SETTINGS, org_number: null })
    const result = await createSupplierInvoice(ctx(), body())
    expect(result).toMatchObject({
      ok: false,
      code: 'SI_SELF_BILL_PARTY_INCOMPLETE',
      details: { missing: ['seller.address', 'seller.vat_number', 'buyer.org_number'] },
    })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('createSupplierInvoice: due date default', () => {
  it('takes invoice_date + the supplier\'s payment terms when the body has no due date', async () => {
    setUp({ default_payment_terms: 10 })
    const result = await createSupplierInvoice(
      ctx(),
      body({ is_self_billed: undefined, supplier_invoice_number: 'LF-1' }),
      { dryRun: true },
    )
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.due_date).toBe('2026-10-10')
    expect(result.preview.is_self_billed).toBe(false)
  })

  it('keeps a due date the caller gave', async () => {
    setUp()
    const result = await createSupplierInvoice(
      ctx(),
      body({ is_self_billed: undefined, supplier_invoice_number: 'LF-1', due_date: '2026-11-15' }),
      { dryRun: true },
    )
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.due_date).toBe('2026-11-15')
  })
})
