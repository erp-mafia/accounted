import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  checkCustomerDeletable,
  customerDeleteBlocker,
  type CustomerDependents,
} from '../delete-guard'

const NONE: CustomerDependents = {
  issued_invoices: 0,
  draft_invoices: 0,
  sales_orders: 0,
  recurring_invoice_schedules: 0,
}

describe('customerDeleteBlocker', () => {
  it('lets a customer nothing points at go', () => {
    expect(customerDeleteBlocker(NONE)).toBeNull()
  })

  it('refuses for an unnumbered draft, the crm#263 case', () => {
    expect(customerDeleteBlocker({ ...NONE, draft_invoices: 1 })).toBe('CUSTOMER_HAS_DRAFT_INVOICES')
  })

  it('names the issued invoices first: deleting drafts would not free the customer', () => {
    expect(
      customerDeleteBlocker({ ...NONE, issued_invoices: 1, draft_invoices: 3, sales_orders: 2 }),
    ).toBe('CUSTOMER_HAS_ISSUED_INVOICES')
  })

  it('refuses for sales orders and recurring invoices once no invoice is in the way', () => {
    expect(customerDeleteBlocker({ ...NONE, sales_orders: 1, recurring_invoice_schedules: 1 })).toBe(
      'CUSTOMER_HAS_SALES_ORDERS',
    )
    expect(customerDeleteBlocker({ ...NONE, recurring_invoice_schedules: 1 })).toBe(
      'CUSTOMER_HAS_RECURRING_INVOICES',
    )
  })
})

describe('checkCustomerDeletable', () => {
  it('counts each dependent table for this customer and company', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      invoices: [{ count: 0 }, { count: 2 }],
      sales_orders: { count: 0 },
      recurring_invoice_schedules: { count: 0 },
    })

    const result = await checkCustomerDeletable(supabase as unknown as SupabaseClient, 'company-1', 'cust-1')

    expect(result).toEqual({
      deletable: false,
      code: 'CUSTOMER_HAS_DRAFT_INVOICES',
      dependents: { issued_invoices: 0, draft_invoices: 2, sales_orders: 0, recurring_invoice_schedules: 0 },
    })
    for (const table of ['invoices', 'sales_orders', 'recurring_invoice_schedules']) {
      expect(findCalls(table, 'eq')).toContainEqual(['company_id', 'company-1'])
      expect(findCalls(table, 'eq')).toContainEqual(['customer_id', 'cust-1'])
    }
    // Issued = left draft, or numbered (a numbered draft is makulerad, kept).
    expect(findCalls('invoices', 'or')).toEqual([['status.neq.draft,invoice_number.not.is.null']])
    // Draft = the rows a delete actually removes.
    expect(findCalls('invoices', 'is')).toEqual([['invoice_number', null]])
  })

  it('is deletable when every count is zero', async () => {
    const { supabase } = createTableMockSupabase({
      invoices: { count: 0 },
      sales_orders: { count: 0 },
      recurring_invoice_schedules: { count: 0 },
    })

    const result = await checkCustomerDeletable(supabase as unknown as SupabaseClient, 'company-1', 'cust-1')

    expect(result).toEqual({ deletable: true, dependents: NONE })
  })

  it('throws when a count fails instead of deleting on a guess', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase } = createTableMockSupabase({
      invoices: { count: 0 },
      sales_orders: { error: dbError },
      recurring_invoice_schedules: { count: 0 },
    })

    await expect(
      checkCustomerDeletable(supabase as unknown as SupabaseClient, 'company-1', 'cust-1'),
    ).rejects.toBe(dbError)
  })
})
