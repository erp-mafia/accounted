import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember, insertDraftJournalEntry } from './fixtures'

// pg-real coverage for 20260623120000_accrual_schedules.sql: CHECK
// constraints, the posted-installment immutability trigger, the FK RESTRICT
// on dissolution verifikat, RLS isolation, and the audit-preserving DELETE
// policies on both tables. 20261016004700_accrued_costs_on_supplier_invoices
// widens the expense account range to 17xx or 29xx (upplupna kostnader).
// 20261026230000_accrual_schedule_release_day_and_replan adds release_day and
// the replan_accrual_installments RPC ("Ändra periodisering").

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

  it('rejects a balance account outside 17xx/29xx on an expense schedule', async () => {
    const ctx = await seedScheduleContext()
    await expect(
      insertSchedule({ ...ctx, balanceAccount: '5010' }),
    ).rejects.toThrow(/balance_account_range/i)
    await expect(
      insertSchedule({ ...ctx, balanceAccount: '1510' }),
    ).rejects.toThrow(/balance_account_range/i)
    await expect(
      insertSchedule({ ...ctx, balanceAccount: '299' }),
    ).rejects.toThrow(/balance_account_range/i)
  })

  it('accepts a 17xx förutbetald and a 29xx upplupen kostnad on an expense schedule', async () => {
    // 20261016004700: an upplupen kostnad (a cost for months before the
    // invoice month) lives on a 29xx interimsskuld.
    const ctx = await seedScheduleContext()
    await expect(insertSchedule({ ...ctx, balanceAccount: '1730' })).resolves.toBeDefined()
    await expect(
      insertSchedule({
        ...ctx,
        balanceAccount: '2990',
        targetAccount: '5020',
        periodStart: '2025-07-01',
        periodEnd: '2025-12-31',
      }),
    ).resolves.toBeDefined()
    await expect(insertSchedule({ ...ctx, balanceAccount: '2960', targetAccount: '8410' })).resolves.toBeDefined()
  })

  it('rejects a balance account outside 17xx/29xx on a revenue schedule', async () => {
    // 20261021002400: a 17xx upplupen intäkt is accepted on revenue (see
    // accrued-income-on-invoices.pg.test.ts); anything else stays refused.
    const ctx = await seedScheduleContext()
    const invoiceId = await insertCustomerInvoice(ctx.companyId, ctx.userId)
    await expect(
      insertSchedule({
        ...ctx,
        direction: 'revenue',
        supplierInvoiceIdOverride: null,
        invoiceId,
        balanceAccount: '1510',
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
  it('rejects a period start without an end and balance accounts outside 17xx/29xx', async () => {
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

    // Upplupen kostnad (20261016004700): a 29xx interimsskuld is accepted too.
    await expect(
      insertItem(
        'accrual_period_start, accrual_period_end, accrual_balance_account',
        `'2025-10-01', '2025-12-31', '2990'`,
      ),
    ).resolves.toBeDefined()
    await expect(
      insertItem(
        'accrual_period_start, accrual_period_end, accrual_balance_account',
        `'2025-10-01', '2025-12-31', '1930'`,
      ),
    ).rejects.toThrow(/account_range/i)
  })
})

// A 12 000 schedule over 2026: January posted (linked to a verifikat),
// February to December pending at 1 000 each.
async function seedReplanSchedule() {
  const ctx = await seedScheduleContext()
  const scheduleId = await insertSchedule(ctx)
  const entryId = await insertDraftJournalEntry(ctx)
  const postedId = await insertInstallment({ ...ctx, scheduleId, periodMonth: '2026-01-01', status: 'posted', journalEntryId: entryId })
  for (let m = 2; m <= 12; m++) {
    await insertInstallment({ ...ctx, scheduleId, periodMonth: `2026-${String(m).padStart(2, '0')}-01` })
  }
  return { ...ctx, scheduleId, postedId }
}

const replanMonths = (from: number, to: number, amount: number) =>
  JSON.stringify(
    Array.from({ length: to - from + 1 }, (_, i) => ({
      period_month: `2026-${String(from + i).padStart(2, '0')}-01`,
      amount,
    })),
  )

const REPLAN_SQL = `SELECT public.replan_accrual_installments($1, $2, $3, $4, $5, $6::jsonb) AS result`

describe('accrual_schedules.release_day', () => {
  it('accepts 1-31 or null on a deferral and refuses anything else', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule(ctx)
    for (const day of [null, 1, 14, 31]) {
      await expect(
        getPool().query(`UPDATE public.accrual_schedules SET release_day = $1 WHERE id = $2`, [day, scheduleId]),
      ).resolves.toBeDefined()
    }
    for (const day of [0, 32]) {
      await expect(
        getPool().query(`UPDATE public.accrual_schedules SET release_day = $1 WHERE id = $2`, [day, scheduleId]),
      ).rejects.toThrow(/release_day_valid/)
    }
  })

  it('refuses a release day on an upplupen kostnad, which books each month end', async () => {
    const ctx = await seedScheduleContext()
    const scheduleId = await insertSchedule({ ...ctx, balanceAccount: '2990' })
    await expect(
      getPool().query(`UPDATE public.accrual_schedules SET release_day = 14 WHERE id = $1`, [scheduleId]),
    ).rejects.toThrow(/release_day_valid/)
  })

  it('refuses a release day on an upplupen intäkt, which books each month end too', async () => {
    const ctx = await seedScheduleContext()
    const invoiceId = await insertCustomerInvoice(ctx.companyId, ctx.userId)
    const scheduleId = await insertSchedule({
      ...ctx,
      direction: 'revenue',
      supplierInvoiceIdOverride: null,
      invoiceId,
      balanceAccount: '1790',
      targetAccount: '3001',
    })
    await expect(
      getPool().query(`UPDATE public.accrual_schedules SET release_day = 14 WHERE id = $1`, [scheduleId]),
    ).rejects.toThrow(/release_day_valid/)
  })
})

describe('replan_accrual_installments', () => {
  it('replaces the pending months, keeps the posted one and updates the period', async () => {
    const ctx = await seedReplanSchedule()

    await withUserContext(ctx.userId, async (client) => {
      const { rows } = await client.query(REPLAN_SQL, [
        ctx.companyId, ctx.scheduleId, ctx.userId, '2026-06-30', 14, replanMonths(2, 6, 2200),
      ])
      expect(rows[0].result).toEqual({ months: 6, pending_months: 5 })

      const installments = await client.query(
        `SELECT period_month::text AS month, amount::numeric AS amount, status, journal_entry_id
           FROM public.accrual_schedule_installments WHERE schedule_id = $1 ORDER BY period_month`,
        [ctx.scheduleId],
      )
      expect(installments.rows.map((r) => [r.month, Number(r.amount), r.status])).toEqual([
        ['2026-01-01', 1000, 'posted'],
        ['2026-02-01', 2200, 'pending'],
        ['2026-03-01', 2200, 'pending'],
        ['2026-04-01', 2200, 'pending'],
        ['2026-05-01', 2200, 'pending'],
        ['2026-06-01', 2200, 'pending'],
      ])
      expect(installments.rows[0].journal_entry_id).not.toBeNull()

      const schedule = await client.query(
        `SELECT period_end::text AS period_end, months, release_day FROM public.accrual_schedules WHERE id = $1`,
        [ctx.scheduleId],
      )
      expect(schedule.rows[0]).toEqual({ period_end: '2026-06-30', months: 6, release_day: 14 })
    })
  })

  it('refuses a plan that no longer adds up or covers a posted month, and changes nothing', async () => {
    const ctx = await seedReplanSchedule()

    await withUserContext(ctx.userId, async (client) => {
      await client.query('SAVEPOINT s')
      // 5 x 2 000 + 1 000 posted is 11 000, not the total 12 000.
      await expect(
        client.query(REPLAN_SQL, [ctx.companyId, ctx.scheduleId, ctx.userId, '2026-06-30', null, replanMonths(2, 6, 2000)]),
      ).rejects.toThrow(/ACCRUAL_REPLAN_CONFLICT/)
      await client.query('ROLLBACK TO SAVEPOINT s')
      // January is posted: a plan that books it again is refused.
      await expect(
        client.query(REPLAN_SQL, [ctx.companyId, ctx.scheduleId, ctx.userId, '2026-06-30', null, replanMonths(1, 6, 2000)]),
      ).rejects.toThrow(/ACCRUAL_REPLAN_CONFLICT/)
      await client.query('ROLLBACK TO SAVEPOINT s')

      const pending = await client.query(
        `SELECT count(*)::int AS n FROM public.accrual_schedule_installments WHERE schedule_id = $1 AND status = 'pending'`,
        [ctx.scheduleId],
      )
      expect(pending.rows[0].n).toBe(11)
    })
  })

  it('refuses a schedule that is not active', async () => {
    const ctx = await seedReplanSchedule()
    await getPool().query(`UPDATE public.accrual_schedules SET status = 'completed' WHERE id = $1`, [ctx.scheduleId])

    await withUserContext(ctx.userId, async (client) => {
      await expect(
        client.query(REPLAN_SQL, [ctx.companyId, ctx.scheduleId, ctx.userId, '2026-06-30', null, replanMonths(2, 6, 2200)]),
      ).rejects.toThrow(/ACCRUAL_SCHEDULE_NOT_ACTIVE/)
    })
  })

  it('refuses a viewer, a stranger and a caller attributing another user', async () => {
    const ctx = await seedReplanSchedule()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    const stranger = await insertAuthUser()
    const args = (userId: string) => [ctx.companyId, ctx.scheduleId, userId, '2026-06-30', null, replanMonths(2, 6, 2200)]

    await withUserContext(viewer, async (client) => {
      await expect(client.query(REPLAN_SQL, args(viewer))).rejects.toThrow(/unauthorized/)
    })
    await withUserContext(stranger, async (client) => {
      await expect(client.query(REPLAN_SQL, args(stranger))).rejects.toThrow(/unauthorized/)
    })
    await withUserContext(stranger, async (client) => {
      await expect(client.query(REPLAN_SQL, args(ctx.userId))).rejects.toThrow(/unauthorized/)
    })
  })

  it('leaves the posted month frozen by the immutability trigger', async () => {
    const ctx = await seedReplanSchedule()
    await withUserContext(ctx.userId, async (client) => {
      await client.query(REPLAN_SQL, [ctx.companyId, ctx.scheduleId, ctx.userId, '2026-06-30', null, replanMonths(2, 6, 2200)])
    })
    await expect(
      getPool().query(`UPDATE public.accrual_schedule_installments SET amount = 999 WHERE id = $1`, [ctx.postedId]),
    ).rejects.toThrow(/posted accrual installment/i)
  })
})
