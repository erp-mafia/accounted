import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readRegisteredStates } from '../pairs-read'
import type { PairableItem } from '../pairs'

const item = (id: string, overrides: Partial<PairableItem> = {}): PairableItem => ({ id, status: 'received', ...overrides })

describe('readRegisteredStates', () => {
  it('says which registered invoices can still take a payment and which are paid, with the payment verifikat', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      supplier_invoices: {
        data: [
          { id: 'si-unpaid', status: 'registered', payment_journal_entry_id: null },
          { id: 'si-paid', status: 'paid', payment_journal_entry_id: 'je-pay' },
          { id: 'si-credited', status: 'credited', payment_journal_entry_id: null },
        ],
      },
    })
    const states = await readRegisteredStates(supabase as unknown as SupabaseClient, 'company-1', [
      item('registered-unpaid', { created_supplier_invoice_id: 'si-unpaid' }),
      item('registered-paid', { created_supplier_invoice_id: 'si-paid' }),
      item('registered-credited', { created_supplier_invoice_id: 'si-credited' }),
      item('open'),
      // Booked on a verifikat as well, or moved to Arkiv: never read.
      item('booked', { created_supplier_invoice_id: 'si-booked', created_journal_entry_id: 'je-1' }),
      item('archived', { created_supplier_invoice_id: 'si-archived', routed_to_arkiv_at: '2026-10-04T00:00:00Z' }),
    ])
    expect([...states.awaitingPayment]).toEqual(['registered-unpaid'])
    expect([...states.paid]).toEqual(['registered-paid'])
    expect(states.paymentEntry.get('registered-paid')).toBe('je-pay')
    expect(findCalls('supplier_invoices', 'in')).toEqual([['id', ['si-unpaid', 'si-paid', 'si-credited']]])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('reads nothing when no item is registered', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ supplier_invoices: { data: [] } })
    const states = await readRegisteredStates(supabase as unknown as SupabaseClient, 'company-1', [item('open')])
    expect(states.awaitingPayment.size + states.paid.size).toBe(0)
    expect(findCalls('supplier_invoices', 'select')).toEqual([])
  })

  it('throws on a failed read: the caller treats a pairing it could not read as none', async () => {
    const { supabase } = createTableMockSupabase({ supplier_invoices: { data: null, error: { message: 'boom' } } })
    await expect(
      readRegisteredStates(supabase as unknown as SupabaseClient, 'company-1', [item('a', { created_supplier_invoice_id: 'si-1' })]),
    ).rejects.toThrow('supplier invoice status read failed')
  })
})
