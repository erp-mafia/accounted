/**
 * The dry run of an inbox conversion, asked for its verifikat (withVerifikat):
 * the registration verifikat the commit posts, built by the same builder over
 * the row the commit inserts and the lines it books. Without the option the
 * dry run answers as it always did. Preview and approval are compared row for
 * row on real Postgres in tests/pg/inbox-approval-verifikat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>()),
  createSupplierInvoiceRegistrationEntry: vi.fn(),
  buildSupplierInvoiceRegistrationEntryInput: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn(async () => []),
}))
// The company's momskoder, read for a reverse charge: none configured.
vi.mock('@/lib/bookkeeping/chart-vat-treatments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/chart-vat-treatments')>()),
  fetchChartVatTreatments: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('../inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))
vi.mock('@/lib/supplier-invoices/credit-target', () => ({ resolveInboxCreditTarget: vi.fn(async () => null) }))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import {
  buildSupplierInvoiceRegistrationEntryInput,
  createSupplierInvoiceRegistrationEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'

const SUPPLIER = '00000000-0000-4000-8000-000000000001'

// An EU supplier's services in euro: the rate and the reverse charge are what
// a header built apart from the row could get wrong.
const BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: SUPPLIER,
  supplier_invoice_number: 'INV-77',
  invoice_date: '2026-05-15',
  due_date: '2026-06-14',
  currency: 'EUR',
  exchange_rate: 11.4321,
  reverse_charge: true,
  items: [{ description: 'Hosting', amount: 1000, account_number: '6540', vat_rate: 0 }],
})

const BUILT = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-05-15',
  description: 'Leverantörsfaktura INV-77',
  source_type: 'supplier_invoice_registered',
  source_id: '',
  lines: [
    { account_number: '6540', debit_amount: 11432.1, credit_amount: 0, line_description: 'x' },
    { account_number: '2440', debit_amount: 0, credit_amount: 11432.1, line_description: 'x', currency: 'EUR', amount_in_currency: 1000 },
  ],
}

let db: ReturnType<typeof createTableMockSupabase>

function setUp(settings: Record<string, unknown> = { accounting_method: 'accrual', vat_registered: true }) {
  db = createTableMockSupabase({
    invoice_inbox_items: { data: makeInvoiceInboxItem({ id: 'item-1' }) },
    suppliers: { data: makeSupplier({ id: SUPPLIER, name: 'Cloudhost GmbH', supplier_type: 'eu_business' }) },
    company_settings: { data: makeCompanySettings(settings) },
    'rpc:get_next_arrival_number': { data: 42 },
    supplier_invoices: { data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } },
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

const convert = (options: { dryRun?: boolean; withVerifikat?: boolean } = {}) =>
  convertInboxItemToSupplierInvoice(
    { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-verifikat-test') },
    'item-1',
    BODY,
    { emit: vi.fn().mockResolvedValue(undefined), ...options },
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildSupplierInvoiceRegistrationEntryInput).mockResolvedValue(BUILT as never)
  vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValue(null as never)
})

describe('the dry run of an inbox conversion, with its verifikat', () => {
  it('without withVerifikat it answers as before: no verifikat, none built', async () => {
    setUp()
    const outcome = await convert({ dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).not.toHaveProperty('verifikat')
    expect(buildSupplierInvoiceRegistrationEntryInput).not.toHaveBeenCalled()
  })

  it('builds over the row the commit inserts and the lines the commit books, and states the rows', async () => {
    setUp()
    const outcome = await convert({ dryRun: true, withVerifikat: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview.verifikat).toEqual({
      entry_date: '2026-05-15',
      lines: [
        { account_number: '6540', debit_amount: 11432.1, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 11432.1 },
      ],
      total_debit: 11432.1,
      total_credit: 11432.1,
    })
    const [, , header, items, supplierType, supplierName] = vi.mocked(buildSupplierInvoiceRegistrationEntryInput).mock.calls[0]!

    // The commit, on the same input: what it inserts and what it books.
    setUp()
    await convert()
    const [inserted] = db.payloads('supplier_invoices', 'insert') as Array<Record<string, unknown>>
    const [, , , registered, booked, bookedType, bookedName] = vi.mocked(createSupplierInvoiceRegistrationEntry).mock.calls[0]!

    const { id, arrival_number: arrival, is_self_billed: selfBilled, ...row } = header as unknown as Record<string, unknown>
    expect({ id, arrival, selfBilled }).toEqual({ id: '', arrival: null, selfBilled: false })
    for (const [key, value] of Object.entries(row)) expect([key, inserted![key]]).toEqual([key, value])
    expect(row).toMatchObject({ currency: 'EUR', exchange_rate: 11.4321, reverse_charge: true, vat_treatment: 'reverse_charge' })
    expect(items).toEqual(booked)
    expect([supplierType, supplierName]).toEqual([bookedType, bookedName])
    // The commit hands the builder the row it inserted.
    expect(registered).toMatchObject({ id: 'invoice-1' })
  })

  it('a company that defers booking: no verifikat now, and none built', async () => {
    setUp({ accounting_method: 'accrual', vat_registered: true, defer_invoice_booking: true })
    const outcome = await convert({ dryRun: true, withVerifikat: true })
    expect(outcome.ok && outcome.dryRun && outcome.preview.verifikat).toBeNull()
    expect(buildSupplierInvoiceRegistrationEntryInput).not.toHaveBeenCalled()
  })

  it('no open fiscal year for the date: the commit\'s refusal, and nothing written', async () => {
    setUp()
    vi.mocked(buildSupplierInvoiceRegistrationEntryInput).mockResolvedValue(null)
    expect(await convert({ dryRun: true, withVerifikat: true })).toMatchObject({ ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD' })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })
})
