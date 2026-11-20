/**
 * The supplier_payee_change row (../categories.ts): one row per unpaid
 * supplier invoice whose stated bank details nobody decided on, derived from
 * the invoice, the supplier card and the decisions; a decision either way
 * resolves the row.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { countSupplierPayeeChangesDue, listSupplierPayeeChangesDue } from '../categories'
import { getWorklistCounts } from '../aggregate'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
let db: ReturnType<typeof createTableMockSupabase>
const supabase = () => db.supabase as unknown as SupabaseClient

const INVOICE = {
  id: 'inv-1',
  supplier_id: 'sup-1',
  supplier_invoice_number: 'F-1',
  arrival_number: 12,
  due_date: '2026-10-31',
  payee_bankgiro: '9020-0007',
  payee_plusgiro: null,
  payee_clearing: null,
  payee_account: null,
  payee_iban: null,
  supplier: { id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null },
}

beforeEach(() => {
  db = createTableMockSupabase({ supplier_invoices: { data: [INVOICE] } })
})

describe('listSupplierPayeeChangesDue', () => {
  it('lists an invoice whose new account nobody decided on, as the Att göra row reads it', async () => {
    db.setTable('supplier_payee_confirmations', { data: [] })
    expect(await listSupplierPayeeChangesDue(supabase(), COMPANY)).toEqual([
      expect.objectContaining({
        supplier_invoice_id: 'inv-1',
        supplier_name: 'Derome Bygg AB',
        supplier_invoice_number: 'F-1',
        alert: 'changed',
        decision: null,
        hold: 'payee_unconfirmed',
        old_payee: 'BG 5050-1055',
        new_payee: 'BG 9020-0007',
      }),
    ])
    expect(await countSupplierPayeeChangesDue(supabase(), COMPANY)).toBe(1)
  })

  it('drops the row once a person confirmed the account, or rejected it', async () => {
    for (const decision of ['confirmed', 'rejected'] as const) {
      db.setTable('supplier_payee_confirmations', {
        data: [{ supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision, decided_at: '2026-10-14T10:00:00Z' }],
      })
      expect(await listSupplierPayeeChangesDue(supabase(), COMPANY)).toEqual([])
    }
  })

  it('drops the row once the card holds the account', async () => {
    db.setTable('supplier_invoices', { data: [{ ...INVOICE, supplier: { ...INVOICE.supplier, bankgiro: '9020-0007' } }] })
    expect(await listSupplierPayeeChangesDue(supabase(), COMPANY)).toEqual([])
  })

  it('soft-fails to nothing due when a read breaks', async () => {
    db.setTable('supplier_invoices', { error: { message: 'boom' } })
    expect(await listSupplierPayeeChangesDue(supabase(), COMPANY)).toEqual([])
    expect(await countSupplierPayeeChangesDue(supabase(), COMPANY)).toBe(0)
  })
})

describe('getWorklistCounts', () => {
  it('counts the rows from the list the caller already fetched, and in the total', async () => {
    const row = (await (async () => {
      db.setTable('supplier_payee_confirmations', { data: [] })
      return listSupplierPayeeChangesDue(supabase(), COMPANY)
    })())[0]!
    const counts = await getWorklistCounts(supabase(), COMPANY, {
      suggestedMatches: [],
      expensePayoutsDue: [],
      skattekontoPaymentDue: null,
      bankSwitchDue: [],
      paymentsVerificationDue: null,
      supplierPayeeChangesDue: [row],
    })
    expect(counts.counts.supplier_payee_change).toBe(1)
    expect(counts.total).toBeGreaterThanOrEqual(1)
  })
})
