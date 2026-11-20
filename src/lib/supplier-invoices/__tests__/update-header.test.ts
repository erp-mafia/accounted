/**
 * updateSupplierInvoiceHeader: the one rule behind the dashboard PUT, the v1
 * PATCH and gnubok_update_supplier_invoice (crm#1848). The doors' own
 * envelopes are tested with the routes and the tool; this file pins the rule:
 * header fields only, an unsettled invoice only, never a field the posted
 * registration verifikat carries, and never a journal table.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { updateSupplierInvoiceHeader } from '../update-header'

const COMPANY = 'company-1'
const INVOICE = 'si-1'
const ENTRY = 'je-1'
const PAST = '2000-01-01'
const FUTURE = '2999-01-01'

const STORED = {
  id: INVOICE,
  company_id: COMPANY,
  status: 'registered',
  due_date: FUTURE,
  remaining_amount: 1000,
  is_credit_note: false,
  is_self_billed: false,
  approved_at: null as string | null,
  invoice_date: '2026-06-30',
  supplier_invoice_number: 'F-1001',
  registration_journal_entry_id: null as string | null,
  notes: null as string | null,
}

type Chain = Parameters<TableMockResolver>[0]
const eqValue = (chain: Chain, column: string) => chain.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]
const isWrite = (chain: Chain) => chain.some((c) => c.method === 'update')

/**
 * A table holding one invoice. A read answers it only to its own company; a
 * write answers the merged row, or nothing when `writeMatches` is false (the
 * compare-and-swap lost). `after` is what a re-read then finds.
 */
function invoiceTable(
  stored: Record<string, unknown> | null,
  options: { writeMatches?: boolean; after?: Record<string, unknown> | null } = {},
): TableMockResolver {
  let written = false
  return (chain) => {
    if (isWrite(chain)) {
      written = true
      if (options.writeMatches === false || !stored) return { data: null }
      const payload = chain.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
      return { data: { ...stored, ...payload } }
    }
    const row = written && options.after !== undefined ? options.after : stored
    if (!row || eqValue(chain, 'company_id') !== row.company_id || eqValue(chain, 'id') !== row.id) return { data: null }
    return { data: row }
  }
}

function setup(table: TableMockResolver, companyId = COMPANY) {
  const mock = createTableMockSupabase({ supplier_invoices: table })
  const ctx = {
    supabase: mock.supabase,
    companyId,
    userId: 'user-1',
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as unknown as OperationContext
  return { mock, ctx, written: () => mock.payloads('supplier_invoices', 'update') }
}

describe('updateSupplierInvoiceHeader: what it changes', () => {
  it('moves the due date of an unpaid invoice and answers the stored row', async () => {
    const { ctx, mock, written } = setup(invoiceTable(STORED))

    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { due_date: '2999-02-01', notes: 'Ny förfallodag' })

    expect(outcome).toMatchObject({ ok: true, data: { id: INVOICE, due_date: '2999-02-01', notes: 'Ny förfallodag' } })
    expect(written()).toEqual([{ due_date: '2999-02-01', notes: 'Ny förfallodag' }])
    // The write holds only while the invoice is still in the status the gate read.
    const pinned = mock.findCalls('supplier_invoices', 'eq').map(([column, value]) => `${String(column)}=${String(value)}`)
    expect(pinned).toContain('status=registered')
    expect(pinned).toContain(`company_id=${COMPANY}`)
  })

  it('reads and writes supplier_invoices only: never a journal entry or a journal line', async () => {
    const booked = { ...STORED, registration_journal_entry_id: ENTRY }
    const { ctx, mock } = setup(invoiceTable(booked))

    await updateSupplierInvoiceHeader(ctx, INVOICE, { due_date: '2999-02-01', payment_reference: '5501200018' })

    expect(new Set(mock.tables())).toEqual(new Set(['supplier_invoices']))
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('a booked invoice still takes due date, reference and notes, and the stored number and date sent back', async () => {
    const booked = { ...STORED, registration_journal_entry_id: ENTRY }
    const { ctx, mock, written } = setup(invoiceTable(booked))

    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, {
      due_date: '2999-02-01',
      invoice_date: booked.invoice_date,
      supplier_invoice_number: booked.supplier_invoice_number,
    })

    expect(outcome.ok).toBe(true)
    expect(written()).toHaveLength(1)
    // Nothing the verifikat carries moves, so the entry column is not pinned.
    expect(mock.findCalls('supplier_invoices', 'is').map(([column]) => column)).not.toContain('registration_journal_entry_id')
  })

  it('an unbooked invoice takes a new date, pinned against a registration entry posted meanwhile', async () => {
    const { ctx, mock, written } = setup(invoiceTable(STORED))

    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { invoice_date: '2026-07-15' })

    expect(outcome.ok).toBe(true)
    expect(written()).toEqual([{ invoice_date: '2026-07-15' }])
    expect(mock.findCalls('supplier_invoices', 'is')).toContainEqual(['registration_journal_entry_id', null])
  })

  it('the overdue label follows the due date, both ways, and keeps an attest', async () => {
    const overdue = { ...STORED, status: 'overdue', due_date: PAST, approved_at: '2026-01-01T08:00:00Z' }
    const back = setup(invoiceTable(overdue))
    await updateSupplierInvoiceHeader(back.ctx, INVOICE, { due_date: FUTURE })
    expect(back.written()).toEqual([{ due_date: FUTURE, status: 'approved' }])

    const late = setup(invoiceTable(STORED))
    await updateSupplierInvoiceHeader(late.ctx, INVOICE, { due_date: PAST })
    expect(late.written()).toEqual([{ due_date: PAST, status: 'overdue' }])
  })

  it('keepStatus leaves the label to the daily check', async () => {
    const { ctx, written } = setup(invoiceTable(STORED))
    await updateSupplierInvoiceHeader(ctx, INVOICE, { due_date: PAST }, { keepStatus: true })
    expect(written()).toEqual([{ due_date: PAST }])
  })

  it('a dry run answers the resulting header with each change, and writes nothing', async () => {
    const { ctx, written } = setup(invoiceTable(STORED))

    const outcome = await updateSupplierInvoiceHeader(
      ctx,
      INVOICE,
      { due_date: PAST, supplier_invoice_number: STORED.supplier_invoice_number },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        id: INVOICE,
        due_date: PAST,
        status: 'overdue',
        // The number sent back unchanged is not a change.
        changes: { due_date: { from: FUTURE, to: PAST } },
      },
    })
    expect(written()).toEqual([])
  })
})

describe('updateSupplierInvoiceHeader: what it refuses', () => {
  it('an update with no field is a validation error before anything is read', async () => {
    const { ctx, mock } = setup(invoiceTable(STORED))
    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { due_date: undefined })
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(mock.tables()).toEqual([])
  })

  it('an unknown invoice is not found', async () => {
    const { ctx, written } = setup(invoiceTable(null))
    expect(await updateSupplierInvoiceHeader(ctx, INVOICE, { notes: 'x' })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
    expect(written()).toEqual([])
  })

  it("another company's invoice is not found, dry run included", async () => {
    const { ctx, written } = setup(invoiceTable(STORED), 'company-2')
    expect(await updateSupplierInvoiceHeader(ctx, INVOICE, { notes: 'x' })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
    expect(await updateSupplierInvoiceHeader(ctx, INVOICE, { notes: 'x' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'SI_NOT_FOUND',
    })
    expect(written()).toEqual([])
  })

  it.each(['paid', 'partially_paid', 'credited', 'reversed'])('a %s invoice is refused', async (status) => {
    const { ctx, written } = setup(invoiceTable({ ...STORED, status }))
    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { due_date: FUTURE })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_EDIT_INVALID_STATUS', details: { currentStatus: status } })
    expect(written()).toEqual([])
  })

  it.each([
    [{ invoice_date: '2026-07-15' }, ['invoice_date']],
    [{ supplier_invoice_number: 'F-2002' }, ['supplier_invoice_number']],
    [{ invoice_date: '2026-07-15', supplier_invoice_number: 'F-2002', due_date: FUTURE }, ['invoice_date', 'supplier_invoice_number']],
  ])('a field the posted registration verifikat carries is refused: %j', async (patch, fields) => {
    const { ctx, written } = setup(invoiceTable({ ...STORED, registration_journal_entry_id: ENTRY }))

    const live = await updateSupplierInvoiceHeader(ctx, INVOICE, patch)
    const dry = await updateSupplierInvoiceHeader(ctx, INVOICE, patch, { dryRun: true })

    for (const outcome of [live, dry]) {
      expect(outcome).toMatchObject({
        ok: false,
        code: 'SI_EDIT_VERIFIKAT_LOCKED',
        details: { fields, journal_entry_id: ENTRY },
      })
    }
    expect(written()).toEqual([])
  })

  it('an issued self-billing invoice keeps its number', async () => {
    const { ctx, written } = setup(invoiceTable({ ...STORED, is_self_billed: true }))
    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { supplier_invoice_number: 'SF-099' })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_SELF_BILL_IMMUTABLE', details: { fields: ['supplier_invoice_number'] } })
    expect(written()).toEqual([])
  })

  it("a door's own gate is asked first and can only refuse", async () => {
    const { ctx, written } = setup(invoiceTable({ ...STORED, status: 'approved' }))
    const outcome = await updateSupplierInvoiceHeader(
      ctx,
      INVOICE,
      { notes: 'x' },
      { doorGate: (existing) => (existing.status === 'registered' ? null : { ok: false, code: 'SI_NOT_DRAFT' }) },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SI_NOT_DRAFT' })
    expect(written()).toEqual([])
  })

  it('a registration entry that lands between the read and the write is reported as the lock', async () => {
    const { ctx } = setup(
      invoiceTable(STORED, { writeMatches: false, after: { ...STORED, registration_journal_entry_id: ENTRY } }),
    )
    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { invoice_date: '2026-07-15' })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'SI_EDIT_VERIFIKAT_LOCKED',
      details: { fields: ['invoice_date'], journal_entry_id: ENTRY, reason: 'race' },
    })
  })

  it('a payment that lands between the read and the write is a conflict, not an edit of a paid invoice', async () => {
    const { ctx } = setup(invoiceTable(STORED, { writeMatches: false, after: { ...STORED, status: 'paid' } }))
    const outcome = await updateSupplierInvoiceHeader(ctx, INVOICE, { notes: 'x' })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'SI_EDIT_CONFLICT',
      details: { expectedStatus: 'registered', reason: 'race' },
    })
  })

  it('a failed read or write is a failure, never a silent success', async () => {
    const readFails = setup(() => ({ data: null, error: { message: 'boom' } }))
    expect(await updateSupplierInvoiceHeader(readFails.ctx, INVOICE, { notes: 'x' })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })

    const writeFails = setup((chain) => (isWrite(chain) ? { data: null, error: { message: 'boom' } } : { data: STORED }))
    expect(await updateSupplierInvoiceHeader(writeFails.ctx, INVOICE, { notes: 'x' })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })
  })
})
