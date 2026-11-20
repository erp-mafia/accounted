import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn() }))

import { BANK_PAYMENTS_PER_PACK, allowanceOf, getBankPaymentsUsage, readBankPaymentsAllowance } from '../usage'
import { bankPaymentsAllowanceRefusal } from '../allowance'

/**
 * The cap with bank payment packs (issue #132): the base (an operator's
 * override, else 10) plus 100 per pack the company bought on its
 * subscription. One definition, read by the counter and both signing doors.
 */

const COMPANY = 'c0000000-0000-4000-8000-000000000001'

function sent(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, cash_account_id: 'a1' }))
}

describe('allowanceOf', () => {
  it('adds the packs to the default, and to an operator\'s override', () => {
    expect(BANK_PAYMENTS_PER_PACK).toBe(100)
    expect(allowanceOf(null)).toEqual({ base: 10, packs: 0, included: 10 })
    expect(allowanceOf({ monthly_payments: null, purchased_packs: 1 })).toEqual({ base: 10, packs: 1, included: 110 })
    expect(allowanceOf({ monthly_payments: 40, purchased_packs: 2 })).toEqual({ base: 40, packs: 2, included: 240 })
    // An override of 0 stops the base, not what was bought.
    expect(allowanceOf({ monthly_payments: 0, purchased_packs: 1 })).toEqual({ base: 0, packs: 1, included: 100 })
  })

  it('reads a row from before the column (deploy ahead of its migration) as no packs', () => {
    expect(allowanceOf({ monthly_payments: 40 })).toEqual({ base: 40, packs: 0, included: 40 })
  })
})

describe('readBankPaymentsAllowance', () => {
  it('reads the whole row, so a missing purchased_packs column cannot fail a signing', async () => {
    const db = createTableMockSupabase({ company_bank_payment_allowances: { data: { monthly_payments: null, purchased_packs: 3 } } })
    expect(await readBankPaymentsAllowance(db.supabase as unknown as SupabaseClient, COMPANY)).toEqual({ base: 10, packs: 3, included: 310 })
    expect(db.findCall('company_bank_payment_allowances', 'select')).toEqual(['*'])
    expect(db.findCall('company_bank_payment_allowances', 'eq')).toEqual(['company_id', COMPANY])
  })
})

describe('the cap with packs', () => {
  it('counts the bought payments into what the month includes and what remains', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: sent(57) },
      company_bank_payment_allowances: { data: { monthly_payments: null, purchased_packs: 1 } },
    })
    expect(await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, COMPANY, '2026-10')).toMatchObject({
      payments_sent: 57,
      included_payments: 110,
      remaining_payments: 53,
      extra_payments: 0,
    })
  })

  it('lets a signing through on bought payments, and refuses past them', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: sent(100) },
      company_bank_payment_allowances: { data: { monthly_payments: null, purchased_packs: 1 } },
    })
    const supabase = db.supabase as unknown as SupabaseClient
    expect(await bankPaymentsAllowanceRefusal(supabase, COMPANY, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'], '2026-10')).toBeNull()
    expect(await bankPaymentsAllowanceRefusal(supabase, COMPANY, Array.from({ length: 11 }, (_, i) => `n${i}`), '2026-10')).toMatchObject({
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { used: 100, included: 110, remaining: 10, requested: 11 },
    })
  })
})
