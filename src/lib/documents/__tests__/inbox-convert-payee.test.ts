/**
 * The inbox path (scan, mail, Peppol) runs the payee check at registration:
 * the invoice keeps the account its document states, and a supplier card
 * that has other accounts is never backfilled with a new one (it would
 * become the card's payment account without anyone approving it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({ createSupplierInvoiceRegistrationEntry: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'
const BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: SUPPLIER_UUID,
  supplier_invoice_number: 'F-2026-001',
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  items: [{ description: 'Konsulttjänster', amount: 10000, account_number: '6200', vat_rate: 0.25 }],
})

let db: ReturnType<typeof createTableMockSupabase>

function setUp(card: Record<string, unknown>) {
  db = createTableMockSupabase({
    invoice_inbox_items: { data: makeInvoiceInboxItem({ id: 'item-1', extracted_data: { supplier: { name: 'Derome Bygg AB', bankgiro: '9020-0007' } } as never }) },
    suppliers: { data: makeSupplier({ id: SUPPLIER_UUID, bankgiro: null, ...card }) },
    // Kontantmetoden: no registration verifikat, so the test stays on the payee.
    company_settings: { data: makeCompanySettings({ accounting_method: 'cash' }) },
    'rpc:get_next_arrival_number': { data: 42 },
    supplier_invoices: { data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } },
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

async function convert() {
  return convertInboxItemToSupplierInvoice(
    { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-payee-test') },
    'item-1',
    BODY,
    { emit: vi.fn().mockResolvedValue(undefined) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('inbox convert: the account the document states', () => {
  it('keeps a changed account on the invoice, leaves the card alone and says why the payment waits', async () => {
    setUp({ bankgiro: '5050-1055' })
    const outcome = await convert()

    expect(outcome).toMatchObject({ ok: true, warnings: [{ code: 'SUPPLIER_PAYEE_CHANGED' }] })
    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject({ payee_bankgiro: '9020-0007', payee_plusgiro: null, payee_iban: null })
    expect(db.payloads('suppliers', 'update')).toEqual([])
  })

  it('fills a card that has no account for a supplier never paid, without a warning', async () => {
    setUp({})
    const outcome = await convert()

    expect(outcome.ok).toBe(true)
    expect(outcome).not.toHaveProperty('warnings')
    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject({ payee_bankgiro: '9020-0007' })
    expect(db.payloads('suppliers', 'update')).toEqual([{ bankgiro: '9020-0007', plusgiro: null, iban: null, bic: null }])
  })

  it('touches nothing on a dry run', async () => {
    setUp({ bankgiro: '5050-1055' })
    const outcome = await convertInboxItemToSupplierInvoice(
      { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-payee-test') },
      'item-1',
      BODY,
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: true, dryRun: true })
    expect(db.payloads('suppliers', 'update')).toEqual([])
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
  })
})
