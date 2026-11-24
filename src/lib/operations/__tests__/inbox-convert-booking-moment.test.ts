/**
 * When converting an inbox item posts the 2440 registration verifikat, with
 * the core event subscribers wired as in production.
 *
 * convertInboxItemToSupplierInvoice decides with booksInvoicesOnIssue() and
 * then emits supplier_invoice.registered and supplier_invoice.confirmed. A
 * core subscriber on .confirmed used to book the registration entry itself
 * whenever none was linked, deciding with accounting_method alone. For a
 * company with defer_invoice_booking (#967) the convert flow skipped the
 * entry on purpose and the subscriber then posted it anyway. The route-level
 * tests mock emit and never reached it, so this test runs the real bus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

import { eventBus } from '@/lib/events/bus'
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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { registerSupplierInvoiceHandler } from '@/lib/invoices/supplier-invoice-handler'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierType } from '@/types'

const mockCreateEntry = vi.mocked(createSupplierInvoiceRegistrationEntry)
const mockCreateClient = vi.mocked(createClient)
const mockServiceClient = vi.mocked(createServiceClientNoCookies)

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'

// Parsed like every door parses it, so schema defaults apply.
const BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: SUPPLIER_UUID,
  supplier_invoice_number: 'F-2026-001',
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  items: [{ description: 'Konsulttjänster', amount: 10000, account_number: '6200', vat_rate: 0.25 }],
})

/**
 * The client an event subscriber opens (createClient(), or the service-role
 * client the core consumers use): answers
 * per table with what the database holds after the convert, the invoice
 * still unlinked when the company defers.
 */
function subscriberClient(settings: Record<string, unknown>) {
  const rows: Record<string, unknown> = {
    supplier_invoices: { id: 'invoice-1', registration_journal_entry_id: null },
    company_settings: settings,
    supplier_invoice_items: [{ id: 'item-1', account_number: '6200', line_total: 10000, sort_order: 0 }],
    suppliers: { supplier_type: 'swedish_business' },
  }
  const chain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain(result)
        },
      },
    )
  return { from: (table: string) => chain({ data: rows[table] ?? null, error: null }) }
}

// An EU goods acquisition (ruta 20): reverse charge, no seller moms.
const EU_GOODS_BODY = CreateSupplierInvoiceSchema.parse({
  supplier_id: SUPPLIER_UUID,
  supplier_invoice_number: 'EU-2026-001',
  invoice_date: '2026-09-15',
  due_date: '2026-11-15',
  reverse_charge: true,
  reverse_charge_kind: 'eu_goods',
  items: [{ description: 'Varor', amount: 10000, account_number: '4010', vat_rate: 0 }],
})

async function convert(
  settings: Record<string, unknown>,
  body: typeof BODY = BODY,
  supplierType: SupplierType = 'swedish_business',
) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
  enqueue({ data: makeSupplier({ id: SUPPLIER_UUID, supplier_type: supplierType }) })
  enqueue({ data: makeCompanySettings(settings) })
  enqueue({ data: 42 })
  enqueue({ data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } })
  enqueue({ data: [{ id: 'item-1', sort_order: 0 }], error: null })

  mockCreateClient.mockImplementation(async () => subscriberClient(settings) as never)
  mockServiceClient.mockImplementation(() => subscriberClient(settings) as never)

  return convertInboxItemToSupplierInvoice(
    {
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      userId: 'user-1',
      log: createLogger('inbox-convert-test'),
    },
    'item-1',
    body,
  )
}

describe('inbox convert: registration verifikat follows booksInvoicesOnIssue', () => {
  let unsubscribe: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    unsubscribe = registerSupplierInvoiceHandler()
    mockCreateEntry.mockResolvedValue({ id: 'je-1' } as never)
  })

  afterEach(() => {
    unsubscribe()
    eventBus.clear()
  })

  it('posts nothing for a faktureringsmetoden company that defers booking', async () => {
    const outcome = await convert({ accounting_method: 'accrual', defer_invoice_booking: true })

    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) expect(outcome.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateEntry).not.toHaveBeenCalled()
  })

  it('posts exactly one entry, inline, for a faktureringsmetoden company that books at registration', async () => {
    const outcome = await convert({ accounting_method: 'accrual', defer_invoice_booking: false })

    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) expect(outcome.data.registration_journal_entry_id).toBe('je-1')
    expect(mockCreateEntry).toHaveBeenCalledTimes(1)
  })

  it('posts nothing for a kontantmetoden company', async () => {
    const outcome = await convert({ accounting_method: 'cash', defer_invoice_booking: false })

    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) expect(outcome.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateEntry).not.toHaveBeenCalled()
  })

  // #73: ML 2023:200 7 kap. 26 § puts an EU goods acquisition's moms in the
  // invoice's period whatever the method, so kontantmetoden registers it too.
  it('posts the registration for a kontantmetoden company buying goods from another EU country', async () => {
    const outcome = await convert({ accounting_method: 'cash', defer_invoice_booking: false }, EU_GOODS_BODY, 'eu_business')

    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) expect(outcome.data.registration_journal_entry_id).toBe('je-1')
    expect(mockCreateEntry).toHaveBeenCalledTimes(1)
  })

  it('still posts nothing for a kontantmetoden company buying EU services (paid, then reported)', async () => {
    const services = { ...EU_GOODS_BODY, reverse_charge_kind: 'eu_services' as const }
    const outcome = await convert({ accounting_method: 'cash', defer_invoice_booking: false }, services, 'eu_business')

    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) expect(outcome.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateEntry).not.toHaveBeenCalled()
  })
})
