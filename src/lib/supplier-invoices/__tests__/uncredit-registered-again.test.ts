/**
 * "Ångra kreditering" is refused once the underlag the credit released has
 * been registered again: the original would come back beside the new
 * invoice, and the purchase would be booked twice. With the underlag still
 * unused, the undo goes ahead as before.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createRowsMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

function tables(registeredAgain: { status: string } | null) {
  const original = {
    ...makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 1000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: null,
      document_id: 'doc-1',
      approved_at: null,
    }),
    company_id: 'company-1',
    is_credit_note: false,
    payments: [],
  }
  return {
    supplier_invoices: [
      original,
      // Its credit note: no verifikat, so no storno is posted.
      { id: 'credit-1', company_id: 'company-1', is_credit_note: true, credited_invoice_id: 'inv-1', status: 'credited', registration_journal_entry_id: null, document_id: null },
      ...(registeredAgain
        ? [{ id: 'inv-2', company_id: 'company-1', is_credit_note: false, status: registeredAgain.status, document_id: 'doc-copy' }]
        : []),
    ],
    document_attachments: [
      { id: 'doc-1', company_id: 'company-1', sha256_hash: 'same-bytes' },
      { id: 'doc-copy', company_id: 'company-1', sha256_hash: 'same-bytes' },
    ],
  }
}

function uncredit(rows: ReturnType<typeof tables>, dryRun = false) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(rows, writes)
  const outcome = uncreditSupplierInvoice(
    { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log },
    'inv-1',
    { dryRun },
  )
  return { outcome, writes }
}

beforeEach(() => eventBus.clear())

describe('Ångra kreditering after the underlag was registered again', () => {
  it('is refused, naming the invoice that registers it now, and writes nothing', async () => {
    for (const dryRun of [true, false]) {
      const { outcome, writes } = uncredit(tables({ status: 'registered' }), dryRun)
      expect(await outcome).toEqual({ ok: false, code: 'SI_UNCREDIT_REGISTERED_AGAIN', details: { supplier_invoice_id: 'inv-2' } })
      expect(writes).toEqual([])
    }
  })

  it('goes ahead when that registration was credited too', async () => {
    const { outcome } = uncredit(tables({ status: 'credited' }), true)
    expect(await outcome).toMatchObject({ ok: true, dryRun: true, preview: { changed: true } })
  })

  it('goes ahead when the underlag was never registered again', async () => {
    const { outcome } = uncredit(tables(null), true)
    expect(await outcome).toMatchObject({ ok: true, dryRun: true, preview: { changed: true } })
  })
})
