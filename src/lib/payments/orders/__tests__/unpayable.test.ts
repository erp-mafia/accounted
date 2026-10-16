import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { unpayableOrders } from '../release'
import { COMPANY, order } from './fixtures'

const TAX = { purpose: 'skattekonto', supplier_invoice_id: null, payee_name: 'Skatteverket', payee_source: 'skatteverket', reference: '1655954700217' } as const

describe('unpayableOrders', () => {
  it('never counts a skattekonto payment: it has no invoice that could close under it', async () => {
    const db = createTableMockSupabase({
      supplier_invoices: {
        data: [
          { id: 'inv-o1', company_id: COMPANY, status: 'paid', is_credit_note: false, remaining_amount: 0 },
          { id: 'inv-o2', company_id: COMPANY, status: 'approved', is_credit_note: false, remaining_amount: 737.5 },
        ],
      },
    })
    const unpayable = await unpayableOrders(db.supabase as unknown as SupabaseClient, [order('o1'), order('o2'), order('t1', TAX)])
    expect([...unpayable]).toEqual(['o1'])
  })

  it('reads no invoice at all for skattekonto payments alone', async () => {
    const db = createTableMockSupabase({})
    const unpayable = await unpayableOrders(db.supabase as unknown as SupabaseClient, [order('t1', TAX)])
    expect(unpayable.size).toBe(0)
    expect(db.tables()).not.toContain('supplier_invoices')
  })
})
