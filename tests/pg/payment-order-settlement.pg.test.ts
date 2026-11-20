import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertCashAccount, insertTransaction, seedCompany } from './fixtures'

// pg-real coverage for 20261010090100_payment_order_settlement.sql: the
// transactions payment-reference columns; the trigger that settles a bank
// payment order when the payment row that books its invoice lands (by the
// order's own end-to-end id from any state the bank may still report, by
// amount only once the bank reported it executed, never by a row naming
// another of our payments); and the trigger that clears the settlement when
// that row is deleted, keeping the order closed while another order covers
// the invoice.

type SeedStatus = 'approved' | 'submitted_unknown' | 'awaiting_second_signer' | 'accepted' | 'executed'

async function createOrder(ctx: { companyId: string; userId: string; invoiceId: string; cashAccountId: string }, amount: number) {
  const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; orders: Array<{ id: string; end_to_end_id: string }> } }>(
    `SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`,
    [
      ctx.companyId,
      JSON.stringify([
        {
          supplier_invoice_id: ctx.invoiceId,
          amount,
          currency: 'SEK',
          requested_execution_date: '2026-10-20',
          cash_account_id: ctx.cashAccountId,
          debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', currency: 'SEK' },
          payee_type: 'bankgiro',
          payee_bankgiro: '50501055',
          payee_name: 'Derome Bygg AB',
          payee_source: 'supplier',
          reference_type: 'ocr',
          reference: '4400112233',
          idempotency_key: randomUUID(),
        },
      ]),
      ctx.userId,
    ],
  )
  return rows[0]!.result
}

async function moveOrder(orderId: string, status: SeedStatus) {
  const move = (to: string, extra = '') => getPool().query(`UPDATE public.payment_orders SET status = '${to}' ${extra} WHERE id = $1`, [orderId])
  await move('approved')
  if (status === 'approved') return
  if (status === 'submitted_unknown') {
    await move('submitted', `, provider = 'open_payments', submitted_at = now(), outcome_unknown_at = now()`)
    return
  }
  await move('submitted', `, provider = 'open_payments', provider_payment_id = 'pay-${orderId.slice(0, 8)}', submitted_at = now()`)
  await move(status === 'executed' ? 'accepted' : status)
  if (status === 'executed') await move('executed', ', executed_at = now()')
}

async function seedInvoice(total = 737.5) {
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
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-09-20', '2026-10-20', $6 * 0.8, $6 * 0.2, $6, $6, 'approved')`,
    [invoiceId, ctx.userId, ctx.companyId, supplierId, `CD-${invoiceId.slice(0, 8)}`, total],
  )
  const cashAccountId = await insertCashAccount({ companyId: ctx.companyId, ledgerAccount: '1930', iban: 'SE3550000000054910000003' })
  return { ...ctx, invoiceId, cashAccountId }
}

async function seedOrder(status: SeedStatus) {
  const ctx = await seedInvoice()
  const created = await createOrder(ctx, 737.5)
  const order = created.orders[0]!
  await moveOrder(order.id, status)
  return { ...ctx, orderId: order.id, endToEndId: order.end_to_end_id }
}

/** A bank debit, optionally carrying an end-to-end id. */
async function insertDebit(ctx: { companyId: string; userId: string; cashAccountId: string }, amount: number, endToEndId: string | null) {
  const txId = await insertTransaction({ companyId: ctx.companyId, userId: ctx.userId, amount: -amount, cashAccountId: ctx.cashAccountId })
  if (endToEndId) await getPool().query(`UPDATE public.transactions SET end_to_end_id = $2 WHERE id = $1`, [txId, endToEndId])
  return txId
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
    `SELECT status, supplier_invoice_payment_id, matched_transaction_id, matched_at, executed_at, outcome_unknown_at
       FROM public.payment_orders WHERE id = $1`,
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
  it('settles an accepted order when the matched bank row carries its end-to-end id', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertDebit(ctx, 737.5, ctx.endToEndId)
    const paymentId = await insertPayment(ctx, 737.5, txId)

    const order = await readOrder(ctx.orderId)
    expect(order).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId, matched_transaction_id: txId })
    expect(order.executed_at).not.toBeNull()
    const events = await getPool().query(
      `SELECT detail ->> 'by' AS by FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'matched'`,
      [ctx.orderId],
    )
    expect(events.rows).toEqual([{ by: 'end_to_end_id' }])
  })

  it('never promotes an order the bank has not executed on another debit of the same amount (scenario A)', async () => {
    // A second signer is still pending at the bank; the person paid the same
    // amount by hand in the netbank, and that debit is matched to the invoice.
    const ctx = await seedOrder('awaiting_second_signer')
    const manualDebit = await insertDebit(ctx, 737.5, 'NOTPROVIDED')
    await insertPayment(ctx, 737.5, manualDebit)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'awaiting_second_signer', supplier_invoice_payment_id: null })

    const accepted = await seedOrder('accepted')
    const noId = await insertDebit(accepted, 737.5, null)
    await insertPayment(accepted, 737.5, noId)
    expect(await readOrder(accepted.orderId)).toMatchObject({ status: 'accepted', supplier_invoice_payment_id: null })
  })

  it('leaves the order alone for a different amount, and for a manual payment before the bank executed', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertDebit(ctx, 500, ctx.endToEndId)
    await insertPayment(ctx, 500, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'accepted', supplier_invoice_payment_id: null })

    const other = await seedOrder('accepted')
    await insertPayment(other, 737.5, null)
    expect(await readOrder(other.orderId)).toMatchObject({ status: 'accepted', supplier_invoice_payment_id: null })
  })

  it('settles an executed order by a payment of the same amount, but not by a debit naming another of our payments', async () => {
    const ctx = await seedOrder('executed')
    const paymentId = await insertPayment(ctx, 737.5, null)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId, matched_transaction_id: null })

    const other = await seedOrder('executed')
    const foreign = await insertDebit(other, 737.5, `ACC${'a'.repeat(32)}`)
    await insertPayment(other, 737.5, foreign)
    expect(await readOrder(other.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: null })
  })

  it('resolves an order whose bank outcome was unknown by its own debit', async () => {
    const ctx = await seedOrder('submitted_unknown')
    expect((await readOrder(ctx.orderId)).outcome_unknown_at).not.toBeNull()
    const txId = await insertDebit(ctx, 737.5, ctx.endToEndId)
    const paymentId = await insertPayment(ctx, 737.5, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId, outcome_unknown_at: null })
  })

  it('settles by an end-to-end id the bank wrote in capitals, and never by amount on one of ours in capitals', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertDebit(ctx, 737.5, ctx.endToEndId.toUpperCase())
    const paymentId = await insertPayment(ctx, 737.5, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId })

    const other = await seedOrder('executed')
    const foreign = await insertDebit(other, 737.5, `ACC${'A'.repeat(32)}`)
    await insertPayment(other, 737.5, foreign)
    expect(await readOrder(other.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: null })
  })

  it('settles by the end-to-end id an earlier claim of the order used', async () => {
    const ctx = await seedOrder('accepted')
    const earlier = `ACC${'c'.repeat(32)}`
    await getPool().query(
      `INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, from_status, to_status, detail)
       VALUES ($1, $2, 'submitted', 'approved', 'submitted', jsonb_build_object('previous_end_to_end_id', $3::text))`,
      [ctx.companyId, ctx.orderId, earlier],
    )
    const txId = await insertDebit(ctx, 737.5, earlier)
    const paymentId = await insertPayment(ctx, 737.5, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: paymentId })
    const events = await getPool().query(
      `SELECT detail ->> 'by' AS by FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'matched'`,
      [ctx.orderId],
    )
    expect(events.rows).toEqual([{ by: 'end_to_end_id' }])
  })

  it('never settles an order the bank does not have', async () => {
    const ctx = await seedOrder('approved')
    const txId = await insertDebit(ctx, 737.5, ctx.endToEndId)
    await insertPayment(ctx, 737.5, txId)
    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'approved', supplier_invoice_payment_id: null })
  })
})

describe('undoing the match that settled an order', () => {
  it('opens the order again, blocking a second payment until it is matched', async () => {
    const ctx = await seedOrder('accepted')
    const txId = await insertDebit(ctx, 737.5, ctx.endToEndId)
    const paymentId = await insertPayment(ctx, 737.5, txId)
    await getPool().query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [paymentId])

    expect(await readOrder(ctx.orderId)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: null, matched_transaction_id: null, matched_at: null })
    const events = await getPool().query(`SELECT event_type FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'unmatched'`, [ctx.orderId])
    expect(events.rows).toHaveLength(1)

    expect(await createOrder(ctx, 10)).toMatchObject({ ok: false, code: 'already_in_payment' })
  })

  it('takes the invoice before the order, so an undone match and a claim never deadlock', async () => {
    const ctx = await seedOrder('accepted')
    const paymentId = await insertPayment(ctx, 737.5, await insertDebit(ctx, 737.5, ctx.endToEndId))
    const undo = await getClient()
    const other = await getClient()
    try {
      await undo.query('BEGIN')
      await undo.query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [paymentId])
      // A claim locks the invoice before the order: it must find the invoice
      // held already, never only the order.
      await expect(
        other.query(`SELECT id FROM public.supplier_invoices WHERE id = $1 FOR UPDATE NOWAIT`, [ctx.invoiceId]),
      ).rejects.toThrow(/could not obtain lock/)
      await undo.query('ROLLBACK')
    } finally {
      undo.release()
      other.release()
    }
  })

  it('answers an order created while a match is undone with a refusal, never an error', async () => {
    const ctx = await seedOrder('accepted')
    const paymentId = await insertPayment(ctx, 737.5, await insertDebit(ctx, 737.5, ctx.endToEndId))
    const undo = await getClient()
    try {
      await undo.query('BEGIN')
      await undo.query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [paymentId])
      const creating = createOrder(ctx, 10)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await undo.query('COMMIT')
      expect(await creating).toMatchObject({ ok: false, code: 'already_in_payment' })
    } finally {
      undo.release()
    }
  })

  it('keeps the settled order closed while another order covers the invoice (scenario B)', async () => {
    const ctx = await seedInvoice(1000)
    // A pays 600 and is settled by its debit; the invoice has 400 left.
    const a = (await createOrder(ctx, 600)).orders[0]!
    await moveOrder(a.id, 'executed')
    const aDebit = await insertDebit(ctx, 600, a.end_to_end_id)
    const aPayment = await insertPayment(ctx, 600, aDebit)
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'partially_paid', remaining_amount = 400 WHERE id = $1`, [ctx.invoiceId])
    // B pays the rest and is still open.
    const b = await createOrder(ctx, 400)
    expect(b.ok).toBe(true)
    const bId = b.orders[0]!.id

    // Undoing A's match no longer collides with B on the one-open-order index.
    await getPool().query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [aPayment])
    const aAfter = await readOrder(a.id)
    expect(aAfter).toMatchObject({ status: 'executed', supplier_invoice_payment_id: null, matched_transaction_id: null })
    expect(aAfter.matched_at).not.toBeNull()
    const kept = await getPool().query(
      `SELECT detail ->> 'kept_closed' AS kept, detail ->> 'open_payment_order_id' AS other
         FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'unmatched'`,
      [a.id],
    )
    expect(kept.rows).toEqual([{ kept: 'true', other: bId }])
    expect((await readOrder(bId)).status).toBe('draft')

    // A's money left and is not matched: no third order, even after B is gone.
    await getPool().query(`UPDATE public.supplier_invoices SET remaining_amount = 1000, status = 'approved' WHERE id = $1`, [ctx.invoiceId])
    await getPool().query(`UPDATE public.payment_orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [bId])
    expect(await createOrder(ctx, 10)).toMatchObject({ ok: false, code: 'already_in_payment' })

    // Matching A's debit again settles A.
    const again = await insertPayment(ctx, 600, aDebit)
    expect(await readOrder(a.id)).toMatchObject({ status: 'executed', supplier_invoice_payment_id: again })
  })
})
