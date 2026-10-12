/**
 * invoice.sent reaches event_log with no module-level init anywhere.
 *
 * Entry points no longer call ensureInitialized(): eventBus.emit() loads
 * lib/init (the event_log handler, the webhook fan-out, every extension) on
 * the first event and resolves only after the handlers ran
 * (lib/initialized.ts). This issues an invoice through issueAndBookInvoice,
 * the issue core that mark-sent and bulk Bokför share, against real Postgres
 * in a cold module graph with the real lib/init: importing it must not load
 * lib/init, and the event_log row must be committed by the time it returns.
 *
 * The session client is signed in as the owner, the service clients run as
 * service_role (tests/pg/sql-supabase-client.ts). Its own file: a cold graph
 * per scenario, as on a cold start.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'
import { sqlClient } from './sql-supabase-client'

const state = vi.hoisted(() => ({ initLoads: 0, service: null as unknown }))

// Counts loads of the real lib/init; only lib/initialized.ts imports it.
vi.mock('@/lib/init', async (importOriginal) => {
  state.initLoads++
  return importOriginal()
})
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => state.service,
}))
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createServiceClient: () => state.service,
  // No request scope: extension handlers get no context, as in a cron.
  createClient: async () => {
    throw new Error('no request scope in this test')
  },
}))

describe('invoice.sent on first use', () => {
  it('issuing writes the event_log row before the call returns, and loads lib/init only on the event', async () => {
    const { userId, companyId } = await seedCompany()
    state.service = sqlClient('service_role', null)
    const customerId = randomUUID()
    const invoiceId = randomUUID()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`, [userId, companyId])
    await getPool().query(
      `INSERT INTO public.customers (id, company_id, user_id, name, customer_type)
       VALUES ($1, $2, $3, 'PG first-use customer', 'swedish_business')`,
      [customerId, companyId, userId],
    )
    // A proforma: the same issue and invoice.sent path as an invoice, without
    // the verifikat and the PDF archive a real invoice adds on the way.
    await getPool().query(
      `INSERT INTO public.invoices (id, company_id, user_id, customer_id, document_type, invoice_date, due_date,
         status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, vat_rate)
       VALUES ($1, $2, $3, $4, 'proforma', '2026-01-02', '2026-02-01',
         'draft', 'SEK', 100, 25, 125, 0, 125, 'standard_25', 25)`,
      [invoiceId, companyId, userId, customerId],
    )
    const invoice = (await getPool().query(`SELECT * FROM public.invoices WHERE id = $1`, [invoiceId])).rows[0]

    const { issueAndBookInvoice } = await import('@/lib/invoices/issue-and-book-invoice')
    const { createLogger } = await import('@/lib/logger')
    expect(state.initLoads).toBe(0)

    const result = await issueAndBookInvoice({
      supabase: sqlClient('authenticated', userId),
      companyId,
      userId,
      invoice: { ...invoice, customer: { id: customerId, name: 'PG first-use customer' }, items: [] },
      settings: { entity_type: 'aktiebolag', vat_registered: false } as never,
      log: createLogger('pg-first-use'),
    })

    expect(result).toMatchObject({ ok: true, journalEntryId: null })
    expect(state.initLoads).toBe(1)
    const { rows } = await getPool().query(
      `SELECT event_type, entity_id, user_id FROM public.event_log WHERE company_id = $1 ORDER BY sequence`,
      [companyId],
    )
    expect(rows).toEqual([{ event_type: 'invoice.sent', entity_id: invoiceId, user_id: userId }])
    const issued = await getPool().query(`SELECT status FROM public.invoices WHERE id = $1`, [invoiceId])
    expect(issued.rows[0].status).toBe('sent')
  })
})
