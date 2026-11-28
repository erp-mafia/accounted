/**
 * Byt leverantör on an invoice registered on the wrong supplier: what the
 * row, the reads and the verifikat decide. The rättelse RPC itself runs on
 * real Postgres in tests/pg/change-supplier.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/core/bookkeeping/journal-entry-corrections', () => ({
  correctJournalEntryMetadata: vi.fn(async (_ctx: unknown, _id: string, _input: unknown, options?: { dryRun?: boolean }) =>
    options?.dryRun ? { ok: true, dryRun: true, preview: { changed: true } } : { ok: true, data: { rattelse_id: 'log-1' } },
  ),
}))

import { correctJournalEntryMetadata } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { changeSupplierInvoiceSupplier, verifikatTextWithSupplier } from '../change-supplier'
import { supplierChangeRowRefusal } from '../change-supplier-rules'

const COMPANY = 'company-1'
const WRONG = 'supplier-wrong'
const RIGHT = 'supplier-right'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'si-1',
    company_id: COMPANY,
    supplier_id: WRONG,
    status: 'registered',
    is_credit_note: false,
    is_self_billed: false,
    approved_at: null,
    paid_amount: 0,
    remaining_amount: 1250,
    due_date: '2099-01-01',
    bank_entered_at: null,
    supplier_invoice_number: 'F-2041',
    arrival_number: 7,
    registration_journal_entry_id: null,
    ...overrides,
  }
}

const supplier = (id: string, name: string, kind = 'swedish_business', extra: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  name,
  supplier_type: kind,
  archived_at: null,
  ...extra,
})

function tables(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  return {
    supplier_invoices: [invoice()],
    suppliers: [supplier(WRONG, 'Fel Leverantör AB'), supplier(RIGHT, 'Rätt Leverantör AB')],
    supplier_invoice_payments: [],
    supplier_invoice_attestations: [],
    supplier_payment_batch_items: [],
    payment_orders: [],
    journal_entries: [],
    ...overrides,
  } as Record<string, Record<string, unknown>[]>
}

function run(rows: Record<string, Record<string, unknown>[]>, options: { dryRun?: boolean } = {}) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(rows, writes)
  const outcome = changeSupplierInvoiceSupplier(
    { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log },
    'si-1',
    RIGHT,
    options,
  )
  return { outcome, writes, mock }
}

beforeEach(() => vi.clearAllMocks())

describe('verifikatTextWithSupplier', () => {
  const inv = { supplier_invoice_number: 'F-2041', arrival_number: 7 }

  it('puts the new supplier in the place the registration wrote it', () => {
    expect(verifikatTextWithSupplier('Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr 7)', inv, 'Fel Leverantör AB', 'Rätt AB')).toBe(
      'Leverantörsfaktura F-2041, Rätt AB (ankomstnr 7)',
    )
  })

  it('also when the card was renamed after the registration', () => {
    expect(verifikatTextWithSupplier('Leverantörsfaktura F-2041, Fel Lev (ankomstnr 7)', inv, 'Fel Leverantör AB', 'Rätt AB')).toBe(
      'Leverantörsfaktura F-2041, Rätt AB (ankomstnr 7)',
    )
  })

  it('an invoice without a number', () => {
    expect(
      verifikatTextWithSupplier('Leverantörsfaktura, Fel AB (ankomstnr 7)', { supplier_invoice_number: null, arrival_number: 7 }, 'Fel AB', 'Rätt AB'),
    ).toBe('Leverantörsfaktura, Rätt AB (ankomstnr 7)')
  })

  it('a text corrected by hand gets the old name replaced where it stands', () => {
    expect(verifikatTextWithSupplier('Faktura från Fel AB, mars', inv, 'Fel AB', 'Rätt AB')).toBe('Faktura från Rätt AB, mars')
  })

  it('a text that does not name the old supplier needs no correction, nor one that already says the new', () => {
    expect(verifikatTextWithSupplier('Leasing mars', inv, 'Fel AB', 'Rätt AB')).toBeNull()
    expect(verifikatTextWithSupplier('Leverantörsfaktura F-2041, Rätt AB (ankomstnr 7)', inv, 'Fel AB', 'Rätt AB')).toBeNull()
  })

  it('the old name inside the new one or inside a longer word is no name of the old supplier', () => {
    expect(verifikatTextWithSupplier('Faktura från Acme Nordic, mars', inv, 'Acme', 'Acme Nordic')).toBeNull()
    expect(verifikatTextWithSupplier('Faktura från Acme, Acme Nordic tar över', inv, 'Acme', 'Acme Nordic')).toBe(
      'Faktura från Acme Nordic, Acme Nordic tar över',
    )
    expect(verifikatTextWithSupplier('Faktura från Acmeco, mars', inv, 'Acme', 'Rätt AB')).toBeNull()
    expect(verifikatTextWithSupplier('Faktura från Acme Nordic AB, mars', inv, 'Acme Nordic AB', 'Acme')).toBe('Faktura från Acme, mars')
  })
})

describe('supplierChangeRowRefusal', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({ status: 'registered', ...overrides })

  it('takes an unpaid invoice nobody attested', () => {
    expect(supplierChangeRowRefusal(row())).toBeNull()
    expect(supplierChangeRowRefusal(row({ status: 'overdue' }))).toBeNull()
  })

  it('refuses a credit note, a självfaktura, anything paid or settled, an attest and a bank tick', () => {
    expect(supplierChangeRowRefusal(row({ is_credit_note: true }))).toBe('credit_note')
    expect(supplierChangeRowRefusal(row({ is_self_billed: true }))).toBe('self_billed')
    for (const status of ['paid', 'partially_paid', 'credited', 'reversed', 'disputed']) {
      expect(supplierChangeRowRefusal(row({ status }))).toBe('not_unpaid')
    }
    expect(supplierChangeRowRefusal(row({ paid_amount: 100 }))).toBe('not_unpaid')
    expect(supplierChangeRowRefusal(row({ status: 'approved' }))).toBe('attested')
    expect(supplierChangeRowRefusal(row({ status: 'overdue', approved_at: '2026-03-03T08:00:00Z' }))).toBe('attested')
    expect(supplierChangeRowRefusal(row({ bank_entered_at: '2026-03-04T08:00:00Z' }))).toBe('payment_under_way')
  })
})

describe('changeSupplierInvoiceSupplier', () => {
  it('moves an unbooked invoice, guarded on what it read, and touches no verifikat', async () => {
    const { outcome, writes, mock } = run(tables())
    expect(await outcome).toEqual({
      ok: true,
      data: { supplier_invoice_id: 'si-1', supplier_id: RIGHT, previous_supplier_id: WRONG, changed: true, corrected_journal_entry_id: null },
    })
    expect(writes).toEqual([{ table: 'supplier_invoices', method: 'update', row: { supplier_id: RIGHT } }])
    const guards = mock.findCalls('supplier_invoices', 'is').concat(mock.findCalls('supplier_invoices', 'eq'))
    expect(guards).toEqual(expect.arrayContaining([['supplier_id', WRONG], ['status', 'registered'], ['approved_at', null], ['bank_entered_at', null], ['registration_journal_entry_id', null]]))
    expect(correctJournalEntryMetadata).not.toHaveBeenCalled()
  })

  it('a booked invoice gets its verifikat text corrected inline after the move', async () => {
    const rows = tables({
      supplier_invoices: [invoice({ registration_journal_entry_id: 'je-1' })],
      journal_entries: [{ id: 'je-1', company_id: COMPANY, description: 'Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr 7)' }],
    })
    const { outcome, writes } = run(rows)
    expect(await outcome).toMatchObject({ ok: true, data: { changed: true, corrected_journal_entry_id: 'je-1' } })
    expect(writes).toEqual([{ table: 'supplier_invoices', method: 'update', row: { supplier_id: RIGHT } }])
    const calls = vi.mocked(correctJournalEntryMetadata).mock.calls
    // First the rules as reads (the preview), then the rättelse itself.
    expect(calls.map(([, id, input, options]) => [id, input, options?.dryRun ?? false])).toEqual([
      ['je-1', { description: 'Leverantörsfaktura F-2041, Rätt Leverantör AB (ankomstnr 7)' }, true],
      ['je-1', { description: 'Leverantörsfaktura F-2041, Rätt Leverantör AB (ankomstnr 7)' }, false],
    ])
  })

  it('a dry run says what moves and the new text, and writes nothing', async () => {
    const rows = tables({
      supplier_invoices: [invoice({ registration_journal_entry_id: 'je-1' })],
      journal_entries: [{ id: 'je-1', company_id: COMPANY, description: 'Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr 7)' }],
    })
    const { outcome, writes } = run(rows, { dryRun: true })
    expect(await outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        from: { id: WRONG, name: 'Fel Leverantör AB' },
        to: { id: RIGHT, name: 'Rätt Leverantör AB' },
        corrects_verifikat: true,
        new_verifikat_text: 'Leverantörsfaktura F-2041, Rätt Leverantör AB (ankomstnr 7)',
      },
    })
    expect(writes).toEqual([])
    expect(vi.mocked(correctJournalEntryMetadata).mock.calls.every(([, , , options]) => options?.dryRun === true)).toBe(true)
  })

  it('past a lock the period refuses the rättelse: nothing moves, and the way is a credit', async () => {
    vi.mocked(correctJournalEntryMetadata).mockResolvedValueOnce({
      ok: false,
      code: 'JOURNAL_RATTELSE_PERIOD_LOCKED',
      details: { reason: 'company_lock_date_covers' },
    })
    const rows = tables({
      supplier_invoices: [invoice({ registration_journal_entry_id: 'je-1' })],
      journal_entries: [{ id: 'je-1', company_id: COMPANY, description: 'Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr 7)' }],
    })
    const { outcome, writes } = run(rows)
    expect(await outcome).toEqual({ ok: false, code: 'SI_CHANGE_SUPPLIER_PERIOD_LOCKED', details: { reason: 'company_lock_date_covers' } })
    expect(writes).toEqual([])
  })

  it('a rättelse refused at commit puts the old supplier back', async () => {
    vi.mocked(correctJournalEntryMetadata)
      .mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
      .mockResolvedValueOnce({ ok: false, code: 'JOURNAL_RATTELSE_PERIOD_LOCKED' })
    const rows = tables({
      supplier_invoices: [invoice({ registration_journal_entry_id: 'je-1' })],
      journal_entries: [{ id: 'je-1', company_id: COMPANY, description: 'Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr 7)' }],
    })
    const { outcome, writes } = run(rows)
    expect(await outcome).toMatchObject({ ok: false, code: 'SI_CHANGE_SUPPLIER_PERIOD_LOCKED' })
    expect(writes).toEqual([
      { table: 'supplier_invoices', method: 'update', row: { supplier_id: RIGHT } },
      { table: 'supplier_invoices', method: 'update', row: { supplier_id: WRONG } },
    ])
  })

  it('an approval given while the invoice moved puts the old supplier back and refuses', async () => {
    const rows = tables()
    const writes: { table: string; method: string; row: unknown }[] = []
    const record = writes.push.bind(writes)
    writes.push = (...items) => {
      // The first of two approvals lands between the checks and the move: approved_at stays null.
      if (items.some((w) => (w.row as { supplier_id?: string }).supplier_id === RIGHT)) {
        rows.supplier_invoice_attestations.push({
          company_id: COMPANY,
          supplier_invoice_id: 'si-1',
          user_id: 'u-2',
          decision: 'approved',
          decided_at: '2026-03-03T08:00:00Z',
        })
      }
      return record(...items)
    }
    const mock = createRowsMockSupabase(rows, writes)
    const outcome = await changeSupplierInvoiceSupplier(
      { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log },
      'si-1',
      RIGHT,
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CHANGE_SUPPLIER_ATTESTED', details: { reason: 'approval_in_round' } })
    expect([...writes]).toEqual([
      { table: 'supplier_invoices', method: 'update', row: { supplier_id: RIGHT } },
      { table: 'supplier_invoices', method: 'update', row: { supplier_id: WRONG } },
    ])
    expect(correctJournalEntryMetadata).not.toHaveBeenCalled()
  })

  it('is a no-op on the supplier it has', async () => {
    const rows = tables({ supplier_invoices: [invoice({ supplier_id: RIGHT })] })
    const { outcome, writes } = run(rows)
    expect(await outcome).toMatchObject({ ok: true, data: { changed: false, supplier_id: RIGHT } })
    expect(writes).toEqual([])
  })

  it.each([
    ['an attested invoice', { supplier_invoices: [invoice({ status: 'approved', approved_at: '2026-03-03T08:00:00Z' })] }, 'SI_CHANGE_SUPPLIER_ATTESTED'],
    ['the first approval of two', { supplier_invoice_attestations: [{ company_id: COMPANY, supplier_invoice_id: 'si-1', user_id: 'u-2', decision: 'approved', decided_at: '2026-03-03T08:00:00Z' }] }, 'SI_CHANGE_SUPPLIER_ATTESTED'],
    ['a payment row', { supplier_invoice_payments: [{ id: 'p-1', company_id: COMPANY, supplier_invoice_id: 'si-1' }] }, 'SI_CHANGE_SUPPLIER_NOT_UNPAID'],
    ['a payment file', { supplier_payment_batch_items: [{ company_id: COMPANY, supplier_invoice_id: 'si-1', batch: { id: 'b-1', status: 'created', created_at: '2026-03-03T08:00:00Z' } }] }, 'SI_CHANGE_SUPPLIER_PAYMENT_UNDER_WAY'],
    ['the bank tick', { supplier_invoices: [invoice({ bank_entered_at: '2026-03-04T08:00:00Z' })] }, 'SI_CHANGE_SUPPLIER_PAYMENT_UNDER_WAY'],
    ['a credit note', { supplier_invoices: [invoice({ is_credit_note: true, status: 'credited' })] }, 'SI_CHANGE_SUPPLIER_CREDIT_NOTE'],
    ['a självfaktura', { supplier_invoices: [invoice({ is_self_billed: true })] }, 'SI_SELF_BILL_IMMUTABLE'],
    ['a supplier of another kind', { suppliers: [supplier(WRONG, 'Fel AB'), supplier(RIGHT, 'Right GmbH', 'eu_business')] }, 'SI_CHANGE_SUPPLIER_OTHER_KIND'],
    ['an archived supplier', { suppliers: [supplier(WRONG, 'Fel AB'), supplier(RIGHT, 'Rätt AB', 'swedish_business', { archived_at: '2026-01-01' })] }, 'SUPPLIER_NOT_FOUND'],
    ['a live invoice of the new supplier under the number', { supplier_invoices: [invoice(), invoice({ id: 'si-9', supplier_id: RIGHT, status: 'registered' })] }, 'SI_CHANGE_SUPPLIER_DUPLICATE_NUMBER'],
  ])('refuses %s and writes nothing', async (_label, overrides, code) => {
    const { outcome, writes } = run(tables(overrides as Partial<Record<string, Record<string, unknown>[]>>))
    expect(await outcome).toMatchObject({ ok: false, code })
    expect(writes).toEqual([])
  })

  it('a credited invoice of the new supplier under the number holds no slot: the move goes ahead', async () => {
    const { outcome } = run(tables({ supplier_invoices: [invoice(), invoice({ id: 'si-9', supplier_id: RIGHT, status: 'credited' })] }))
    expect(await outcome).toMatchObject({ ok: true, data: { changed: true } })
  })

  it('an invoice of another company is not found', async () => {
    const { outcome } = run(tables({ supplier_invoices: [invoice({ company_id: 'company-2' })] }))
    expect(await outcome).toEqual({ ok: false, code: 'SI_NOT_FOUND' })
  })
})
