import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { decideSupplierPayee, listSupplierPayeeAlerts, loadPayeeHolds, readInvoicePayee } from '../payee-alerts'
import { assessRegisteredPayee, payeeAlertWarning } from '../payee-registration'

const COMPANY = 'company-1'
const CARD = { bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null }

let db: ReturnType<typeof createTableMockSupabase>
const supabase = () => db.supabase as unknown as SupabaseClient
const ctx = (): OperationContext => ({
  supabase: supabase(),
  companyId: COMPANY,
  userId: 'user-1',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
})

function invoiceRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    supplier_id: 'sup-1',
    supplier_invoice_number: `F-${id}`,
    arrival_number: 7,
    due_date: '2026-10-31',
    status: 'approved',
    is_credit_note: false,
    remaining_amount: 1000,
    payee_bankgiro: '9020-0007',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    supplier: { id: 'sup-1', name: 'Derome Bygg AB', ...CARD },
    ...overrides,
  }
}

beforeEach(() => {
  db = createTableMockSupabase()
})

describe('loadPayeeHolds', () => {
  it('holds a changed account until confirmed, and the latest decision wins', async () => {
    const invoices = [invoiceRow('a'), invoiceRow('b', { payee_bankgiro: '5050-1055' })]
    const cards = new Map([['sup-1', CARD]])
    db.setTable('supplier_payee_confirmations', { data: [] })
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, cards)).get('a')).toMatchObject({
      alert: 'changed',
      decision: null,
      hold: 'payee_unconfirmed',
      stated_key: 'bankgiro:90200007',
      card_key: 'bankgiro:50501055',
    })

    db.setTable('supplier_payee_confirmations', {
      data: [
        { supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision: 'confirmed', decided_at: '2026-10-14T10:00:00Z' },
        { supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision: 'rejected', decided_at: '2026-10-13T10:00:00Z' },
      ],
    })
    const states = await loadPayeeHolds(supabase(), COMPANY, invoices, cards)
    expect(states.get('a')).toMatchObject({ decision: 'confirmed', hold: null })
    // The invoice that states the card's own account never alerts.
    expect(states.has('b')).toBe(false)
  })

  it('alerts a new account on an empty card only for a supplier paid before', async () => {
    const invoices = [invoiceRow('a')]
    const empty = new Map([['sup-1', {}]])
    db.setTable('supplier_invoices', { data: [] })
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, empty)).size).toBe(0)
    expect(db.tables()).not.toContain('supplier_payee_confirmations')

    // The invoice itself paid in part does not count as history.
    db.setTable('supplier_invoices', { data: [{ id: 'a', supplier_id: 'sup-1' }] })
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, empty)).size).toBe(0)

    db.setTable('supplier_invoices', { data: [{ id: 'old', supplier_id: 'sup-1' }] })
    db.setTable('supplier_payee_confirmations', { data: [] })
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, empty)).get('a')).toMatchObject({
      alert: 'new_supplier_account',
      hold: 'payee_unconfirmed',
      card_key: null,
    })
  })

  it('never holds an invoice whose IBAN sits beside the bankgiro a payment uses, even after a rejection (crm#1220)', async () => {
    // As the MCP approval stored it before accounted#15: the footer's IBAN, not the card's bankgiro it also printed.
    const invoices = [invoiceRow('a', { payee_bankgiro: null, payee_iban: 'SE4550000000058398257466' })]
    db.setTable('supplier_payee_confirmations', {
      data: [{ supplier_id: 'sup-1', payee_key: 'iban:SE4550000000058398257466', decision: 'rejected', decided_at: '2026-10-15T08:40:00Z' }],
    })
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, new Map([['sup-1', CARD]]))).size).toBe(0)

    // A card that pays only an IBAN still holds an invoice that states another.
    const ibanCard = { ...CARD, bankgiro: null, iban: 'SE3550000000054910000003' }
    expect((await loadPayeeHolds(supabase(), COMPANY, invoices, new Map([['sup-1', ibanCard]]))).get('a')).toMatchObject({
      alert: 'changed',
      stated_key: 'iban:SE4550000000058398257466',
      card_key: 'iban:SE3550000000054910000003',
    })
  })

  it('reads nothing when no invoice states an account the card lacks', async () => {
    const states = await loadPayeeHolds(supabase(), COMPANY, [invoiceRow('a', { payee_bankgiro: null })], new Map([['sup-1', CARD]]))
    expect(states.size).toBe(0)
    expect(db.tables()).toEqual([])
  })
})

describe('assessRegisteredPayee: at registration, before the card is touched', () => {
  it('keeps what the document states and lets the card take details it lacks when nothing alerts', async () => {
    db.setTable('suppliers', { data: { bankgiro: null, plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null } })
    db.setTable('supplier_invoices', { data: [] })
    const assessment = await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '9020-0007' })
    expect(assessment).toEqual({
      stated: { payee_bankgiro: '9020-0007', payee_plusgiro: null, payee_iban: null, payee_bic: null },
      alert: null,
      backfill: true,
      statedKey: 'bankgiro:90200007',
      cardKey: null,
    })
  })

  it('alerts and leaves the card alone for a changed account, and for a new one at a supplier paid before', async () => {
    db.setTable('suppliers', { data: { ...CARD, bankgiro: null, plusgiro: '1234566' } })
    // Both accounts as keys, so a staging preview can name them (accounted#15).
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '9020-0007' })).toMatchObject({
      alert: 'changed',
      backfill: false,
      statedKey: 'bankgiro:90200007',
      cardKey: 'plusgiro:1234566',
    })

    db.setTable('suppliers', { data: { bankgiro: null, plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null } })
    db.setTable('supplier_invoices', { data: [{ id: 'old', supplier_id: 'sup-1' }] })
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '9020-0007' })).toMatchObject({
      alert: 'new_supplier_account',
      backfill: false,
    })
  })

  it('lets the card take an IBAN the invoice prints beside the card\'s bankgiro, and alerts nothing (crm#1220)', async () => {
    db.setTable('suppliers', { data: CARD })
    expect(
      await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '5050-1055', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'ESSESESS' }),
    ).toEqual({
      stated: { payee_bankgiro: '5050-1055', payee_plusgiro: null, payee_iban: 'SE4550000000058398257466', payee_bic: 'ESSESESS' },
      alert: null,
      backfill: true,
      statedKey: 'bankgiro:50501055',
      cardKey: 'bankgiro:50501055',
    })
    // The scan read only the IBAN: a payment still uses the card's bankgiro.
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { iban: 'SE4550000000058398257466' })).toMatchObject({ alert: null, backfill: true })
    // Another bankgiro beside it alerts, and the card stays as it is.
    expect(
      await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '9020-0007', iban: 'SE4550000000058398257466' }),
    ).toMatchObject({ alert: 'changed', backfill: false })
    // A card that pays only an IBAN: another IBAN alerts.
    db.setTable('suppliers', { data: { ...CARD, bankgiro: null, iban: 'SE3550000000054910000003' } })
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { iban: 'SE4550000000058398257466' })).toMatchObject({
      alert: 'changed',
      backfill: false,
      statedKey: 'iban:SE4550000000058398257466',
      cardKey: 'iban:SE3550000000054910000003',
    })
  })

  it('never reads the card for a document without payment details, and never fails a registration', async () => {
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: 'not a giro' })).toMatchObject({ alert: null, backfill: true })
    expect(db.tables()).toEqual([])
    db.setTable('suppliers', { error: { message: 'boom' } })
    expect(await assessRegisteredPayee(supabase(), COMPANY, 'sup-1', { bankgiro: '9020-0007' })).toMatchObject({ alert: null, backfill: true })
  })

  it('words a warning for the person booking the invoice', () => {
    expect(payeeAlertWarning('changed').code).toBe('SUPPLIER_PAYEE_CHANGED')
    expect(payeeAlertWarning('new_supplier_account').code).toBe('SUPPLIER_PAYEE_NEW')
  })
})

describe('listSupplierPayeeAlerts', () => {
  it('lists unpaid invoices whose account alerts, with old and new as labels, under the company', async () => {
    db.setTable('supplier_invoices', { data: [invoiceRow('a'), invoiceRow('b', { payee_bankgiro: '5050-1055' })] })
    db.setTable('supplier_payee_confirmations', { data: [] })
    expect(await listSupplierPayeeAlerts(supabase(), COMPANY)).toEqual([
      {
        supplier_invoice_id: 'a',
        supplier_id: 'sup-1',
        supplier_name: 'Derome Bygg AB',
        supplier_invoice_number: 'F-a',
        arrival_number: 7,
        due_date: '2026-10-31',
        alert: 'changed',
        decision: null,
        hold: 'payee_unconfirmed',
        old_payee: 'BG 5050-1055',
        new_payee: 'BG 9020-0007',
      },
    ])
    expect(db.findCall('supplier_invoices', 'eq')).toEqual(['company_id', COMPANY])
    expect(db.findCalls('supplier_invoices', 'in')[0]).toEqual(['status', ['registered', 'approved', 'partially_paid', 'overdue']])
  })
})

describe('decideSupplierPayee', () => {
  beforeEach(() => {
    db.setTable('supplier_invoices', { data: invoiceRow('a') })
    db.setTable('supplier_payee_confirmations', { data: [] })
    db.setTable('suppliers', { data: null })
  })

  it('confirms in the person\'s name and makes the account the card\'s payment account', async () => {
    const outcome = await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed', note: ' ringde leverantören ' })
    expect(outcome).toEqual({
      ok: true,
      data: { supplier_invoice_id: 'a', supplier_id: 'sup-1', decision: 'confirmed', payee: 'BG 9020-0007', supplier_card_updated: true },
    })
    expect(db.payloads('suppliers', 'update')).toEqual([{ bankgiro: '9020-0007' }])
    expect(db.payloads('supplier_payee_confirmations', 'insert')).toEqual([
      {
        company_id: COMPANY,
        supplier_id: 'sup-1',
        payee_key: 'bankgiro:90200007',
        decision: 'confirmed',
        decided_by: 'user-1',
        source_supplier_invoice_id: 'a',
        note: 'ringde leverantören',
        supplier_card_updated: true,
      },
    ])
  })

  it('rejects without touching the card, and confirms without it when asked', async () => {
    expect(await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'rejected', updateSupplierCard: true })).toMatchObject({
      ok: true,
      data: { decision: 'rejected', supplier_card_updated: false },
    })
    expect(await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed', updateSupplierCard: false })).toMatchObject({
      ok: true,
      data: { supplier_card_updated: false },
    })
    expect(db.payloads('suppliers', 'update')).toEqual([])
    expect(db.payloads('supplier_payee_confirmations', 'insert')).toHaveLength(2)
  })

  it('previews on a dry run and writes nothing', async () => {
    const outcome = await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed' }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { supplier_name: 'Derome Bygg AB', current_supplier_account: 'BG 5050-1055', invoice_account: 'BG 9020-0007', updates_supplier_card: true },
    })
    expect(db.payloads('supplier_payee_confirmations', 'insert')).toEqual([])
    expect(db.payloads('suppliers', 'update')).toEqual([])
  })

  it('refuses an invoice with nothing to decide, an unknown invoice, and a failed card write before deciding', async () => {
    db.setTable('supplier_invoices', { data: invoiceRow('a', { payee_bankgiro: '5050-1055' }) })
    expect(await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed' })).toMatchObject({
      ok: false,
      code: 'SUPPLIER_PAYEE_NOTHING_TO_DECIDE',
    })
    db.setTable('supplier_invoices', { data: null })
    expect(await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed' })).toEqual({ ok: false, code: 'SI_NOT_FOUND' })

    db.setTable('supplier_invoices', { data: invoiceRow('a') })
    db.setTable('suppliers', { error: { message: 'denied', code: '42501' } })
    expect(await decideSupplierPayee(ctx(), { supplierInvoiceId: 'a', decision: 'confirmed' })).toEqual({
      ok: false,
      code: 'SUPPLIER_PAYEE_DECISION_FAILED',
    })
    expect(db.payloads('supplier_payee_confirmations', 'insert')).toEqual([])
  })
})

describe('readInvoicePayee', () => {
  it('answers the view with the latest decision, and whether the invoice can still be paid', async () => {
    db.setTable('supplier_invoices', { data: invoiceRow('a', { status: 'paid', remaining_amount: 0 }) })
    db.setTable('supplier_payee_confirmations', [
      { data: [{ supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision: 'rejected', decided_at: '2026-10-14T10:00:00Z' }] },
      { data: { decision: 'rejected', decided_at: '2026-10-14T10:00:00Z', note: null } },
    ])
    const read = await readInvoicePayee(supabase(), COMPANY, 'a')
    expect(read).toMatchObject({
      ok: true,
      view: {
        kind: 'changed',
        alert: 'changed',
        decision: 'rejected',
        hold: 'payee_rejected',
        old_payee: 'BG 5050-1055',
        new_payee: 'BG 9020-0007',
        new_payee_key: 'bankgiro:90200007',
        last_decision: { decision: 'rejected' },
        payable: false,
      },
    })
  })
})
