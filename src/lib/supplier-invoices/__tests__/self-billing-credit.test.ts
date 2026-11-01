/**
 * Correcting a självfaktura (crm#1367): it is credited with our own credit
 * note, numbered from the same series by the database, under the original's
 * agreement, naming the invoice it credits; and it is never deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const createCreditEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>('@/lib/bookkeeping/supplier-invoice-entries')
  return { ...actual, createSupplierCreditNoteEntry: (...args: unknown[]) => createCreditEntryMock(...args) }
})
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: vi.fn().mockResolvedValue({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0 }),
}))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-21',
}))
const mockArchive = vi.fn()
vi.mock('@/lib/supplier-invoices/self-billing/archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supplier-invoices/self-billing/archive')>(
    '@/lib/supplier-invoices/self-billing/archive',
  )
  return { ...actual, archiveSelfBillingDocument: (...args: unknown[]) => mockArchive(...args) }
})

import { creditSupplierInvoice } from '../credit'
import { deleteSupplierInvoice } from '../manage'

const { supabase, setTable, reset, findCall, calls } = createTableMockSupabase()
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger
const ctx = () => ({ supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })
const emit = vi.fn().mockResolvedValue(undefined)

const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111'

const SNAPSHOT = {
  v: 1,
  seller: { name: 'Exempel Energi AB', org_number: '5599887766', vat_number: 'SE559988776601', address_line1: 'Bruksvägen 2', address_line2: null, postal_code: '662 30', city: 'Åmål', country: 'SE' },
  buyer: { name: 'Exempelbolaget AB', org_number: '5566778899', vat_number: null, address_line1: 'Storgatan 1', address_line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE' },
  pay_to: { bankgiro: '5050-1055', plusgiro: null, iban: null, bic: null, clearing_number: null, account_number: null },
  agreement_ref: 'Flexavtal 2026',
  acceptance_text: 'Godkänd enligt avtalet.',
  credits: null,
}

const original = {
  ...makeSupplierInvoice({
    id: ORIGINAL_ID,
    supplier_invoice_number: 'SF-007',
    invoice_date: '2026-09-30',
    status: 'approved',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    remaining_amount: 1250,
  }),
  is_self_billed: true,
  self_billing_number: 7,
  self_billing_agreement_ref: 'Flexavtal 2026',
  self_billing_snapshot: SNAPSHOT,
  supplier: { id: 'supplier-1', name: 'Exempel Energi AB', supplier_type: 'swedish_business' },
  items: [
    {
      id: 'item-1', supplier_invoice_id: ORIGINAL_ID, sort_order: 0, description: 'Flex', quantity: 1, unit: 'st',
      unit_price: 1000, line_total: 1000, account_number: '4010', vat_code: null, vat_rate: 0.25, vat_amount: 250,
      reverse_charge_rate: null, apply_slp: false, dimensions: {},
    },
  ],
}

const creditNoteRow = makeSupplierInvoice({
  id: 'credit-1',
  arrival_number: 13,
  is_credit_note: true,
  credited_invoice_id: ORIGINAL_ID,
  supplier_invoice_number: 'SF-008',
  invoice_date: '2026-10-21',
  status: 'credited',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  createCreditEntryMock.mockResolvedValue({ id: 'je-credit' })
  mockArchive.mockResolvedValue('doc-credit')
  setTable('supplier_invoices', [
    { data: original },
    { data: creditNoteRow },
    { data: null }, // link the verifikat to the credit note
    { data: { id: ORIGINAL_ID } }, // flip the original
  ])
  setTable('company_settings', { data: { accounting_method: 'accrual', bookkeeping_locked_through: null } })
  setTable('fiscal_periods', { data: { id: 'fp-1', is_closed: false, locked_at: null } })
  setTable('rpc:get_next_arrival_number', { data: 13 })
  setTable('supplier_invoice_items', { data: null })
})

describe('creditSupplierInvoice: självfaktura', () => {
  it('inserts our own credit note: no number (the series assigns it), the agreement, and the invoice it credits', async () => {
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })

    expect(outcome.ok).toBe(true)
    const row = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(row).toMatchObject({
      supplier_invoice_number: null,
      is_self_billed: true,
      self_billing_agreement_ref: 'Flexavtal 2026',
      is_credit_note: true,
      credited_invoice_id: ORIGINAL_ID,
    })
    expect(row.self_billing_snapshot).toEqual({ ...SNAPSHOT, credits: { number: 'SF-007', invoice_date: '2026-09-30' } })
    expect(mockArchive).toHaveBeenCalledTimes(1)
    expect(mockArchive.mock.calls[0][1]).toMatchObject({
      supplierInvoiceId: 'credit-1',
      journalEntryId: 'je-credit',
      invoice: { supplier_invoice_number: 'SF-008', is_credit_note: true },
    })
    if (outcome.ok && !('dryRun' in outcome && outcome.dryRun)) {
      expect((outcome as { data: { credit_note: { document_id: string | null } } }).data.credit_note.document_id).toBe('doc-credit')
    }
  })

  it('refuses a supplier credit note number, document or inbox item for it', async () => {
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, { supplier_credit_note_number: 'K-1' }, { emit })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: 'credit_input' } })
    expect(calls.filter((c) => c.method === 'insert')).toEqual([])
  })
})

describe('deleteSupplierInvoice: självfaktura', () => {
  it('refuses to delete an issued self-billing invoice', async () => {
    setTable('supplier_invoices', {
      data: { status: 'registered', registration_journal_entry_id: null, is_credit_note: false, is_self_billed: true },
    })
    const outcome = await deleteSupplierInvoice(ctx(), ORIGINAL_ID)
    expect(outcome).toMatchObject({ ok: false, code: 'SI_DELETE_SELF_BILLED' })
    expect(calls.filter((c) => c.method === 'delete')).toEqual([])
  })
})
