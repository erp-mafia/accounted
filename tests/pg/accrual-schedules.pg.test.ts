import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertDraftJournalEntry } from './fixtures'

// pg-real coverage for 20260623120000_accrual_schedules.sql: CHECK
// constraints, the posted-installment immutability trigger, the FK RESTRICT
// on dissolution verifikat, RLS isolation, and the audit-preserving DELETE
// policies on both tables.

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Försäkrings AB')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(
  companyId: string,
  userId: string,
  supplierId: string,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-01-15', '2026-02-14',
             12000, 3000, 15000)`,
    [id, userId, companyId, supplierId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function insertSchedule(
  params: {
    companyId: string
    userId: string
    supplierInvoiceId: string
    direction?: string
    supplierInvoiceIdOverride?: string | null
    invoiceId?: string | null
    balanceAccount?: string
    targetAccount?: string
    periodStart?: string
    periodEnd?: string
  },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.accrual_schedules
       (id, user_id, company_id, direction, supplier_invoice_id, invoice_id,
        balance_account, target_account, total_amount,
        period_start, period_end, months)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 12000, $9, $10, 12)`,
    [
      id,
      params.userId,
      params.companyId,
      params.direction ?? 'expense',
      params.supplierInvoiceIdOverride === undefined
        ? params.supplierInvoiceId
        : params.supplierInvoiceIdOverride,
      params.invoiceId ?? null,
      params.balanceAccount ?? '1730',
      params.targetAccount ?? '6310',
      params.periodStart ?? '2026-01-01',
      params.periodEnd ?? '2026-12-31',
    ],
  )
  return id
}

async function insertCustomerInvoice(companyId: string, userId: string): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-01-15', '2026-02-14', 'SEK',
             12000, 3000, 15000, 'standard_25', 25, 'sent', 0, 15000)`,
    [id, userId, companyId, customerId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function insertInstallment(params: {
  companyId: string
  userId: string
  scheduleId: string
  periodMonth?: string
  status?: string
  journalEntryId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.accrual_schedule_installments
       (id, user_id, company_id, schedule_id, period_month, amount, status, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, 1000, $6, $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.scheduleId,
      params.periodMonth ?? '2026-01-01',
      params.status ?? 'pending',
      params.journalEntryId ?? null,
    ],
  )
  return id
}

async function seedScheduleContext() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const supplierId = await insertSupplier(companyId, userId)
  const supplierInvoiceId = await insertSupplierInvoice(companyId, userId, supplierId)
  return { userId, companyId, fiscalPeriodId, supplierId, supplierInvoiceId }
}

describe('accrual_schedules constraints', () => {
  it('rejects a schedule without any source invoice', async () => {
    const ctx = await seedScheduleContext()
    await expect(
      insertSchedule({ ...ctx, supplierInvoiceIdOverride: null }),
    ).rejects.toThrow(/one_source|direction_matches_source/i)
  })

  it('rejects a direction that does not match the source side', async () => {
    const ctx = await seedScheduleContext()
    // Accounts are valid for the 'revenue' direction so the only violated
    // constraint is direction_matches_source (supplier invoice → expense).
    await expect(
      insertSchedule({
        ...ctx,
        direction: 'revenue',
        balanceAccount: '2970',
        targetAccount: '3001',
      }),
    ).rejects.toThrow(/direction_matches_source/i)
  })

  it('rejects period_end before period_start', async () => {
    const ctx = await seedScheduleContext()
    await expect(
      insertSchedule({ ...ctx, periodStart: '2026-06-01', periodEnd: '2026-01-31' }),
    ).rejects.toThrow(/period_valid/i)
  })

  it('rejects a non-17xx balance account on an expense schedule', async () => {
    const ctx = await seedScheduleContext()
    await expect(
      insertSchedule({ ...ctx, balanceAccount: '2970' }),
    ).rejects.toThrow(/balance_account_range/i)
    await expect(
      insertSchedule({ ...ctx, balanceAccount: '5010' }),
    ).rejects.toThrow(/balance_account_range/i)
  })

  it('rejects a non-29xx balance account on a revenue schedule', async () => {
    const ctx = await seedScheduleContext()
    const invoiceId = await insertCustomerInvoice(ctx.companyId, ctx.userId)
    await expect(
      insertSchedule({
        ...ctx,
        direction: 'revenue',
        supplierInvoiceIdOverride: null,
        invoiceId,
        balanceAccount: '1730',
        targetAccount: '3001',
      }),
    ).rejects.toThrow(/balance_account_range/i)

    // The mirrored valid combination passes.
    await expect(
      insertSchedule({
        ...ctx,
        direction: 'revenue',
        supplierInvoiceIdOverride: null,
        invoiceId,
        balanceAccount: '2970',
        targetAccount: '3001',
      }),
    ).resolves.toBeDefined()
  })

  it('rejects an implausible BAS target account', async () => {
    const ctx = await seedScheduleContext()
    await expect(
      insertSchedule({ ...ctx, targetAccount: '9999' }),
    ).rejects.toThrow(/target_account_range/i)
    await expect(
      insertSchedule({ ...ctx, targetAccount: '631' }),
    ).rejects.toThrow(/target_account_range/i)
  })
})

describe('accrual_schedule_installments constraints', () => {
  it('rejects a period_month that is not the first day of a month', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    await expect(
      insertInstallment({ ...ctx, scheduleId, periodMonth: '2026-02-15' }),
    ).rejects.toThrow(/month_normalized/i)
  })

  it('rejects two installments for the same schedule and month', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    await insertInstallment({ ...ctx, scheduleId, periodMonth: '2026-03-01' })
    await expect(
      insertInstallment({ ...ctx, scheduleId, periodMonth: '2026-03-01' }),
    ).rejects.toThrow(/duplicate|unique/i)
  })

  it('rejects status=posted without a journal entry link', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    await expect(
      insertInstallment({ ...ctx, scheduleId, status: 'posted', journalEntryId: null }),
    ).rejects.toThrow(/posted_consistent/i)
  })
})

describe('posted installment immutability + verifikat protection', () => {
  it('freezes amount and period_month once a journal entry is linked', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    const entryId = await insertDraftJournalEntry(ctx)
    const installmentId = await insertInstallment({
      ...ctx,
      scheduleId,
      status: 'posted',
      journalEntryId: entryId,
    })

    await expect(
      getPool().query(
        `UPDATE public.accrual_schedule_installments SET amount = 999 WHERE id = $1`,
        [installmentId],
      ),
    ).rejects.toThrow(/posted accrual installment/i)

    // Non-financial fields stay editable (cron error bookkeeping).
    await expect(
      getPool().query(
        `UPDATE public.accrual_schedule_installments SET last_error = 'x' WHERE id = $1`,
        [installmentId],
      ),
    ).resolves.toBeDefined()
  })

  it('blocks deleting a journal entry referenced by an installment', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    const entryId = await insertDraftJournalEntry(ctx)
    await insertInstallment({
      ...ctx,
      scheduleId,
      status: 'posted',
      journalEntryId: entryId,
    })

    // The engine-level delete guard fires before the FK RESTRICT can: either
    // layer blocking the delete satisfies the verifikat-protection invariant.
    await expect(
      getPool().query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/foreign key|violates|cannot delete journal entries/i)
  })
})

describe('accrual RLS', () => {
  it('isolates schedules and installments by company', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    await insertInstallment({ ...ctx, scheduleId })
    const stranger = await insertAuthUser()

    const ownerSchedules = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.accrual_schedules WHERE id = $1`, [scheduleId]),
    )
    expect(ownerSchedules.rows).toHaveLength(1)

    const strangerSchedules = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.accrual_schedules WHERE id = $1`, [scheduleId]),
    )
    expect(strangerSchedules.rows).toHaveLength(0)

    const strangerInstallments = await withUserContext(stranger, (client) =>
      client.query(
        `SELECT id FROM public.accrual_schedule_installments WHERE schedule_id = $1`,
        [scheduleId],
      ),
    )
    expect(strangerInstallments.rows).toHaveLength(0)
  })

  it('lets owners delete only unposted rows', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    const entryId = await insertDraftJournalEntry(ctx)
    const postedId = await insertInstallment({
      ...ctx,
      scheduleId,
      periodMonth: '2026-01-01',
      status: 'posted',
      journalEntryId: entryId,
    })
    const pendingId = await insertInstallment({
      ...ctx,
      scheduleId,
      periodMonth: '2026-02-01',
    })

    await withUserContext(ctx.userId, async (client) => {
      const posted = await client.query(
        `DELETE FROM public.accrual_schedule_installments WHERE id = $1`,
        [postedId],
      )
      expect(posted.rowCount).toBe(0)

      const schedule = await client.query(
        `DELETE FROM public.accrual_schedules WHERE id = $1`,
        [scheduleId],
      )
      expect(schedule.rowCount).toBe(0)

      const pending = await client.query(
        `DELETE FROM public.accrual_schedule_installments WHERE id = $1`,
        [pendingId],
      )
      expect(pending.rowCount).toBe(1)
    })
  })
})

describe('invoice item accrual columns', () => {
  it('rejects a period start without an end and non-17xx balance accounts', async () => {
    const ctx = await seedScheduleContext()

    const insertItem = (columns: string, values: string) =>
      getPool().query(
        `INSERT INTO public.supplier_invoice_items
           (supplier_invoice_id, description, line_total, account_number, ${columns})
         VALUES ($1, 'Försäkring', 12000, '6310', ${values})`,
        [ctx.supplierInvoiceId],
      )

    await expect(
      insertItem('accrual_period_start', `'2026-01-01'`),
    ).rejects.toThrow(/accrual_atomic/i)

    await expect(
      insertItem(
        'accrual_period_start, accrual_period_end, accrual_balance_account',
        `'2026-01-01', '2026-12-31', '5010'`,
      ),
    ).rejects.toThrow(/account_range/i)

    await expect(
      insertItem(
        'accrual_period_start, accrual_period_end, accrual_balance_account',
        `'2026-01-01', '2026-12-31', '1730'`,
      ),
    ).resolves.toBeDefined()
  })
})
