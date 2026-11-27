/**
 * An inbox item whose supplier invoice was credited is registered again: the
 * conversion takes it (no INBOX_ITEM_ALREADY_CONVERTED, no
 * INBOX_ITEM_ALREADY_BOOKED for the credited verifikat its document stays
 * on), the new registration gets a byte-identical copy of the document, and
 * the item names the new invoice. An item whose invoice still stands is
 * refused as before. The same conversion runs on real Postgres in
 * tests/pg/credited-underlag-registers-again.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  createTableMockSupabase,
  makeCompanySettings,
  makeInvoiceInboxItem,
  makeSupplier,
  type TableMockResolver,
} from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>()),
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/chart-vat-treatments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/chart-vat-treatments')>()),
  fetchChartVatTreatments: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('../inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))
vi.mock('@/lib/supplier-invoices/credit-target', () => ({ resolveInboxCreditTarget: vi.fn(async () => null) }))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: vi.fn(async () => ({})),
}))
vi.mock('@/lib/documents/link-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/link-document')>()),
  linkDocumentCopyToVoucher: vi.fn(async () => ({ ok: true, document: { id: 'copy-1' }, source_document_id: 'doc-1', reused: false })),
  archiveDocumentCopy: vi.fn(async () => ({ id: 'copy-floating' })),
}))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { archiveDocumentCopy, linkDocumentCopyToVoucher } from '@/lib/documents/link-document'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'

const RIGHT_SUPPLIER = '00000000-0000-4000-8000-000000000002'

const BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: RIGHT_SUPPLIER,
  supplier_invoice_number: 'F-2041',
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  items: [{ description: 'Konsulttjänster', amount: 1000, account_number: '6200', vat_rate: 0.25 }],
})

const has = (chain: { method: string; args: unknown[] }[], method: string, ...args: unknown[]) =>
  chain.some((c) => c.method === method && args.every((arg, i) => c.args[i] === arg))

/**
 * The credited invoice the item was registered as (si-credited, booked on
 * je-credited, where its document stays), and the one this conversion
 * inserts (si-new).
 */
function supplierInvoices(creditedStatus: string): TableMockResolver {
  return (chain) => {
    if (has(chain, 'insert')) return { data: { id: 'si-new', status: 'registered', registration_journal_entry_id: null, document_id: 'doc-1' } }
    if (has(chain, 'update')) return { data: null }
    if (has(chain, 'eq', 'id', 'si-credited')) return { data: { id: 'si-credited', status: creditedStatus, is_credit_note: false } }
    if (has(chain, 'eq', 'registration_journal_entry_id', 'je-credited')) {
      return { data: [{ id: 'si-credited', status: creditedStatus, is_credit_note: false }] }
    }
    return { data: null }
  }
}

let db: ReturnType<typeof createTableMockSupabase>

function setUp(options: { creditedStatus?: string; settings?: Record<string, unknown> } = {}) {
  db = createTableMockSupabase({
    invoice_inbox_items: (chain) =>
      has(chain, 'update')
        ? { data: null }
        : {
            data: {
              ...makeInvoiceInboxItem({ id: 'item-1', document_id: 'doc-1', created_supplier_invoice_id: 'si-credited' }),
              document_hold: { journal_entry_id: 'je-credited', entry: { status: 'posted' } },
            },
          },
    suppliers: { data: makeSupplier({ id: RIGHT_SUPPLIER, name: 'Rätt Leverantör AB', supplier_type: 'swedish_business' }) },
    company_settings: { data: makeCompanySettings(options.settings ?? { accounting_method: 'accrual', vat_registered: true }) },
    'rpc:get_next_arrival_number': { data: 43 },
    supplier_invoices: supplierInvoices(options.creditedStatus ?? 'credited'),
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

const convert = (options: { dryRun?: boolean } = {}) =>
  convertInboxItemToSupplierInvoice(
    { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-registers-again-test') },
    'item-1',
    BODY,
    { emit: vi.fn().mockResolvedValue(undefined), ...options },
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValue({ id: 'je-new' } as never)
})

describe('an inbox item whose supplier invoice was credited', () => {
  it('is registered again: the new verifikat gets a copy of the document, and the item names the new invoice', async () => {
    setUp()
    const outcome = await convert()
    expect(outcome.ok).toBe(true)

    expect(linkDocumentCopyToVoucher).toHaveBeenCalledWith(
      db.supabase,
      'company-1',
      'user-1',
      { document_id: 'doc-1', journal_entry_id: 'je-new' },
      expect.objectContaining({ linkBasis: expect.objectContaining({ link_basis: expect.any(String) }) }),
    )
    // The original stays on the credited verifikat: it is never linked again.
    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(db.payloads('supplier_invoices', 'update')).toContainEqual({ document_id: 'copy-1' })
    expect(db.payloads('invoice_inbox_items', 'update')).toEqual([{ created_supplier_invoice_id: 'si-new' }])
  })

  it('a company that books later gets a copy on no verifikat yet, for the booking to anchor', async () => {
    setUp({ settings: { accounting_method: 'accrual', vat_registered: true, defer_invoice_booking: true } })
    const outcome = await convert()
    expect(outcome.ok).toBe(true)
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(archiveDocumentCopy).toHaveBeenCalledWith(db.supabase, 'company-1', 'user-1', 'doc-1', 'supplier-invoice:si-new')
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
    expect(db.payloads('supplier_invoices', 'update')).toContainEqual({ document_id: 'copy-floating' })
  })

  it('the dry run says it registers the underlag again, with a copy, and writes nothing', async () => {
    setUp()
    const outcome = await convert({ dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview.registers_again).toEqual({ released_supplier_invoice_id: 'si-credited', copies_document: true })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
  })
})

describe('an inbox item whose supplier invoice still stands', () => {
  it('is refused as already converted, and nothing is written', async () => {
    setUp({ creditedStatus: 'approved' })
    const outcome = await convert()
    expect(outcome).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED', details: { supplier_invoice_id: 'si-credited' } })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
    expect(db.payloads('invoice_inbox_items', 'update')).toEqual([])
  })
})
