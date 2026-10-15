/**
 * accounted#15: every door that registers a supplier invoice from an inbox
 * item stores the same account the document states, from the same reading
 * of its extraction (inboxStatedPaymentDetails). The MCP approval used to
 * store only what the supplier card lacked, so an account that differs from
 * the card was lost and its payment went to the card's account unchecked.
 *
 * One extraction and one supplier card, three doors: the dashboard and v1
 * convert (convertInboxItemToSupplierInvoice), the privately paid create
 * (createSupplierInvoice with inbox_item_id) and the MCP approval
 * (commitPendingOperation on create_supplier_invoice_from_inbox).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>()),
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))
vi.mock('@/lib/suggestion-log/inbox', () => ({
  snapshotInboxExtraction: vi.fn().mockResolvedValue(null),
  recordInboxDecision: vi.fn().mockResolvedValue(undefined),
  loadEntryLines: vi.fn().mockResolvedValue([]),
}))
const mockRegisterExpenseClaim = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  registerExpenseClaim: (...args: unknown[]) => mockRegisterExpenseClaim(...args),
}))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '@/lib/documents/inbox-convert'
import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '@/lib/supplier-invoices/create'
import { commitPendingOperation } from '@/lib/pending-operations/commit'

const SUPPLIER_ID = '00000000-0000-4000-8000-000000000001'
const ITEM_ID = '00000000-0000-4000-8000-000000000002'

/** What the scan read: a bankgiro, an IBAN with spaces and a BIC. */
const EXTRACTED = {
  supplier: { name: 'Derome Bygg AB', bankgiro: '9020-0007', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'ESSESESS' },
}

/** The columns every door must store: validated, the IBAN without spaces. */
const STATED = {
  payee_bankgiro: '9020-0007',
  payee_plusgiro: null,
  payee_iban: 'SE4550000000058398257466',
  payee_bic: 'ESSESESS',
}

let db: ReturnType<typeof createTableMockSupabase>

/** `cardBankgiro`: the supplier card's bankgiro; it pays another one than the invoice states unless they match. */
function setUp(cardBankgiro: string | null) {
  db = createTableMockSupabase({
    pending_operations: { data: { id: 'op-1' } },
    invoice_inbox_items: {
      data: makeInvoiceInboxItem({ id: ITEM_ID, created_supplier_invoice_id: null, extracted_data: EXTRACTED as never }),
    },
    suppliers: { data: makeSupplier({ id: SUPPLIER_ID, bankgiro: cardBankgiro, plusgiro: null, iban: null }) },
    // Kontantmetoden: no registration verifikat, so every door stays on the payee.
    company_settings: { data: makeCompanySettings({ accounting_method: 'cash' }) },
    companies: { data: { entity_type: 'aktiebolag' } },
    'rpc:get_next_arrival_number': { data: 42 },
    supplier_invoices: { data: { id: 'invoice-1', status: 'registered', arrival_number: 42, registration_journal_entry_id: null } },
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

const ctx = () => ({
  supabase: db.supabase as unknown as SupabaseClient,
  companyId: 'company-1',
  userId: 'user-1',
  log: createLogger('inbox-payee-parity-test'),
})

async function dashboardConvert() {
  const body = CreateSupplierInvoiceSchema.parse({
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'F-2026-001',
    invoice_date: '2026-09-15',
    due_date: '2026-10-15',
    items: [{ description: 'Konsulttjänster', amount: 1000, account_number: '6200', vat_rate: 0.25 }],
  })
  const outcome = await convertInboxItemToSupplierInvoice(ctx(), ITEM_ID, body, { emit: vi.fn().mockResolvedValue(undefined) })
  expect(outcome.ok).toBe(true)
  return outcome
}

async function privatelyPaidCreate() {
  const result = await createSupplierInvoice(ctx(), {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'F-2026-001',
    invoice_date: '2026-09-15',
    due_date: '2026-10-15',
    paid_with_private_funds: true,
    inbox_item_id: ITEM_ID,
    items: [{ description: 'Konsulttjänster', amount: 1000, account_number: '6200', vat_rate: 0.25 }],
  } as CreateSupplierInvoiceInput)
  expect(result.ok).toBe(true)
  return result
}

async function mcpApproval() {
  const op = {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_supplier_invoice_from_inbox',
    status: 'pending',
    title: 'test',
    // As gnubok_create_supplier_invoice_from_inbox stages it: nothing payee-shaped.
    params: {
      inbox_item_id: ITEM_ID,
      supplier_id: SUPPLIER_ID,
      document_id: null,
      supplier_invoice_number: 'F-2026-001',
      invoice_date: '2026-09-15',
      due_date: '2026-10-15',
      currency: 'SEK',
      exchange_rate: null,
      vat_treatment: 'standard_25',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      notes: null,
      items: [{ description: 'Konsulttjänster', quantity: 1, unit: 'st', unit_price: 1000, line_total: 1000, account_number: '6200', vat_rate: 0.25, vat_amount: 250 }],
    },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-09-15T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-15T00:00:00Z',
  } as unknown as PendingOperation
  const result = await commitPendingOperation(db.supabase as never, 'user-1', 'company-1', op)
  expect(result.status).toBe('committed')
  return result
}

const DOORS = [
  ['dashboard and v1 convert', dashboardConvert],
  ['privately paid create', privatelyPaidCreate],
  ['MCP approval', mcpApproval],
] as const

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockRegisterExpenseClaim.mockResolvedValue({
    ok: true,
    claim: { id: 'claim-1', claimant_name: 'Ägaren', liability_account: '2893', journal_entry_id: null },
  })
})

describe('inbox supplier invoices: every door stores the account the document states', () => {
  it.each(DOORS)('%s: a bankgiro that differs from the card is stored on the invoice and never written to the card', async (_door, run) => {
    setUp('5050-1055')
    await run()

    const insert = db.payloads('supplier_invoices', 'insert')[0] as Record<string, unknown>
    expect({
      payee_bankgiro: insert.payee_bankgiro,
      payee_plusgiro: insert.payee_plusgiro,
      payee_iban: insert.payee_iban,
      payee_bic: insert.payee_bic,
    }).toEqual(STATED)
    expect(db.payloads('suppliers', 'update')).toEqual([])
  })

  it.each(DOORS)('%s: the same account as the card is stored too, and the card only gains what it lacks', async (_door, run) => {
    setUp('9020-0007')
    await run()

    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject(STATED)
    expect(db.payloads('suppliers', 'update')).toEqual([
      { bankgiro: '9020-0007', plusgiro: null, iban: 'SE4550000000058398257466', bic: 'ESSESESS' },
    ])
  })
})
