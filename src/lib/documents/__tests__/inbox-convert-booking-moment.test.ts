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

import { createClient } from '@/lib/supabase/server'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { registerSupplierInvoiceHandler } from '@/lib/bookkeeping/handlers/supplier-invoice-handler'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { convertInboxItemToSupplierInvoice } from '../inbox-convert'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockCreateEntry = vi.mocked(createSupplierInvoiceRegistrationEntry)
const mockCreateClient = vi.mocked(createClient)

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
 * The session client an event subscriber opens with createClient(): answers
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

async function convert(settings: Record<string, unknown>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
  enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
  enqueue({ data: makeCompanySettings(settings) })
  enqueue({ data: 42 })
  enqueue({ data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } })
  enqueue({ data: [{ id: 'item-1', sort_order: 0 }], error: null })

  mockCreateClient.mockImplementation(async () => subscriberClient(settings) as never)

  return convertInboxItemToSupplierInvoice(
    {
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      userId: 'user-1',
      log: createLogger('inbox-convert-test'),
    },
    'item-1',
    BODY,
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
})
