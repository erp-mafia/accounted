/**
 * The manual path (POST /api/supplier-invoices and v1) runs the payee check
 * at registration like the inbox path: the invoice keeps the account its
 * document states, a supplier card with other accounts is never backfilled
 * with a new one, and a card without accounts is (for a supplier never paid).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mockRegisterExpenseClaim = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  registerExpenseClaim: (...args: unknown[]) => mockRegisterExpenseClaim(...args),
}))
vi.mock('@/lib/suggestion-log/inbox', () => ({
  snapshotInboxExtraction: vi.fn().mockResolvedValue(null),
  recordInboxDecision: vi.fn().mockResolvedValue(undefined),
  loadEntryLines: vi.fn().mockResolvedValue([]),
}))

import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '../create'

const SUPPLIER_ID = '550e8400-e29b-41d4-a716-446655440000'
const ITEM_ID = '550e8400-e29b-41d4-a716-446655440001'
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger

let db: ReturnType<typeof createTableMockSupabase>

const CREATED = { data: { id: 'invoice-1', supplier_invoice_number: 'LF-1', arrival_number: 7, invoice_date: '2024-06-01' } }

/** `paidHistory`: what the supplier's paid invoices read answers, when the card is empty and the check asks. */
function setUp(card: Record<string, unknown>, paidHistory?: unknown[]) {
  db = createTableMockSupabase({
    invoice_inbox_items: { data: makeInvoiceInboxItem({ id: ITEM_ID, extracted_data: { supplier: { bankgiro: '9020-0007' } } as never }) },
    suppliers: { data: makeSupplier({ id: SUPPLIER_ID, bankgiro: null, ...card }) },
    company_settings: { data: { accounting_method: 'accrual', vat_registered: true } },
    companies: { data: { entity_type: 'aktiebolag' } },
    'rpc:get_next_arrival_number': { data: 7 },
    supplier_invoices: paidHistory ? [{ data: paidHistory }, CREATED] : CREATED,
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

function body(): CreateSupplierInvoiceInput {
  return {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'LF-1',
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    paid_with_private_funds: true,
    inbox_item_id: ITEM_ID,
    items: [{ description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25 }],
  } as CreateSupplierInvoiceInput
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRegisterExpenseClaim.mockResolvedValue({
    ok: true,
    claim: { id: 'claim-1', claimant_name: 'Ägaren', liability_account: '2893', journal_entry_id: null },
  })
})

describe('createSupplierInvoice: the account the document states', () => {
  it('keeps a changed account on the invoice and leaves the supplier card alone', async () => {
    setUp({ bankgiro: '5050-1055' })
    const result = await createSupplierInvoice({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log }, body())

    expect(result.ok).toBe(true)
    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject({ payee_bankgiro: '9020-0007', paid_with_private_funds: true })
    expect(db.payloads('suppliers', 'update')).toEqual([])
    // Settled by the person who paid: nothing waits for a payment, so no payee warning.
    if (result.ok && !result.dryRun) expect(result.warnings.map((w) => w.code)).not.toContain('SUPPLIER_PAYEE_CHANGED')
  })

  it('fills an empty card for a supplier never paid', async () => {
    setUp({}, [])
    const result = await createSupplierInvoice({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log }, body())

    expect(result.ok).toBe(true)
    expect(db.payloads('suppliers', 'update')).toEqual([{ bankgiro: '9020-0007', plusgiro: null, iban: null, bic: null }])
  })

  it('leaves an empty card alone for a supplier paid before: that account waits for a person', async () => {
    setUp({}, [{ id: 'older', supplier_id: SUPPLIER_ID }])
    const result = await createSupplierInvoice({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log }, body())

    expect(result.ok).toBe(true)
    expect(db.payloads('suppliers', 'update')).toEqual([])
    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject({ payee_bankgiro: '9020-0007' })
  })
})
