import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runAsServiceRole } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261031224300_payment_failed_notification.sql: the
// notification_log claim behind the mail when the bank rejects a payment or
// it fails (src/lib/payments/orders/outcome-notify.ts). Written as the
// service role, as the status cron writes it. One claim per person and
// payment, so two runs (or two overlapping ones) never mail twice; other
// people about the same payment, and other types, are not constrained.

async function claim(userId: string, companyId: string, orderId: string, type = 'payment_failed'): Promise<void> {
  await runAsServiceRole((client) =>
    client.query(
      `INSERT INTO public.notification_log (user_id, company_id, notification_type, reference_id, days_before, delivery_status)
       VALUES ($1, $2, $3, $4, 0, 'pending')`,
      [userId, companyId, type, orderId],
    ),
  )
}

describe('notification_log payment_failed claims', () => {
  it('admits the type and refuses a second claim for the same person and payment (23505)', async () => {
    const { userId, companyId } = await seedCompany()
    const orderId = randomUUID()

    await claim(userId, companyId, orderId)

    await expect(claim(userId, companyId, orderId)).rejects.toMatchObject({ code: '23505' })
  })

  it('lets every other person behind the payment be told, and the same person about another payment', async () => {
    const { userId, companyId } = await seedCompany()
    const { userId: signer } = await seedCompany()
    const orderId = randomUUID()

    await claim(userId, companyId, orderId)
    await expect(claim(signer, companyId, orderId)).resolves.toBeUndefined()
    await expect(claim(userId, companyId, randomUUID())).resolves.toBeUndefined()
  })

  it('leaves the other notification types as they were: reminder steps may log one reference many times', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = randomUUID()

    await claim(userId, companyId, invoiceId, 'invoice_due')
    await expect(claim(userId, companyId, invoiceId, 'invoice_due')).resolves.toBeUndefined()
  })

  it('lets the service role settle a claim to sent or failed, or remove it for a retry', async () => {
    const { userId, companyId } = await seedCompany()
    const sent = randomUUID()
    const refused = randomUUID()
    await claim(userId, companyId, sent)
    await claim(userId, companyId, refused)

    const rows = await runAsServiceRole(async (client) => {
      await client.query(
        `UPDATE public.notification_log SET delivery_status = 'sent', sent_at = now()
          WHERE user_id = $1 AND notification_type = 'payment_failed' AND reference_id = $2`,
        [userId, sent],
      )
      await client.query(
        `DELETE FROM public.notification_log WHERE user_id = $1 AND notification_type = 'payment_failed' AND reference_id = $2`,
        [userId, refused],
      )
      const { rows } = await client.query<{ reference_id: string; delivery_status: string }>(
        `SELECT reference_id, delivery_status FROM public.notification_log WHERE user_id = $1 AND notification_type = 'payment_failed'`,
        [userId],
      )
      return rows
    })

    expect(rows).toEqual([{ reference_id: sent, delivery_status: 'sent' }])
    // The retry after a refused send claims again.
    await expect(claim(userId, companyId, refused)).resolves.toBeUndefined()
  })
})
