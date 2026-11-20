import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { paidBeforeFromChain, payableAmount } from '@/lib/salary/payment/payable'
import { getPool, withUserContext } from './setup'
import { insertCashAccount, seedCompany } from './fixtures'

// pg-real coverage for 20261027213117_salary_correction_pays_difference.sql:
// salary_run_payable_amounts (an ordinary run pays its effective net; a
// correction run pays the difference against what the chain of runs it
// replaces already paid, the largest effective net on the chain; a new
// employee in full; an overpaid or removed employee a negative amount; a
// broken chain nothing), its agreement with lib/salary/payment/payable.ts,
// create_salary_payment_orders paying only a positive payable, and
// salary_run_paid_by_bank moving a correction to paid once every positive
// payable is executed.

const DEBTOR = {
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  name: 'Företagskonto',
  currency: 'SEK',
  bank_name: 'SEB',
}

type Figures = { net: number; tax: number; taxOverride?: number | null }

interface Company {
  companyId: string
  userId: string
  cashAccountId: string
  annaId: string
  bertilId: string
  ceciliaId: string
  davidId: string
}

async function insertEmployee(companyId: string, userId: string, first: string, last: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start,
        clearing_number, bank_account_number)
     VALUES ($1, $2, $3, $4, $5, $6, '0000', '2026-01-01', '6000', '123456789')`,
    [id, companyId, userId, first, last, `enc-${id}`],
  )
  return id
}

async function seed(): Promise<Company> {
  const ctx = await seedCompany()
  const cashAccountId = await insertCashAccount({
    companyId: ctx.companyId,
    ledgerAccount: '1930',
    iban: DEBTOR.iban,
    source: 'enable_banking',
  })
  return {
    ...ctx,
    cashAccountId,
    annaId: await insertEmployee(ctx.companyId, ctx.userId, 'Anna', 'Andersson'),
    bertilId: await insertEmployee(ctx.companyId, ctx.userId, 'Bertil', 'Berg'),
    ceciliaId: await insertEmployee(ctx.companyId, ctx.userId, 'Cecilia', 'Ceder'),
    davidId: await insertEmployee(ctx.companyId, ctx.userId, 'David', 'Dahl'),
  }
}

/** A run with its roster; `corrects` makes it a correction run of that run. */
async function insertRun(
  c: Company,
  status: string,
  roster: Record<string, Figures>,
  corrects: string | null = null,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date, status, is_correction, corrects_run_id)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-25', $4, $5, $6)`,
    [id, c.companyId, c.userId, status, corrects !== null, corrects],
  )
  for (const [employeeId, f] of Object.entries(roster)) {
    await getPool().query(
      `INSERT INTO public.salary_run_employees
         (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree,
          gross_salary, net_salary, tax_withheld, tax_withheld_override, override_reason)
       VALUES ($1, $2, $3, $4, 'monthly', 35000, 100, 35000, $5, $6, $7, $8)`,
      [
        randomUUID(),
        id,
        employeeId,
        c.companyId,
        f.net,
        f.tax,
        f.taxOverride ?? null,
        f.taxOverride === undefined || f.taxOverride === null ? null : 'Jämkning',
      ],
    )
  }
  return id
}

async function payables(c: Company, runId: string) {
  const { rows } = await getPool().query(
    `SELECT employee_id, effective_net::text, paid_before::text, payable::text
       FROM public.salary_run_payable_amounts($1, $2)`,
    [c.companyId, runId],
  )
  return Object.fromEntries(
    rows.map((r) => [r.employee_id, { effective_net: r.effective_net, paid_before: r.paid_before, payable: r.payable }]),
  ) as Record<string, { effective_net: string; paid_before: string; payable: string | null }>
}

async function createOrders(c: Company, runId: string, confirmed = false) {
  const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; details?: Record<string, unknown>; orders?: Array<Record<string, unknown>> } }>(
    `SELECT public.create_salary_payment_orders($1, $2, $3, $4::jsonb, '2026-10-27'::date, 'Lön 2026-10', $5, $6, $7) AS result`,
    [c.companyId, runId, c.cashAccountId, JSON.stringify(DEBTOR), randomUUID(), confirmed, c.userId],
  )
  return rows[0]!.result
}

async function setStatus(orderId: string, status: string, extra = '') {
  await getPool().query(`UPDATE public.payment_orders SET status = $2 ${extra} WHERE id = $1`, [orderId, status])
}

async function execute(orderId: string) {
  await setStatus(orderId, 'approved')
  await setStatus(orderId, 'submitted', `, provider = 'open_payments', provider_payment_id = 'pay-' || id::text`)
  await setStatus(orderId, 'executed', `, executed_at = now()`)
}

async function runStatus(runId: string): Promise<string> {
  const { rows } = await getPool().query(`SELECT status FROM public.salary_runs WHERE id = $1`, [runId])
  return rows[0].status as string
}

describe('salary_run_payable_amounts', () => {
  it('pays an ordinary run its effective net, the figure create_salary_payment_orders paid before', async () => {
    const c = await seed()
    const run = await insertRun(c, 'approved', {
      [c.annaId]: { net: 28291, tax: 6709 },
      [c.bertilId]: { net: 27866, tax: 7134, taxOverride: 7000 },
      [c.ceciliaId]: { net: 0, tax: 0 },
    })
    expect(await payables(c, run)).toEqual({
      [c.annaId]: { effective_net: '28291.00', paid_before: '0', payable: '28291.00' },
      [c.bertilId]: { effective_net: '28000.00', paid_before: '0', payable: '28000.00' },
      [c.ceciliaId]: { effective_net: '0.00', paid_before: '0', payable: '0.00' },
    })
  })

  it('pays a correction the difference: raised, unchanged, lowered, new and removed employees', async () => {
    const c = await seed()
    const original = await insertRun(c, 'corrected', {
      [c.annaId]: { net: 28291, tax: 6709 },
      [c.bertilId]: { net: 27866, tax: 7134, taxOverride: 7000 },
      [c.ceciliaId]: { net: 20000, tax: 5000 },
    })
    const correction = await insertRun(
      c,
      'approved',
      {
        [c.annaId]: { net: 29491.5, tax: 6709 }, // up 1 200,50
        [c.bertilId]: { net: 27866, tax: 7134, taxOverride: 7000 }, // unchanged
        [c.davidId]: { net: 15000, tax: 3000 }, // new
        // Cecilia removed.
      },
      original,
    )
    expect(await payables(c, correction)).toEqual({
      [c.annaId]: { effective_net: '29491.50', paid_before: '28291.00', payable: '1200.50' },
      [c.bertilId]: { effective_net: '28000.00', paid_before: '28000.00', payable: '0.00' },
      [c.davidId]: { effective_net: '15000.00', paid_before: '0', payable: '15000.00' },
      [c.ceciliaId]: { effective_net: '0', paid_before: '20000.00', payable: '-20000.00' },
    })
  })

  it('over a chain of two corrections counts the most the chain paid, never what a lowering correction kept back', async () => {
    const c = await seed()
    const original = await insertRun(c, 'corrected', {
      [c.annaId]: { net: 30000, tax: 9000 },
      [c.bertilId]: { net: 28000, tax: 7000 },
    })
    // Anna up to 31 000 (paid 1 000); Bertil down to 27 000 (nothing paid back).
    const first = await insertRun(c, 'corrected', { [c.annaId]: { net: 31000, tax: 9000 }, [c.bertilId]: { net: 27000, tax: 7000 } }, original)
    const second = await insertRun(c, 'approved', { [c.annaId]: { net: 31500, tax: 9000 }, [c.bertilId]: { net: 28100, tax: 7000 } }, first)
    const result = await payables(c, second)
    expect(result[c.annaId]).toEqual({ effective_net: '31500.00', paid_before: '31000.00', payable: '500.00' })
    expect(result[c.bertilId]).toEqual({ effective_net: '28100.00', paid_before: '28000.00', payable: '100.00' })
  })

  it('agrees with lib/salary/payment/payable.ts on every employee of a chain', async () => {
    const c = await seed()
    const rosters: Array<Record<string, Figures>> = [
      { [c.annaId]: { net: 30000.4, tax: 9000 }, [c.bertilId]: { net: 28000, tax: 7134, taxOverride: 7000 }, [c.ceciliaId]: { net: 100, tax: 0 } },
      { [c.annaId]: { net: 29999.99, tax: 9000 }, [c.bertilId]: { net: 28500.25, tax: 7134 }, [c.davidId]: { net: 50, tax: 0 } },
      { [c.annaId]: { net: 30100.01, tax: 9000, taxOverride: 8999.99 }, [c.bertilId]: { net: 27000.75, tax: 7134 }, [c.davidId]: { net: 75.5, tax: 0 } },
    ]
    const original = await insertRun(c, 'corrected', rosters[0]!)
    const first = await insertRun(c, 'corrected', rosters[1]!, original)
    const second = await insertRun(c, 'approved', rosters[2]!, first)

    const toInput = (employeeId: string, f: Figures) => ({
      employee_id: employeeId,
      name: employeeId,
      net_salary: f.net,
      tax_withheld: f.tax,
      tax_withheld_override: f.taxOverride ?? null,
    })
    const chain = [rosters[1]!, rosters[0]!].flatMap((r) => Object.entries(r).map(([id, f]) => toInput(id, f)))
    const paidBefore = { correctsRunId: first, chainRunIds: [first, original], byEmployee: paidBeforeFromChain(chain) }

    const sql = await payables(c, second)
    for (const [employeeId, f] of Object.entries(rosters[2]!)) {
      expect([employeeId, Number(sql[employeeId]!.payable)]).toEqual([employeeId, payableAmount(toInput(employeeId, f), employeeId, paidBefore)])
    }
    // Cecilia is on the chain only: the SQL names the overpayment the TS names.
    expect(Number(sql[c.ceciliaId]!.payable)).toBe(-100)
  })

  it('pays nothing on a guess when the corrected run is not in the company', async () => {
    const c = await seed()
    const other = await seed()
    const elsewhere = await insertRun(other, 'corrected', { [other.annaId]: { net: 1000, tax: 0 } })
    const correction = await insertRun(c, 'approved', { [c.annaId]: { net: 30000, tax: 9000 } }, elsewhere)
    expect((await payables(c, correction))[c.annaId]!.payable).toBeNull()
    expect(await createOrders(c, correction)).toMatchObject({ ok: false, code: 'nothing_to_pay' })
  })

  it('is the service role\'s alone to execute', async () => {
    const { rows } = await getPool().query(
      `SELECT r.rolname, has_function_privilege(r.rolname, 'public.salary_run_payable_amounts(uuid, uuid)'::regprocedure, 'EXECUTE') AS can
         FROM pg_roles r
        WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
        ORDER BY r.rolname`,
    )
    expect(rows).toEqual([
      { rolname: 'anon', can: false },
      { rolname: 'authenticated', can: false },
      { rolname: 'service_role', can: true },
    ])
    const c = await seed()
    await expect(
      withUserContext(c.userId, (client) =>
        client.query(`SELECT * FROM public.salary_run_payable_amounts($1, $2)`, [c.companyId, randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied for function/)
  })
})

describe('create_salary_payment_orders on a correction run', () => {
  it('pays only a positive difference, a new employee in full, and never an overpaid or removed employee', async () => {
    const c = await seed()
    const original = await insertRun(c, 'corrected', {
      [c.annaId]: { net: 28291, tax: 6709 },
      [c.bertilId]: { net: 27866, tax: 7134, taxOverride: 7000 },
      [c.ceciliaId]: { net: 20000, tax: 5000 },
    })
    const correction = await insertRun(
      c,
      'approved',
      {
        [c.annaId]: { net: 29491, tax: 6709 }, // up 1 200
        [c.bertilId]: { net: 27500, tax: 7134, taxOverride: 7000 }, // down 366: overpaid
        [c.davidId]: { net: 15000, tax: 3000 }, // new
      },
      original,
    )

    const result = await createOrders(c, correction)
    expect(result.ok).toBe(true)
    const amounts = Object.fromEntries(result.orders!.map((o) => [o.employee_id as string, Number(o.amount)]))
    expect(amounts).toEqual({ [c.annaId]: 1200, [c.davidId]: 15000 })
  })

  it('has nothing to pay when the correction raises nobody', async () => {
    const c = await seed()
    const original = await insertRun(c, 'corrected', { [c.annaId]: { net: 28291, tax: 6709 } })
    const correction = await insertRun(c, 'approved', { [c.annaId]: { net: 28000, tax: 6709 } }, original)
    expect(await createOrders(c, correction)).toMatchObject({ ok: false, code: 'nothing_to_pay', details: { in_payment: 0 } })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE salary_run_id = $1`, [correction])
    expect(rows[0].n).toBe(0)
  })

  it('moves the correction to paid once every positive difference is executed, without waiting for the unchanged', async () => {
    const c = await seed()
    const original = await insertRun(c, 'corrected', {
      [c.annaId]: { net: 28291, tax: 6709 },
      [c.bertilId]: { net: 27866, tax: 7134 },
    })
    const correction = await insertRun(
      c,
      'approved',
      { [c.annaId]: { net: 29291, tax: 6709 }, [c.bertilId]: { net: 27866, tax: 7134 } },
      original,
    )
    const result = await createOrders(c, correction)
    expect(result.orders!.map((o) => o.employee_id)).toEqual([c.annaId])
    await execute(result.orders![0]!.id as string)
    expect(await runStatus(correction)).toBe('paid')
  })

  it('still pays and settles an ordinary run as before', async () => {
    const c = await seed()
    const run = await insertRun(c, 'approved', {
      [c.annaId]: { net: 28291, tax: 6709 },
      [c.bertilId]: { net: 27866, tax: 7134, taxOverride: 7000 },
      [c.ceciliaId]: { net: 0, tax: 0 },
    })
    const result = await createOrders(c, run)
    const amounts = Object.fromEntries(result.orders!.map((o) => [o.employee_id as string, Number(o.amount)]))
    expect(amounts).toEqual({ [c.annaId]: 28291, [c.bertilId]: 28000 })

    await execute(result.orders!.find((o) => o.employee_id === c.annaId)!.id as string)
    expect(await runStatus(run)).toBe('approved')
    await execute(result.orders!.find((o) => o.employee_id === c.bertilId)!.id as string)
    expect(await runStatus(run)).toBe('paid')
  })
})
