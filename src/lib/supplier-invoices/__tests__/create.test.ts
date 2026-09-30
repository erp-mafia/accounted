/**
 * The dry-run path of createSupplierInvoice: every check runs and the
 * result is the row that would be written, but no ankomstnummer is drawn
 * and nothing is written or booked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const mockRegisterExpenseClaim = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  registerExpenseClaim: (...args: unknown[]) => mockRegisterExpenseClaim(...args),
}))

import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '../create'

const { supabase, setTable, reset, calls } = createTableMockSupabase()

const SUPPLIER_ID = '550e8400-e29b-41d4-a716-446655440000'

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

function ctx() {
  return { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log }
}

function body(overrides: Partial<CreateSupplierInvoiceInput> = {}): CreateSupplierInvoiceInput {
  return {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'LF-DRY',
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    items: [{ description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25 }],
    ...overrides,
  } as CreateSupplierInvoiceInput
}

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

function expectNothingWritten() {
  // No RPC at all, so in particular no get_next_arrival_number.
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([])
  expect(mockRegistrationEntry).not.toHaveBeenCalled()
  expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID }) })
  // The arrival number would be 7 if anyone drew it: a dry run must not.
  setTable('rpc:get_next_arrival_number', { data: 7 })
})

describe('createSupplierInvoice dry run', () => {
  it('returns the preview under faktureringsmetoden and writes nothing', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({
      supplier_id: SUPPLIER_ID,
      supplier_invoice_number: 'LF-DRY',
      status: 'registered',
      currency: 'SEK',
      vat_treatment: 'standard_25',
      reverse_charge: false,
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      total_sek: 1250,
      remaining_amount: 1250,
      would_create_registration_journal_entry: true,
    })
    expect(result.preview.items).toHaveLength(1)
    expect(result.preview.items[0]).toMatchObject({ account_number: '4010', line_total: 1000, vat_amount: 250 })
    expectNothingWritten()
  })

  it('would not create a registration verifikat under kontantmetoden', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
    expectNothingWritten()
  })

  it('would not create a registration verifikat when booking is deferred (#967)', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', defer_invoice_booking: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
    expectNothingWritten()
  })

  it('a privately paid invoice would post the utlägg verifikat even under kontantmetoden', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash' } })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })

    const result = await createSupplierInvoice(ctx(), body({ paid_with_private_funds: true }), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({
      status: 'paid',
      paid_with_private_funds: true,
      remaining_amount: 0,
      would_create_registration_journal_entry: true,
    })
    expectNothingWritten()
  })

  it('surfaces the same PERIOD_LOCKED refusal a live commit would', async () => {
    setTable('company_settings', {
      data: { accounting_method: 'accrual', bookkeeping_locked_through: '2024-12-31' },
    })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expectNothingWritten()
  })
})
