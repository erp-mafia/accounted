import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertCashAccount, insertTransaction, seedCompany } from './fixtures'

// pg-real coverage for 20261004010300_payment_order_settlement.sql: the
// transactions payment-reference columns, and the triggers that settle a bank
// payment order when the payment row that books its invoice lands, and open
// it again when that row is deleted.

async function seedOrder(status: 'accepted' | 'executed' | 'awaiting_second_signer' | 'approved') {
  const ctx = await seedCompany()
  const supplierId = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro) VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`, [
    supplierId,
    ctx.userId,
    ctx.companyId,
  ])
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-09-20', '2026-10-20', 590, 147.5, 737.5, 737.5, 'approved')`,
    [invoiceId, ctx.userId, ctx.companyId, supplierId, `CD-${invoiceId.slice(0, 8)}`],
  )
  const cashAccountId = await insertCashAccount({ companyId: ctx.companyId, ledgerAccount: '1930', iban: 'SE3550000000054910000003' })
  const { rows } = await getPool().query<{ result: { ok: boolean; orders: Array<{ id: string; end_to_end_id: string }> } }>(
    `SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`,
    [
      ctx.companyId,
      JSON.stringify([
        {
          supplier_invoice_id: invoiceId,
          amount: 737.5,
          currency: 'SEK',
          requested_execution_date: '2026-10-20',
          cash_account_id: cashAccountId,
          debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', currency: 'SEK' },
          payee_type: 'bankgiro',
          payee_bankgiro: '50501055',
          payee_name: 'Derome Bygg AB',
          payee_source: 'supplier',
          payee_check: 'known',
          reference_type: 'ocr',
          reference: '4400112233',
          idempotency_key: randomUUID(),
        },
      ]),
      ctx.userId,
    ],
  )
  const order = rows[0]!.result.orders[0]!
  const move = (to: string, extra = '') => getPool().query(`UPDATE public.payment_orders SET status = '${to}' ${extra} WHERE id = $1`, [order.id])
  if (status !== 'approved') {
    await move('approved')
    await move('submitted', `, provider = 'open_payments', provider_payment_id = 'pay-${order.id.slice(0, 8)}'`)
    await move(status === 'executed' ? 'accepted' : status)
    if (status === 'executed') await move('executed', ', executed_at = now()')
  } else {
    await move('approved')
  }
  return { ...ctx, invoiceId, cashAccountId, orderId: order.id, endToEndId: order.end_to_end_id }
}

async function insertPayment(ctx: { companyId: string; userId: string; invoiceId: string }, amount: number, transactionId: string | null) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoice_payments (id, supplier_invoice_id, payment_date, amount, currency, company_id, user_id, transaction_id)
     VALUES ($1, $2, '2026-10-20', $3, 'SEK', $4, $5, $6)`,
    [id, ctx.invoiceId, amount, ctx.companyId, ctx.userId, transactionId],
  )
  return id
}

async function readOrder(id: string) {
  const { rows } = await getPool().query(
    `SELECT status, supplier_invoice_payment_id, matched_transaction_id, matched_at, executed_at FROM public.payment_orders WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('transactions payment reference columns', () => {
  it('stores the end-to-end id and value date a bank reports', async () => {
    const ctx = await seedCompany()
    const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -737.5 })
    await getPool().query(
      `UPDATE public.transactions SET end_to_end_id = 'ACC123', value_date = '2026-10-21', provider_transaction_id = 'tx-at-bank' WHERE id = $1`,
      [txId],
    )
    const { rows } = await getPool().query(
      `SELECT end_to_end_id, value_date::text, provider_transaction_id FROM public.transactions WHERE company_id = $1 AND end_to_end_id = 'ACC123'`,
      [ctx.companyId],
    )
    expect(rows).toEqual([{ end_to_end_id: 'ACC123', value_date: '2026-10-21', provider_transaction_id: 'tx-at-bank' }])
  })
})

describe('settling a bank payment order', () => {
  it('settles an accepted order when the bank row that pays its invoice is matched', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -737.5, cashAccountId: ctx.cashAccountId })
    const paymentId = await insertPayment(ctx, 737.5, txId)

    const order = await readOrder(ctx.orderId)
    expect(order).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId, matched_transaction_id: txId })
    expect(order.executed_at).not.toBeNull()
    const events = await getPool().query(`SELECT event_type FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'matched'`, [ctx.orderId])
    expect(events.rows).toHaveLength(1)
  })

  it('leaves the order alone for a different amount, and for a manual payment before the bank executed', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -500 })
    await insertPayment(ctx, 500, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'accepted', supplier_invoice_payment_id: null })

    const other = await seedOrder('accepted')
    await insertPayment(other, 737.5, null)
    expect(await readOrder(other.orderId)).toMatchObject({ status: 'accepted', supplier_invoice_payment_id: null })
  })

  it('settles an executed order by a manual payment of the same amount', async () => {
    const ctx = await seedOrder('executed')
    const paymentId = await insertPayment(ctx, 737.5, null)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId, matched_transaction_id: null })
  })

  it('never settles an order the bank does not have', async () => {
    const ctx = await seedOrder('approved')
    const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -737.5 })
    await insertPayment(ctx, 737.5, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'approved', supplier_invoice_payment_id: null })
  })

  it('opens the order again when the payment row is deleted, blocking a second payment until matched', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -737.5 })
    const paymentId = await insertPayment(ctx, 737.5, txId)
    await getPool().query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [paymentId])

    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: null, matched_transaction_id: null, matched_at: null })
    const events = await getPool().query(`SELECT event_type FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'unmatched'`, [ctx.orderId])
    expect(events.rows).toHaveLength(1)

    const { rows } = await getPool().query(`SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`, [
      ctx.companyId,
      JSON.stringify([
        {
          supplier_invoice_id: ctx.invoiceId,
          amount: 10,
          currency: 'SEK',
          requested_execution_date: '2026-10-20',
          cash_account_id: ctx.cashAccountId,
          debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', currency: 'SEK' },
          payee_type: 'bankgiro',
          payee_bankgiro: '50501055',
          payee_name: 'Derome Bygg AB',
          payee_source: 'supplier',
          payee_check: 'known',
          reference_type: 'ocr',
          reference: '4400112233',
          idempotency_key: randomUUID(),
        },
      ]),
      ctx.userId,
    ])
    expect(rows[0].result).toMatchObject({ ok: false, code: 'already_in_payment' })
  })
})
