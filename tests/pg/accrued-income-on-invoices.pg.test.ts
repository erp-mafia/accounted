/**
 * Upplupna intäkter (17xx) on customer invoice lines (#62,
 * 20261021002400_accrued_income_on_customer_invoices.sql), against real
 * Postgres:
 *
 *   - the widened CHECKs: invoice_items and a revenue schedule take a 17xx
 *     interim account, and still refuse anything outside 17xx/29xx;
 *   - the booking through the real doors: an October invoice for August and
 *     September consulting (createInvoiceJournalEntry, then
 *     createSchedulesForCustomerInvoice as the issue and Bokför doors run
 *     them) books Dr 1510 / Cr 1790 (net) + Cr 2611 on the invoice date, and
 *     each month Dr 1790 / Cr 3001 on its own last day, so 1790 nets to zero
 *     and every verifikat balances;
 *   - a month behind the company lock date refuses the booking before any
 *     voucher number is drawn.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in posting-parity-accruals.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import type { Invoice, InvoiceItem } from '@/types'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

interface Seed {
  userId: string
  companyId: string
  customerId: string
}

async function seedCompanyWith2026(): Promise<Seed> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, name: 'Test AB', entityType: 'aktiebolag' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  await insertFiscalPeriod({ userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  return { userId, companyId, customerId }
}

/**
 * A sent October invoice: one 20 000 kr line for August and September
 * consulting on `balanceAccount`, 25 % moms. Returned as the issue doors
 * fetch it (items joined).
 */
async function insertInvoice(seed: Seed, balanceAccount: string): Promise<Invoice & { items: InvoiceItem[] }> {
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-10-15', '2026-11-14', 'sent', 'SEK',
             20000, 5000, 25000, 'standard_25', 25, 'invoice', 0, 25000)`,
    [invoiceId, seed.userId, seed.companyId, seed.customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  await getPool().query(
    `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                       vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
     VALUES ($1, $2, 0, 'Konsultation augusti-september', 1, 'st', 20000, 20000, 25, 5000, '2026-08-01', '2026-09-30', $3)`,
    [randomUUID(), invoiceId, balanceAccount],
  )
  const { data, error } = await createServiceClientNoCookies()
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', invoiceId)
    .single()
  if (error || !data) throw new Error(`invoice read failed: ${error?.message}`)
  return data as Invoice & { items: InvoiceItem[] }
}

interface PostedLine {
  entry_date: string
  description: string
  account_number: string
  debit: number
  credit: number
}

async function postedLines(companyId: string): Promise<PostedLine[]> {
  const { rows } = await getPool().query<{
    entry_date: string
    description: string
    account_number: string
    debit_amount: string
    credit_amount: string
  }>(
    `SELECT je.entry_date::text AS entry_date, je.description, l.account_number,
            l.debit_amount::text AS debit_amount, l.credit_amount::text AS credit_amount
       FROM public.journal_entries je
       JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.company_id = $1 AND je.status = 'posted'
      ORDER BY je.entry_date, je.voucher_number, l.account_number`,
    [companyId],
  )
  return rows.map((row) => ({
    entry_date: row.entry_date,
    description: row.description,
    account_number: row.account_number,
    debit: Number(row.debit_amount),
    credit: Number(row.credit_amount),
  }))
}

describe('upplupen intäkt (17xx): the widened CHECKs', () => {
  it('accepts a 17xx interim account on an invoice line and a revenue schedule, and still refuses nonsense', async () => {
    const seed = await seedCompanyWith2026()
    const invoice = await insertInvoice(seed, '1790')
    expect(invoice.items[0].accrual_balance_account).toBe('1790')

    const insertItem = (account: string) =>
      getPool().query(
        `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                           vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
         VALUES ($1, $2, 1, 'Rad', 1, 'st', 100, 100, 25, 25, '2026-08-01', '2026-08-31', $3)`,
        [randomUUID(), invoice.id, account],
      )
    await expect(insertItem('1750')).resolves.toBeDefined()
    await expect(insertItem('2970')).resolves.toBeDefined()
    await expect(insertItem('1510')).rejects.toThrow(/invoice_items_accrual_account_range/)
    await expect(insertItem('3001')).rejects.toThrow(/invoice_items_accrual_account_range/)
    await expect(insertItem('179')).rejects.toThrow(/invoice_items_accrual_account_range/)

    const insertSchedule = (direction: string, account: string) =>
      getPool().query(
        `INSERT INTO public.accrual_schedules
           (id, user_id, company_id, direction, invoice_id, balance_account, target_account, total_amount,
            period_start, period_end, months, posting_floor_date)
         VALUES ($1, $2, $3, $4, $5, $6, '3001', 20000, '2026-08-01', '2026-09-30', 2, '2026-10-15')`,
        [randomUUID(), seed.userId, seed.companyId, direction, invoice.id, account],
      )
    await expect(insertSchedule('revenue', '1790')).resolves.toBeDefined()
    await expect(insertSchedule('revenue', '2970')).resolves.toBeDefined()
    await expect(insertSchedule('revenue', '1930')).rejects.toThrow(/accrual_schedules_balance_account_range/)
    await expect(insertSchedule('revenue', '3001')).rejects.toThrow(/accrual_schedules_balance_account_range/)
  })
})

describe('upplupen intäkt (17xx): booking an October invoice for August and September', () => {
  it('credits 1790 on the invoice date and books each month Dr 1790 / Cr 3001 on its last day', async () => {
    const seed = await seedCompanyWith2026()
    const invoice = await insertInvoice(seed, '1790')
    const supabase = createServiceClientNoCookies()

    const schedules = await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      expect(entry).not.toBeNull()
      return createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag')
    })
    expect(schedules).toEqual({ created: 1, failed: 0, releasesFailed: 0 })

    const lines = await postedLines(seed.companyId)
    const byDate = (date: string) =>
      lines.filter((line) => line.entry_date === date).map(({ account_number, debit, credit }) => ({ account_number, debit, credit }))

    expect(byDate('2026-08-31')).toEqual([
      { account_number: '1790', debit: 10000, credit: 0 },
      { account_number: '3001', debit: 0, credit: 10000 },
    ])
    expect(byDate('2026-09-30')).toEqual([
      { account_number: '1790', debit: 10000, credit: 0 },
      { account_number: '3001', debit: 0, credit: 10000 },
    ])
    // The invoice: no revenue on 3001 in October, moms on the invoice date.
    expect(byDate('2026-10-15')).toEqual([
      { account_number: '1510', debit: 25000, credit: 0 },
      { account_number: '1790', debit: 0, credit: 20000 },
      { account_number: '2611', debit: 0, credit: 5000 },
    ])

    // 1790 nets to zero once the invoice is booked, and every verifikat balances.
    const ore = (n: number) => Math.round(n * 100)
    const net1790 = lines
      .filter((line) => line.account_number === '1790')
      .reduce((sum, line) => sum + ore(line.debit) - ore(line.credit), 0)
    expect(net1790).toBe(0)
    const { rows: unbalanced } = await getPool().query(
      `SELECT je.id FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.company_id = $1 GROUP BY je.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`,
      [seed.companyId],
    )
    expect(unbalanced).toEqual([])

    const { rows: installments } = await getPool().query(
      `SELECT i.period_month::text AS period_month, i.status FROM public.accrual_schedule_installments i
         JOIN public.accrual_schedules s ON s.id = i.schedule_id
        WHERE s.company_id = $1 ORDER BY i.period_month`,
      [seed.companyId],
    )
    expect(installments).toEqual([
      { period_month: '2026-08-01', status: 'posted' },
      { period_month: '2026-09-01', status: 'posted' },
    ])
    const { rows: schedule } = await getPool().query(
      `SELECT direction, balance_account, target_account, status FROM public.accrual_schedules WHERE company_id = $1`,
      [seed.companyId],
    )
    expect(schedule).toEqual([{ direction: 'revenue', balance_account: '1790', target_account: '3001', status: 'completed' }])
  })

  it('refuses the booking, drawing no voucher number, when a month lies behind the company lock date', async () => {
    const seed = await seedCompanyWith2026()
    await getPool().query(
      `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-08-31' WHERE company_id = $1`,
      [seed.companyId],
    )
    const invoice = await insertInvoice(seed, '1790')
    const supabase = createServiceClientNoCookies()

    await expect(
      runWithActor({ type: 'user' }, () =>
        createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB'),
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_ACCRUED_INCOME_PERIOD_LOCKED',
      blocked: [{ date: '2026-08-31', reason: 'company_lock_date_covers' }],
    })

    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`, [
      seed.companyId,
    ])
    expect(rows[0].n).toBe(0)
  })
})
