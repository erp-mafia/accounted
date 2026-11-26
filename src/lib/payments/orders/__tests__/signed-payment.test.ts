import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'
import { formatCurrency } from '@/lib/utils'
import {
  BANK_PAYMENT_CHECK_FAILED_WARNING,
  bankHeldPaymentWarning,
  checkBankHeldPayments,
  findBankHeldPayments,
  findSignedBankPayment,
  signedBankPaymentDetails,
  SIGNED_BANK_PAYMENT_WARNING,
  UNSIGNED_BANK_PAYMENT_WARNING,
  type BankHeldPayment,
} from '../signed-payment'
import { isOpenPaymentOrder, PAYMENT_ORDER_STATUSES, SIGNED_PAYMENT_ORDER_STATUSES } from '../status'

const { supabase, setTable, reset, findCall, findCalls } = createTableMockSupabase()
const client = supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('SI_BANK_PAYMENT_UNDER_WAY', () => {
  // A verifikat booked from the order's own bank row is refused on the link, and
  // by then the bank refuses a cancel: the text must name what still works.
  it('names the way out once the money has left, not only the cancel', () => {
    const entry = getErrorEntry('SI_BANK_PAYMENT_UNDER_WAY')
    expect(entry?.message_sv).toContain('koppla bankraden till fakturan')
    expect(entry?.message_en).toContain('match the bank row to the invoice')
    expect(entry?.remediation?.description).toContain('storno_existing')
  })
})

describe('findSignedBankPayment (crm#1243)', () => {
  it('asks for the invoice\'s orders that are signed or being signed, inside the company', async () => {
    setTable('payment_orders', { data: [] })

    expect(await findSignedBankPayment(client, 'company-1', 'si-1')).toBeNull()

    expect(findCalls('payment_orders', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['supplier_invoice_id', 'si-1'],
    ])
    expect(findCall('payment_orders', 'in')).toEqual(['status', ['awaiting_signature', 'awaiting_second_signer', 'accepted']])
  })

  it('answers the newest such order', async () => {
    setTable('payment_orders', { data: [{ id: 'order-1', status: 'accepted', requested_execution_date: '2026-10-30' }] })

    const found = await findSignedBankPayment(client, 'company-1', 'si-1')

    expect(found).toEqual({ id: 'order-1', status: 'accepted', requested_execution_date: '2026-10-30' })
    expect(findCall('payment_orders', 'order')).toEqual(['created_at', { ascending: false }])
    expect(signedBankPaymentDetails(found!)).toEqual({
      payment_order_id: 'order-1',
      payment_order_status: 'accepted',
      requested_execution_date: '2026-10-30',
    })
  })

  it('throws when the orders cannot be read: a guard never passes on a failed read', async () => {
    setTable('payment_orders', { data: null, error: { message: 'boom' } })
    await expect(findSignedBankPayment(client, 'company-1', 'si-1')).rejects.toEqual({ message: 'boom' })
  })
})

describe('SIGNED_PAYMENT_ORDER_STATUSES', () => {
  it('is the open states the bank pays without anyone acting again', () => {
    for (const status of PAYMENT_ORDER_STATUSES) {
      const expected = status === 'awaiting_signature' || status === 'awaiting_second_signer' || status === 'accepted'
      expect(SIGNED_PAYMENT_ORDER_STATUSES.has(status)).toBe(expected)
    }
  })

  it('is a subset of the open orders: a failed, rejected or cancelled order never refuses a payment', () => {
    for (const status of SIGNED_PAYMENT_ORDER_STATUSES) {
      expect(isOpenPaymentOrder({ status, supplier_invoice_payment_id: null })).toBe(true)
    }
    for (const status of ['failed', 'rejected', 'cancelled', 'executed', 'draft', 'approved', 'submitted'] as const) {
      expect(SIGNED_PAYMENT_ORDER_STATUSES.has(status)).toBe(false)
    }
  })
})

/**
 * The statuses cancel_open_payment_orders_for_closed_invoice leaves to the
 * bank when an invoice closes: it records invoice_closed on them and cancels
 * none (migration 20261010090000, section 7).
 */
function statusesTheTriggerLeavesToTheBank(): string[] {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261010090000_payment_orders.sql'), 'utf8')
  const fn = sql.slice(
    sql.indexOf('FUNCTION public.cancel_open_payment_orders_for_closed_invoice()'),
    sql.indexOf('CREATE TRIGGER cancel_open_payment_orders_for_closed_invoice'),
  )
  const recorded = fn.slice(fn.indexOf("'invoice_closed'")).match(/po\.status IN \(([^)]*)\)/)
  expect(recorded).not.toBeNull()
  return [...recorded![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!)
}

const ORDER_ROW = {
  id: 'order-1',
  supplier_invoice_id: 'si-1',
  status: 'accepted',
  requested_execution_date: '2026-12-01',
  amount: 12500,
  currency: 'SEK',
  payee_name: 'Leverantören AB',
  supplier_invoice: { supplier_invoice_number: 'F-1001' },
}

const SIGNED: BankHeldPayment = {
  supplier_invoice_id: 'si-1',
  supplier_invoice_number: 'F-1001',
  payment_order_id: 'order-1',
  status: 'accepted',
  signed: true,
  requested_execution_date: '2026-12-01',
  amount: 12500,
  currency: 'SEK',
  payee_name: 'Leverantören AB',
}
const UNSIGNED: BankHeldPayment = { ...SIGNED, status: 'submitted', signed: false }

describe('findBankHeldPayments', () => {
  it('asks for the orders the bank holds, inside the company: the statuses the closed-invoice trigger leaves to the bank', async () => {
    setTable('payment_orders', { data: [] })

    expect(await findBankHeldPayments(client, 'company-1', ['si-1', 'si-2', 'si-1'])).toEqual(new Map())

    expect(findCalls('payment_orders', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('payment_orders', 'in')).toEqual([
      ['supplier_invoice_id', ['si-1', 'si-2']],
      ['status', statusesTheTriggerLeavesToTheBank()],
    ])
    // Unsigned at the bank, or signed (or being signed): never a draft, an approved or a closed order.
    expect(statusesTheTriggerLeavesToTheBank()).toEqual(['submitted', ...SIGNED_PAYMENT_ORDER_STATUSES])
  })

  it('reads nothing for no invoices', async () => {
    expect(await findBankHeldPayments(client, 'company-1', [])).toEqual(new Map())
    expect(findCall('payment_orders', 'select')).toBeUndefined()
  })

  it('answers each order by its invoice: signed or not, its day, amount and payee', async () => {
    setTable('payment_orders', {
      data: [
        ORDER_ROW,
        { ...ORDER_ROW, id: 'order-2', supplier_invoice_id: 'si-2', status: 'submitted', amount: '400.50', supplier_invoice: [{ supplier_invoice_number: null }] },
      ],
    })

    const held = await findBankHeldPayments(client, 'company-1', ['si-1', 'si-2'])

    expect(held.get('si-1')).toEqual(SIGNED)
    expect(held.get('si-2')).toEqual({
      ...UNSIGNED,
      supplier_invoice_id: 'si-2',
      supplier_invoice_number: null,
      payment_order_id: 'order-2',
      amount: 400.5,
    })
  })

  it('answers the signed order when an invoice has two: it is the one that still executes', async () => {
    setTable('payment_orders', {
      data: [{ ...ORDER_ROW, id: 'order-new', status: 'submitted' }, ORDER_ROW, { ...ORDER_ROW, id: 'order-old', status: 'awaiting_second_signer' }],
    })

    expect((await findBankHeldPayments(client, 'company-1', ['si-1'])).get('si-1')?.payment_order_id).toBe('order-1')
  })

  it('reads in slices of ID_READ_CHUNK ids: a long id list overruns the gateway', async () => {
    setTable('payment_orders', { data: [] })
    const ids = Array.from({ length: ID_READ_CHUNK + 1 }, (_, i) => `si-${i}`)

    await findBankHeldPayments(client, 'company-1', ids)

    const slices = findCalls('payment_orders', 'in').filter(([column]) => column === 'supplier_invoice_id')
    expect(slices.map(([, slice]) => (slice as string[]).length)).toEqual([ID_READ_CHUNK, 1])
  })

  it('throws when the orders cannot be read: a read that did not run never answers none', async () => {
    setTable('payment_orders', { data: null, error: { message: 'boom' } })
    await expect(findBankHeldPayments(client, 'company-1', ['si-1'])).rejects.toEqual({ message: 'boom' })
  })
})

describe('bankHeldPaymentWarning', () => {
  it('a signed payment beside a bank row: its amount and day, and both ways out', () => {
    const warning = bankHeldPaymentWarning(SIGNED, 'bank_row')

    expect(warning.code).toBe(SIGNED_BANK_PAYMENT_WARNING)
    // Signed or being signed, in the refusal's words (SI_BANK_PAYMENT_UNDER_WAY):
    // awaiting_signature and awaiting_second_signer are not fully signed yet.
    expect(warning.message_sv).toBe(
      `Leverantörsfaktura F-1001 har en betalning på ${formatCurrency(12500, 'SEK')} via banken som är signerad eller signeras just nu, med betalningsdag 2026-12-01. ` +
        'Är den här bankraden inte den betalningen betalar banken ändå: avbryt betalningen under Betalningar eller i banken, eller välj en annan rad.',
    )
    expect(warning.message_en).toBe(
      `Supplier invoice F-1001 has a bank payment of ${formatCurrency(12500, 'SEK')} that is signed or being signed, with payment date 2026-12-01. ` +
        'If this bank row is not that payment, the bank pays anyway: cancel the payment under Payments or in the bank, or pick another row.',
    )
    expect(getErrorEntry('SI_BANK_PAYMENT_UNDER_WAY')?.message_sv).toContain('signerad eller signeras just nu')
    expect(getErrorEntry('SI_BANK_PAYMENT_UNDER_WAY')?.message_en).toContain('signed or being signed')
  })

  it('names the order and its invoice, so a client can cancel it (POST /payment-orders/{id}/cancel)', () => {
    for (const payment of [SIGNED, UNSIGNED]) {
      for (const via of ['bank_row', 'other'] as const) {
        expect(bankHeldPaymentWarning(payment, via)).toMatchObject({ payment_order_id: 'order-1', supplier_invoice_id: 'si-1' })
      }
    }
  })

  it('a signed payment beside a payment registered by hand, a verifikat or a credit: cancel it first, or match its debit', () => {
    const warning = bankHeldPaymentWarning(SIGNED, 'other')

    expect(warning.code).toBe(SIGNED_BANK_PAYMENT_WARNING)
    expect(warning.message_sv).toContain('med betalningsdag 2026-12-01. Banken genomför den ändå: avbryt den under Betalningar först')
    expect(warning.message_en).toContain('with payment date 2026-12-01. The bank makes it anyway: cancel it under Payments first')
  })

  it('an unsigned payment: no money leaves, and the bank is asked to cancel it, whatever the way', () => {
    for (const via of ['bank_row', 'other'] as const) {
      const warning = bankHeldPaymentWarning(UNSIGNED, via)
      expect(warning.code).toBe(UNSIGNED_BANK_PAYMENT_WARNING)
      expect(warning.message_sv).toBe(
        `Leverantörsfaktura F-1001 har en osignerad betalning på ${formatCurrency(12500, 'SEK')} hos banken. ` +
          'Utan signering går inga pengar, och banken ombeds sedan att avbryta den.',
      )
      expect(warning.message_en).toContain('No money leaves without a signature, and the bank is then asked to cancel it.')
      expect(warning.message_sv).not.toContain('betalningsdag')
    }
  })

  it('names an invoice without a number as the invoice', () => {
    const warning = bankHeldPaymentWarning({ ...SIGNED, supplier_invoice_number: '  ' }, 'bank_row')
    expect(warning.message_sv.startsWith('Fakturan har en betalning på')).toBe(true)
    expect(warning.message_en.startsWith('The invoice has a bank payment of')).toBe(true)
  })

  it('writes no en or em dash in either language', () => {
    for (const payment of [SIGNED, UNSIGNED]) {
      for (const via of ['bank_row', 'other'] as const) {
        const { message_sv, message_en } = bankHeldPaymentWarning(payment, via)
        expect(`${message_sv} ${message_en}`).not.toMatch(/[\u2013\u2014]/)
      }
    }
  })
})

describe('checkBankHeldPayments', () => {
  it('says nothing when the bank holds no payment for the invoices', async () => {
    setTable('payment_orders', { data: [] })

    expect(await checkBankHeldPayments(client, 'company-1', ['si-1'], 'bank_row')).toEqual({
      payments: [],
      warnings: [],
      failed: false,
    })
  })

  it('one warning per payment, in the order the invoices were given', async () => {
    setTable('payment_orders', {
      data: [ORDER_ROW, { ...ORDER_ROW, id: 'order-2', supplier_invoice_id: 'si-2', status: 'submitted' }],
    })

    const check = await checkBankHeldPayments(client, 'company-1', ['si-2', 'si-3', 'si-1'], 'bank_row')

    expect(check.failed).toBe(false)
    expect(check.payments.map((p) => p.payment_order_id)).toEqual(['order-2', 'order-1'])
    expect(check.warnings).toEqual([bankHeldPaymentWarning(check.payments[0]!, 'bank_row'), bankHeldPaymentWarning(SIGNED, 'bank_row')])
    expect(check.warnings.map((w) => w.code)).toEqual([UNSIGNED_BANK_PAYMENT_WARNING, SIGNED_BANK_PAYMENT_WARNING])
  })

  it('a failed read is a warning of its own, never a clean check, and nothing is refused', async () => {
    setTable('payment_orders', { data: null, error: { message: 'boom' } })

    const check = await checkBankHeldPayments(client, 'company-1', ['si-1'], 'other')

    expect(check.failed).toBe(true)
    expect(check.error).toEqual({ message: 'boom' })
    expect(check.payments).toEqual([])
    expect(check.warnings).toHaveLength(1)
    expect(check.warnings[0]).toMatchObject({ code: BANK_PAYMENT_CHECK_FAILED_WARNING })
    expect(check.warnings[0]!.message_sv).toContain('Betalningar')
    expect(check.warnings[0]!.message_en).toContain('Payments')
    // About no order and no invoice in particular.
    expect(check.warnings[0]).not.toHaveProperty('payment_order_id')
    expect(check.warnings[0]).not.toHaveProperty('supplier_invoice_id')
  })

  it('a read that does not answer within timeoutMs is a check that did not run: a dialog waits no longer', async () => {
    setTable('payment_orders', () => new Promise(() => {}))

    const check = await checkBankHeldPayments(client, 'company-1', ['si-1'], 'bank_row', { timeoutMs: 20 })

    expect(check.failed).toBe(true)
    expect(check.warnings.map((w) => w.code)).toEqual([BANK_PAYMENT_CHECK_FAILED_WARNING])
    expect(String(check.error)).toContain('no answer within 20 ms')
  })

  it('a read that answers within timeoutMs is used as it is', async () => {
    setTable('payment_orders', { data: [ORDER_ROW] })

    const check = await checkBankHeldPayments(client, 'company-1', ['si-1'], 'bank_row', { timeoutMs: 1_000 })

    expect(check.failed).toBe(false)
    expect(check.payments).toEqual([SIGNED])
  })
})
