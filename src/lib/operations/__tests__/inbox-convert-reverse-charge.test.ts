/**
 * Reverse charge on the inbox convert: the shared service behind the
 * v1 operation inbox-items.convert-to-supplier-invoice and the dashboard's
 * "Skapa leverantörsfaktura" takes createSupplierInvoice's VAT rules from
 * lib/supplier-invoices/create.ts instead of a copy that had no reverse-charge
 * leg.
 *
 * Omvänd skattskyldighet (swedish-vat skill, section 2.1; ML 16 kap 6-16 §§):
 * the seller's invoice carries no Swedish moms, the buyer self-assesses on
 * 2614/2645 and the leverantörsskuld on 2440 is the net. The convert used to
 * default vat_treatment to standard_25, price an omitted line rate at 25 % and
 * register net + VAT as the payable, while the registration verifikat credits
 * 2440 with the net: reskontra above 2440 and an invoice that never settles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pair guard (lib/operations/inbox-pair-guard.ts, tested there): here only that the door asks and obeys.
const refuseWhenPairBookedMock = vi.hoisted(() => vi.fn())
// The company's momskoder, read by the reverse-charge account check
// (reverseChargeAccountRefusal): none configured.
vi.mock('@/lib/bookkeeping/chart-vat-treatments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/chart-vat-treatments')>()),
  fetchChartVatTreatments: vi.fn(async () => new Map()),
}))
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
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import type { SupabaseClient } from '@supabase/supabase-js'

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'

function body(overrides: Record<string, unknown> = {}, line: Record<string, unknown> = {}) {
  return CreateSupplierInvoiceSchema.parse({
    supplier_id: SUPPLIER_UUID,
    supplier_invoice_number: 'INV-2026-77',
    invoice_date: '2026-09-15',
    due_date: '2026-10-15',
    items: [{ description: 'Cloud hosting', amount: 10000, account_number: '6540', ...line }],
    ...overrides,
  })
}

function ctx(supabase: unknown) {
  return {
    supabase: supabase as SupabaseClient,
    companyId: 'company-1',
    userId: 'user-1',
    log: createLogger('inbox-convert-reverse-charge-test'),
  }
}

/** A dry run: item, supplier, settings; SEK needs no rate lookup. */
async function preview(supplierType: string, input: ReturnType<typeof body>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
  enqueue({ data: makeSupplier({ id: SUPPLIER_UUID, supplier_type: supplierType as never }) })
  enqueue({ data: makeCompanySettings({ accounting_method: 'accrual', defer_invoice_booking: true }) })
  return convertInboxItemToSupplierInvoice(ctx(supabase), 'item-1', input, { dryRun: true, emit: vi.fn() })
}

describe('inbox convert: reverse charge follows createSupplierInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reverse_charge true: treatment reverse_charge, line rate 0, payable = net', async () => {
    const outcome = await preview('eu_business', body({ reverse_charge: true }))

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      total_sek: 10000,
    })
    expect((outcome.preview.items as Array<{ vat_rate: number }>)[0].vat_rate).toBe(0)
  })

  it('reverse_charge true with a non-zero line rate is refused like POST /supplier-invoices', async () => {
    const outcome = await preview('eu_business', body({ reverse_charge: true }, { vat_rate: 0.25 }))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('VALIDATION_ERROR')
    expect(outcome.details).toMatchObject({ field: 'items[0].vat_rate', reverse_charge: true })
  })

  it('a line on the import basis 4545 is refused like POST /supplier-invoices: ruta 50 beside the basis pair', async () => {
    const outcome = await preview('non_eu_business', body({ reverse_charge: true }, { account_number: '4545' }))

    expect(outcome).toEqual({
      ok: false,
      code: 'SI_REVERSE_CHARGE_ACCOUNT',
      details: { field: 'items[0].account_number', account_number: '4545', reason: 'other_box', account_box: 'ruta50' },
    })
  })

  it('a line on a cost account whose momskod is trepartshandel is refused, by the company momskoder', async () => {
    vi.mocked(fetchChartVatTreatments).mockResolvedValueOnce(
      new Map([['4020', { default_vat_treatment: 'triangulation_eu_goods', default_vat_rate: null }]]),
    )
    const outcome = await preview('eu_business', body({ reverse_charge: true }, { account_number: '4020' }))

    expect(outcome).toMatchObject({ ok: false, code: 'SI_REVERSE_CHARGE_ACCOUNT', details: { reason: 'other_box', account_box: 'ruta37' } })
  })

  it('a foreign supplier without the flag defaults to reverse charge (decision 7)', async () => {
    const outcome = await preview('non_eu_business', body())

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge: true, vat_amount: 0, total: 10000 })
  })

  it('an explicit reverse_charge false on a foreign supplier is kept (the seller charged its own or no Swedish VAT)', async () => {
    const outcome = await preview('eu_business', body({ reverse_charge: false, vat_treatment: 'exempt' }, { vat_rate: 0 }))

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ vat_treatment: 'exempt', reverse_charge: false, total: 10000 })
  })

  it('a Swedish supplier without the flag keeps the 25 % default', async () => {
    const outcome = await preview('swedish_business', body())

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ vat_treatment: 'standard_25', reverse_charge: false, vat_amount: 2500, total: 12500 })
  })

  it('periodisering on a foreign supplier without the flag is refused: the default is reverse charge', async () => {
    const outcome = await preview(
      'eu_business',
      body({}, { accrual_period_start: '2026-09-01', accrual_period_end: '2027-08-31' }),
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('SI_CREATE_ACCRUAL_REVERSE_CHARGE')
  })

  it('the commit stores reverse_charge, the treatment and remaining_amount = net', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID, supplier_type: 'eu_business' }) })
    enqueue({ data: makeCompanySettings({ accounting_method: 'accrual', defer_invoice_booking: true }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } })
    enqueue({ data: [{ id: 'item-1', sort_order: 0 }], error: null })

    const outcome = await convertInboxItemToSupplierInvoice(ctx(supabase), 'item-1', body(), { emit: vi.fn() })

    expect(outcome.ok).toBe(true)
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      remaining_amount: 10000,
    })
  })
})
