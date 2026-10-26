import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * The reminder sender's ledger (migration 20261026233000_invoice_reminders_engine.sql):
 * one invoice_reminders row per invoice and level, written as reserved before
 * the send; a provider message id belongs to one reminder; a provider report
 * never downgrades a worse one (apply_invoice_reminder_provider_status); and
 * company_settings.reminders_enabled_at moves with the toggle and nothing else.
 */

async function seedInvoice(): Promise<{ companyId: string; userId: string; invoiceId: string }> {
  const { companyId, userId } = await seedCompany()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, total, status, creation_complete)
     VALUES ($1, $2, $3, $4, $5, '2026-11-02', '2026-12-02', 1250, 'sent', true)`,
    [invoiceId, userId, companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  return { companyId, userId, invoiceId }
}

async function reserve(params: { companyId: string; userId: string; invoiceId: string; level: number }) {
  return getPool().query<{ id: string; status: string; sent_at: string | null }>(
    `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, mode)
     VALUES ($1, $2, $3, $4, 'kund@example.se', 'approved') RETURNING id, status, sent_at`,
    [params.invoiceId, params.userId, params.companyId, params.level],
  )
}

async function seedSettings(sendReminders: boolean): Promise<string> {
  const { companyId, userId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, send_invoice_reminders) VALUES ($1, $2, $3)`,
    [userId, companyId, sendReminders],
  )
  return companyId
}

async function stampOf(companyId: string): Promise<Date | null> {
  const { rows } = await getPool().query<{ reminders_enabled_at: Date | null }>(
    `SELECT reminders_enabled_at FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.reminders_enabled_at
}

describe('invoice_reminders ledger (pg)', () => {
  it('starts a reminder reserved, without sent_at', async () => {
    const seeded = await seedInvoice()
    const { rows } = await reserve({ ...seeded, level: 1 })
    expect(rows[0]).toMatchObject({ status: 'reserved', sent_at: null })
  })

  it('holds one reminder per invoice and level', async () => {
    const seeded = await seedInvoice()
    await reserve({ ...seeded, level: 1 })
    await expect(reserve({ ...seeded, level: 1 })).rejects.toMatchObject({ code: '23505' })
    await expect(reserve({ ...seeded, level: 2 })).resolves.toMatchObject({ rowCount: 1 })
  })

  it('refuses a sent reminder without sent_at and a failed one without failed_at', async () => {
    const seeded = await seedInvoice()
    const { rows } = await reserve({ ...seeded, level: 1 })
    const id = rows[0]!.id
    await expect(getPool().query(`UPDATE public.invoice_reminders SET status = 'sent' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
    })
    await expect(getPool().query(`UPDATE public.invoice_reminders SET status = 'failed' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
    })
    await expect(
      getPool().query(`UPDATE public.invoice_reminders SET status = 'sent', sent_at = now() WHERE id = $1`, [id]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('gives a provider message id to one reminder', async () => {
    const a = await seedInvoice()
    const b = await seedInvoice()
    const first = (await reserve({ ...a, level: 1 })).rows[0]!.id
    const second = (await reserve({ ...b, level: 1 })).rows[0]!.id
    await getPool().query(`UPDATE public.invoice_reminders SET provider = 'resend', provider_message_id = 'msg-1' WHERE id = $1`, [first])
    await expect(
      getPool().query(`UPDATE public.invoice_reminders SET provider = 'resend', provider_message_id = 'msg-1' WHERE id = $1`, [second]),
    ).rejects.toMatchObject({ code: '23505' })
    // Another provider may reuse the same id.
    await expect(
      getPool().query(`UPDATE public.invoice_reminders SET provider = 'smtp', provider_message_id = 'msg-1' WHERE id = $1`, [second]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('refuses an unknown status, channel, mode or provider status', async () => {
    const seeded = await seedInvoice()
    const id = (await reserve({ ...seeded, level: 1 })).rows[0]!.id
    for (const set of [`status = 'queued'`, `channel = 'sms'`, `mode = 'cron'`, `provider_status = 'opened'`]) {
      await expect(getPool().query(`UPDATE public.invoice_reminders SET ${set} WHERE id = $1`, [id]), set).rejects.toMatchObject({
        code: '23514',
      })
    }
  })
})

async function sentReminder(messageId: string): Promise<string> {
  const seeded = await seedInvoice()
  const id = (await reserve({ ...seeded, level: 1 })).rows[0]!.id
  await getPool().query(
    `UPDATE public.invoice_reminders SET status = 'sent', sent_at = now(), provider = 'resend', provider_message_id = $2 WHERE id = $1`,
    [id, messageId],
  )
  return id
}

async function report(messageId: string, status: string, occurredAt: string): Promise<string | null> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string | null }>(
      `SELECT public.apply_invoice_reminder_provider_status('resend', $1, $2, $3, 'detail') AS id`,
      [messageId, status, occurredAt],
    )
    return rows[0]!.id
  })
}

async function providerStatusOf(id: string): Promise<string | null> {
  const { rows } = await getPool().query<{ provider_status: string | null }>(
    `SELECT provider_status FROM public.invoice_reminders WHERE id = $1`,
    [id],
  )
  return rows[0]!.provider_status
}

describe('apply_invoice_reminder_provider_status (pg)', () => {
  it('records a report on the sent reminder that carries the message id', async () => {
    const messageId = `msg-${randomUUID()}`
    const id = await sentReminder(messageId)
    expect(await report(messageId, 'delivered', '2026-12-17T10:00:00Z')).toBe(id)
    expect(await providerStatusOf(id)).toBe('delivered')
  })

  it('never lets a later or milder report hide a bounce', async () => {
    const messageId = `msg-${randomUUID()}`
    const id = await sentReminder(messageId)
    await report(messageId, 'bounced', '2026-12-17T10:00:00Z')
    expect(await report(messageId, 'delivered', '2026-12-17T11:00:00Z')).toBe(id)
    expect(await providerStatusOf(id)).toBe('bounced')
  })

  it('matches nothing for an unknown id or a reminder that is not sent', async () => {
    expect(await report(`msg-${randomUUID()}`, 'bounced', '2026-12-17T10:00:00Z')).toBeNull()
    const seeded = await seedInvoice()
    const reserved = (await reserve({ ...seeded, level: 1 })).rows[0]!.id
    await getPool().query(`UPDATE public.invoice_reminders SET provider = 'resend', provider_message_id = 'reserved-only' WHERE id = $1`, [reserved])
    expect(await report('reserved-only', 'bounced', '2026-12-17T10:00:00Z')).toBeNull()
    expect(await providerStatusOf(reserved)).toBeNull()
  })

  it('refuses an unknown status, and every caller but the service role', async () => {
    await expect(report(`msg-${randomUUID()}`, 'opened', '2026-12-17T10:00:00Z')).rejects.toMatchObject({ code: '22023' })
    const { companyId, userId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT public.apply_invoice_reminder_provider_status('resend', 'x', 'bounced', now(), null)`),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('company_settings.reminders_enabled_at (pg)', () => {
  it('is stamped when reminders start on, and empty while they are off', async () => {
    expect(await stampOf(await seedSettings(true))).toBeInstanceOf(Date)
    expect(await stampOf(await seedSettings(false))).toBeNull()
  })

  it('moves with the toggle: on stamps now, off clears it', async () => {
    const companyId = await seedSettings(false)
    await getPool().query(`UPDATE public.company_settings SET send_invoice_reminders = true WHERE company_id = $1`, [companyId])
    const stamped = await stampOf(companyId)
    expect(stamped).toBeInstanceOf(Date)

    await getPool().query(`UPDATE public.company_settings SET send_invoice_reminders = false WHERE company_id = $1`, [companyId])
    expect(await stampOf(companyId)).toBeNull()
  })

  it('keeps the stamp on other writes and ignores a direct write to it', async () => {
    const companyId = await seedSettings(true)
    const stamped = await stampOf(companyId)

    await getPool().query(`UPDATE public.company_settings SET reminder_days_level_1 = 10 WHERE company_id = $1`, [companyId])
    expect(await stampOf(companyId)).toEqual(stamped)

    await getPool().query(`UPDATE public.company_settings SET send_invoice_reminders = true WHERE company_id = $1`, [companyId])
    expect(await stampOf(companyId)).toEqual(stamped)

    await getPool().query(`UPDATE public.company_settings SET reminders_enabled_at = '2020-01-01' WHERE company_id = $1`, [companyId])
    expect(await stampOf(companyId)).toEqual(stamped)
  })
})

describe('customers.reminders_excluded (pg)', () => {
  it('starts false', async () => {
    const { companyId, userId } = await seedCompany()
    const { rows } = await getPool().query<{ reminders_excluded: boolean }>(
      `INSERT INTO public.customers (user_id, company_id, name, customer_type) VALUES ($1, $2, 'Kund AB', 'swedish_business') RETURNING reminders_excluded`,
      [userId, companyId],
    )
    expect(rows[0]!.reminders_excluded).toBe(false)
  })
})
