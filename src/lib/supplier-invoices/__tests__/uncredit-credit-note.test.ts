/**
 * "Ångra kreditering" undoes a credit from the original invoice, never from
 * the credit note. A credit note rests at 'credited' as well
 * (SUPPLIER_CREDIT_NOTE_STATUS), so its own id passed the "is it credited"
 * gate: the dry run, and with it the MCP staging, promised to restore the
 * credit note as an invoice to pay, and the commit tried to write that, which
 * supplier_invoices_credit_note_not_payable refuses. A credit note's id is
 * refused on its own row, before any other read and any write, the same at
 * every door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** What Postgres answers a credit note moved to a payable status (tests/pg/supplier-credit-note-not-payable.pg.test.ts). */
const NOT_PAYABLE = {
  code: '23514',
  message: 'new row for relation "supplier_invoices" violates check constraint "supplier_invoices_credit_note_not_payable"',
}

/** A credit note as Kreditera writes it (buildSupplierCreditNoteRow): 'credited', nothing to pay, its original named. */
function creditNote(overrides: Parameters<typeof makeSupplierInvoice>[0] = {}) {
  return makeSupplierInvoice({
    id: 'credit-1',
    status: 'credited',
    is_credit_note: true,
    credited_invoice_id: 'inv-1',
    total: 1000,
    remaining_amount: 0,
    // Dated the day of the credit, so past due today.
    invoice_date: '2026-11-02',
    due_date: '2026-11-02',
    registration_journal_entry_id: 'je-credit',
    ...overrides,
    // The uncredit reads the payments embedded on the row.
    ...({ payments: [] } as object),
  })
}

function run(row: ReturnType<typeof creditNote>, dryRun: boolean) {
  const mock = createTableMockSupabase({
    supplier_invoices: [
      { data: row },
      // No live credit note credits a credit note.
      { data: null },
      // The restore of the row the id names.
      { data: null, error: NOT_PAYABLE },
    ],
  })
  const outcome = uncreditSupplierInvoice(
    { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log },
    row.id,
    { dryRun },
  )
  return { mock, outcome }
}

describe("uncreditSupplierInvoice: a credit note's own id", () => {
  beforeEach(() => {
    eventBus.clear()
    vi.restoreAllMocks()
  })

  it('is a registered 400 with a Swedish sentence that sends the user to the original', () => {
    const entry = getErrorEntry('SI_UNCREDIT_CREDIT_NOTE')
    expect(entry?.httpStatus).toBe(400)
    expect(entry?.message_sv).toContain('originalfakturan')
    expect(entry?.message_sv).toContain('Ångra kreditering')
    expect(entry?.remediation?.description).toContain('credited_invoice_id')
    expect(entry?.retryable).toBeFalsy()
  })

  it('never sends anyone to an original that the credit note is not linked to', () => {
    // Uncredit finds a credit note only through credited_invoice_id, and
    // most imported credit notes have none: undoing the credit on an
    // original picked by hand would restore it and leave the credit note.
    const entry = getErrorEntry('SI_UNCREDIT_CREDIT_NOTE')
    expect(entry?.message_sv).toContain('Annars går krediteringen inte att ångra här')
    expect(entry?.message_en).toContain('When that is null')
    expect(entry?.remediation?.description).toContain('ask the person')
  })

  it('a dry run refuses it, so neither a preview nor a staged proposal promises a restore', async () => {
    const { mock, outcome } = run(creditNote(), true)
    expect(await outcome).toEqual({
      ok: false,
      code: 'SI_UNCREDIT_CREDIT_NOTE',
      details: { credit_note_id: 'credit-1', credited_invoice_id: 'inv-1' },
    })
    // Refused on the row the id names: no credit note lookup, no verifikat read.
    expect(mock.tables()).toEqual(['supplier_invoices'])
  })

  it('the commit refuses it and writes nothing: no storno, no status, no event', async () => {
    const emit = vi.spyOn(eventBus, 'emit')
    const { mock, outcome } = run(creditNote(), false)
    const result = await outcome
    expect(result).toMatchObject({ ok: false, code: 'SI_UNCREDIT_CREDIT_NOTE' })
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([])
    expect(mock.tables()).toEqual(['supplier_invoices'])
    expect(emit).not.toHaveBeenCalled()
  })

  it('an imported credit note that names no original is refused the same way', async () => {
    const { outcome } = run(creditNote({ credited_invoice_id: null, registration_journal_entry_id: null }), false)
    expect(await outcome).toMatchObject({
      ok: false,
      code: 'SI_UNCREDIT_CREDIT_NOTE',
      details: { credit_note_id: 'credit-1', credited_invoice_id: null },
    })
  })

  it('a credit note already undone (reversed) is refused too, never answered as a no-op on the credit note', async () => {
    const { mock, outcome } = run(creditNote({ status: 'reversed' }), false)
    expect(await outcome).toMatchObject({ ok: false, code: 'SI_UNCREDIT_CREDIT_NOTE' })
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([])
  })
})
