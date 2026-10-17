/**
 * A payment in to the skattekonto never books through the supplier payment
 * settlement: its bank debit is booked once, like any bank row to
 * Skatteverket (against the skattekonto account), and the order neither
 * matches the debit nor creates a journal entry when the bank executes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))

import { loadOpenPaymentOrders, settleOrderWithDebit } from '../auto-settle'
import { findOrderForDebit, isDebitSettleableOrder } from '../debit-match'
import { ARCIM, arcimDebit, arcimOrder } from './fixtures'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger

/** An executed payment in to the skattekonto: Skatteverket's bankgiro, the company OCR, no supplier invoice. */
const taxOrder = arcimOrder({
  purpose: 'skattekonto',
  supplier_invoice_id: null,
  payee_bankgiro: '50501055',
  payee_name: 'Skatteverket',
  payee_source: 'skatteverket',
  reference_type: 'ocr',
  reference: '1655954700217',
  amount: 77404,
} as never)

const taxDebit = arcimDebit({
  amount: -77404,
  description: 'SKATTEVERKET BG 50501055',
  end_to_end_id: taxOrder.end_to_end_id,
  potential_supplier_invoice_id: null,
})

let db: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  db = createTableMockSupabase({
    payment_orders: { data: taxOrder },
    transactions: { data: taxDebit },
  })
})

describe('an executed skattekonto payment and its bank debit', () => {
  it('is no order a debit settles, even when the debit names its end-to-end id', () => {
    expect(isDebitSettleableOrder(taxOrder)).toBe(false)
    expect(
      findOrderForDebit(
        {
          amount: taxDebit.amount,
          currency: 'SEK',
          date: taxDebit.date,
          cash_account_id: taxDebit.cash_account_id ?? null,
          description: taxDebit.description,
          end_to_end_id: taxOrder.end_to_end_id,
        },
        [taxOrder],
      ),
    ).toBeNull()
  })

  it('is left out of the open orders the import settles against', async () => {
    db.setTable('payment_orders', { data: [taxOrder] })
    expect(await loadOpenPaymentOrders(db.supabase as unknown as SupabaseClient, ARCIM.companyId)).toEqual([])
    expect(db.findCalls('payment_orders', 'not')).toContainEqual(['supplier_invoice_id', 'is', null])
  })

  it('is refused by the settlement before anything is booked', async () => {
    const result = await settleOrderWithDebit(db.supabase as unknown as SupabaseClient, {
      order: { id: taxOrder.id, company_id: ARCIM.companyId },
      transaction: { id: taxDebit.id },
      confidence: 0.99,
      basis: 'end_to_end_id',
      log,
    })

    expect(result).toEqual({ ok: false, reason: 'order_not_open' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })
})
