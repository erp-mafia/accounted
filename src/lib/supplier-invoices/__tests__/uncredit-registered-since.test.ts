/**
 * "Ångra kreditering" asks again, right before its first write, whether the
 * released underlag has been registered since the first check: a
 * registration that lands in between still stops the undo, before the storno.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registeredAgainAs = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supplier-invoices/released-underlag', () => ({ registeredAgainAs }))
const reverseJournalEntry = vi.hoisted(() => vi.fn())
vi.mock('@/lib/posting/port', () => ({ postingPort: { reverseJournalEntry } }))

import { createRowsMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: vi.fn(), child: () => log } as never

function rows() {
  return {
    supplier_invoices: [
      {
        ...makeSupplierInvoice({ id: 'inv-1', status: 'credited', total: 1000, remaining_amount: 0, due_date: '2099-12-31', document_id: 'doc-1', approved_at: null }),
        company_id: 'company-1',
        is_credit_note: false,
        payments: [],
      },
      { id: 'credit-1', company_id: 'company-1', is_credit_note: true, credited_invoice_id: 'inv-1', status: 'credited', registration_journal_entry_id: 'je-credit' },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('Ångra kreditering and a registration of the same underlag', () => {
  it('a registration between the first check and the storno stops the undo before anything is written', async () => {
    registeredAgainAs.mockResolvedValueOnce(null).mockResolvedValueOnce({ supplier_invoice_id: 'inv-2' })
    const writes: { table: string; method: string; row: unknown }[] = []
    const mock = createRowsMockSupabase(rows(), writes)
    const outcome = await uncreditSupplierInvoice({ supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log }, 'inv-1')
    expect(outcome).toEqual({ ok: false, code: 'SI_UNCREDIT_REGISTERED_AGAIN', details: { supplier_invoice_id: 'inv-2' } })
    expect(reverseJournalEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('one that slips in after the storno is logged with both invoices', async () => {
    registeredAgainAs.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ supplier_invoice_id: 'inv-2' })
    reverseJournalEntry.mockResolvedValue({ id: 'je-storno' })
    const mock = createRowsMockSupabase(rows())
    const outcome = await uncreditSupplierInvoice({ supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log }, 'inv-1')
    expect(outcome).toMatchObject({ ok: true, data: { changed: true, reversal_entry_id: 'je-storno' } })
    expect((log as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith(
      expect.stringContaining('registered again while the credit was undone'),
      expect.any(Error),
      { supplierInvoiceId: 'inv-1', registeredAgainAs: { supplier_invoice_id: 'inv-2' } },
    )
  })
})
