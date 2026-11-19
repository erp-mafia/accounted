/**
 * The approval of a staged conversion: what staging priced goes into the one
 * conversion as it stands (stagedConversion), and the service keeps what the
 * approver saw honest (approvedTotal). The whole door runs on real Postgres in
 * tests/pg/inbox-convert-doors.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoiceInboxItem, makeSupplier } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({ createSupplierInvoiceRegistrationEntry: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('../inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))
vi.mock('@/lib/supplier-invoices/credit-target', () => ({ resolveInboxCreditTarget: vi.fn(async () => null) }))

import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { convertInboxItemToSupplierInvoice, stagedConversion } from '../inbox-convert'

const staged = (overrides: Record<string, unknown> = {}) => ({
  inbox_item_id: 'item-1',
  supplier_id: 'supplier-1',
  supplier_invoice_number: 'F-1',
  invoice_date: '2026-05-15',
  due_date: '2026-06-14',
  currency: 'SEK',
  exchange_rate: null,
  vat_treatment: 'standard_25',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
  notes: null,
  items: [{ line_number: 1, description: 'Rad', quantity: 2, unit: 'tim', unit_price: 500, line_total: 1000, account_number: '6530', vat_rate: 0.25, vat_amount: 250 }],
  ...overrides,
})

function body(params: Record<string, unknown>) {
  const result = stagedConversion(params)
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.body
}

describe('stagedConversion', () => {
  it('keeps a line as it was staged: quantity and price when they make its amount, its own VAT', () => {
    expect(body(staged()).items[0]).toMatchObject({ quantity: 2, unit: 'tim', unit_price: 500, vat_rate: 0.25, vat_amount: 250 })
    expect(body(staged()).items[0]).not.toHaveProperty('amount')
  })

  it('takes the amount when quantity and price do not make it', () => {
    const [line] = body(staged({ items: [{ description: 'Rad', quantity: 1, unit_price: 0, line_total: 1000, account_number: '6530', vat_rate: 0.25, vat_amount: 250 }] })).items
    expect(line).toMatchObject({ amount: 1000 })
    expect(line).not.toHaveProperty('unit_price')
  })

  it('carries the header total for the approval to hold the lines to', () => {
    expect(stagedConversion(staged())).toMatchObject({ ok: true, inboxItemId: 'item-1', approvedTotal: 1250 })
  })

  it('no notes staged is no notes given: the item\'s channel context goes in, as on every door', () => {
    expect(body(staged({ notes: null })).notes).toBeUndefined()
    expect(body(staged({ notes: '' })).notes).toBe('')
    expect(body(staged({ notes: 'Avtal 12' })).notes).toBe('Avtal 12')
  })

  it('no dimensions staged stays none: an omitted bag would take the supplier\'s default the approver never saw', () => {
    expect(body(staged()).default_dimensions).toEqual({})
    expect(body(staged({ default_dimensions: { '1': 'KS01' } })).default_dimensions).toEqual({ '1': 'KS01' })
  })

  it('snaps a percent-shaped rate from an old op', () => {
    expect(body(staged({ items: [{ description: 'Rad', line_total: 1000, account_number: '6530', vat_rate: 25, vat_amount: 250 }] })).items[0]).toMatchObject({ vat_rate: 0.25 })
  })

  it.each(['reverse_charge', 'exempt', 'export'])('%s carries no seller VAT, whatever an old op still says', (treatment) => {
    expect(body(staged({ vat_treatment: treatment })).items[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
  })

  it('the flag follows the staged treatment; an op without one gets the supplier\'s default', () => {
    expect(body(staged({ vat_treatment: 'reverse_charge' })).reverse_charge).toBe(true)
    expect(body(staged()).reverse_charge).toBe(false)
    expect(body(staged({ vat_treatment: undefined }))).not.toHaveProperty('reverse_charge')
  })

  it.each([
    ['a missing number', { supplier_invoice_number: '  ' }, 'SI_CREATE_INVALID_INPUT'],
    ['no lines', { items: [] }, 'SI_CREATE_INVALID_INPUT'],
    ['no due date', { due_date: null }, 'SI_CREATE_INVALID_INPUT'],
    ['a line with no account', { items: [{ description: 'Rad', line_total: 1000 }] }, 'SI_CREATE_ITEM_ACCOUNT_MISSING'],
    ['a kind no supplier has', { reverse_charge_kind: 'eu_nonsense' }, 'SI_CREATE_INVALID_INPUT'],
  ])('refuses %s', (_label, overrides, code) => {
    expect(stagedConversion(staged(overrides))).toMatchObject({ ok: false, code })
  })

  it.each([
    ['an amount that is no number', { total: 'x' }, /finite/],
    ['a rate that is no number', { exchange_rate: 'x' }, /exchange_rate/],
  ])('refuses %s', (_label, overrides, message) => {
    expect(stagedConversion(staged(overrides))).toMatchObject({ ok: false, error: expect.stringMatching(message) })
  })
})

describe('convertInboxItemToSupplierInvoice: an approval and a booked item', () => {
  const BODY = CreateSupplierInvoiceSchema.parse({
    supplier_id: '00000000-0000-4000-8000-000000000001',
    supplier_invoice_number: 'F-1',
    invoice_date: '2026-05-15',
    due_date: '2026-06-14',
    items: [{ description: 'Rad', amount: 1000, account_number: '6530', vat_rate: 0.25 }],
  })
  let db: ReturnType<typeof createTableMockSupabase>

  function setUp(item: Record<string, unknown>, settings: Record<string, unknown> = { accounting_method: 'accrual' }) {
    db = createTableMockSupabase({
      invoice_inbox_items: { data: makeInvoiceInboxItem({ id: 'item-1', ...item }) },
      suppliers: { data: makeSupplier({ supplier_type: 'swedish_business' }) },
      company_settings: { data: makeCompanySettings(settings) },
      journal_entries: { data: { status: 'posted' } },
      'rpc:get_next_arrival_number': { data: 42 },
      supplier_invoices: { data: { id: 'invoice-1', status: 'registered', registration_journal_entry_id: null } },
      supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
    })
  }

  const convert = (options: { approvedTotal?: number; dryRun?: boolean } = {}) =>
    convertInboxItemToSupplierInvoice(
      { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-staged-test') },
      'item-1',
      BODY,
      { emit: vi.fn().mockResolvedValue(undefined), ...options },
    )

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValue(null as never)
  })

  it('an approved total the lines do not reach stops before an ankomstnummer is drawn', async () => {
    setUp({})
    expect(await convert({ approvedTotal: 2000 })).toMatchObject({ ok: false, code: 'SI_CREATE_TOTALS_MISMATCH' })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['an approved total', { approvedTotal: -1250 }, undefined],
    ['lines', {}, [{ description: 'Rad', amount: -1000, account_number: '6530', vat_rate: 0.25 }]],
  ])('%s below zero is a credit note, never a payable of its own', async (_label, options, items) => {
    setUp({}, { accounting_method: 'cash' })
    const outcome = await convertInboxItemToSupplierInvoice(
      { supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('inbox-convert-staged-test') },
      'item-1',
      items ? { ...BODY, items: items as typeof BODY.items } : BODY,
      options,
    )
    expect(outcome).toMatchObject({ ok: false, code: 'INBOX_ITEM_IS_CREDIT_NOTE' })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
  })

  it('rounding passes, and the payable stays what 2440 is credited', async () => {
    setUp({}, { accounting_method: 'cash' })
    expect(await convert({ approvedTotal: 1250.4 })).toMatchObject({ ok: true })
    expect(db.payloads('supplier_invoices', 'insert')[0]).toMatchObject({ total: 1250 })
  })

  it.each([
    ['a stamp on a live verifikat', { created_journal_entry_id: 'je-1' }],
    ['a live verifikat on its document', { document_hold: { journal_entry_id: 'je-1', entry: { status: 'posted' } } }],
  ])('%s: refuses a registration verifikat, on a dry run too', async (_label, item) => {
    setUp(item)
    expect(await convert()).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { journal_entry_id: 'je-1' } })
    expect(await convert({ dryRun: true })).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED' })
    expect(db.payloads('supplier_invoices', 'insert')).toEqual([])
  })

  it.each([
    ['kontantmetoden', { accounting_method: 'cash' }],
    ['a company that defers booking', { accounting_method: 'accrual', defer_invoice_booking: true }],
  ])('%s: registers with no verifikat, which books nothing twice', async (_label, settings) => {
    setUp({ document_hold: { journal_entry_id: 'je-1', entry: { status: 'posted' } } }, settings)
    expect(await convert()).toMatchObject({ ok: true })
    expect(db.payloads('supplier_invoices', 'insert')).toHaveLength(1)
  })

  it('a reversed verifikat on its document books nothing: the conversion goes through', async () => {
    setUp({ document_hold: { journal_entry_id: 'je-1', entry: { status: 'reversed' } } }, { accounting_method: 'cash' })
    expect(await convert()).toMatchObject({ ok: true })
  })
})
