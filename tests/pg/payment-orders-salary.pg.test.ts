import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCashAccount, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261027100000_payment_orders_salary.sql: the salary
// run and employee on an order, the widened purpose and payee source, the
// CHECK that pins a salary order to a run, an employee and a domestic account,
// one live order per employee and run, the freeze of what a salary order
// pays, the run moving to paid when every payout is executed, the guard on
// taking a run back, the refusal of a payment file beside live bank payments,
// create_salary_payment_orders (amounts and accounts read from the run, the
// 'created' events, the replaced drafts, idempotent replay and its mismatch,
// the run-status and confirmation refusals, the write-role, sandbox and
// EXECUTE guards), and the claim and release treating a salary order like a
// skattekonto order.

const DEBTOR = {
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  name: 'Företagskonto',
  currency: 'SEK',
  bank_name: 'SEB',
}

type CreateResult = {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  orders?: Array<Record<string, unknown>>
  replaced_draft_ids?: string[]
}

interface Payroll {
  companyId: string
  userId: string
  cashAccountId: string
  runId: string
  /** Net 28 291, no override: pays 28 291. */
  annaId: string
  /** Net 27 866 computed with 7 134 tax, overridden to 7 000: pays 28 000. */
  bertilId: string
  /** Net 0 (a nettolöneavdrag ate it): not paid, needs no account. */
  ceciliaId: string
}

async function insertEmployee(
  companyId: string,
  userId: string,
  first: string,
  last: string,
  bank: { clearing: string | null; account: string | null },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start,
        clearing_number, bank_account_number)
     VALUES ($1, $2, $3, $4, $5, $6, '0000', '2026-01-01', $7, $8)`,
    // personnummer is unique per company (employees_company_id_personnummer_key).
    [id, companyId, userId, first, last, `enc-${id}`, bank.clearing, bank.account],
  )
  return id
}

async function insertRunEmployee(
  runId: string,
  companyId: string,
  employeeId: string,
  figures: { net: number; tax: number; taxOverride?: number | null },
) {
  await getPool().query(
    `INSERT INTO public.salary_run_employees
       (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree,
        gross_salary, net_salary, tax_withheld, tax_withheld_override, override_reason)
     VALUES ($1, $2, $3, $4, 'monthly', 35000, 100, 35000, $5, $6, $7, $8)`,
    [
      randomUUID(),
      runId,
      employeeId,
      companyId,
      figures.net,
      figures.tax,
      figures.taxOverride ?? null,
      figures.taxOverride === undefined || figures.taxOverride === null ? null : 'Jämkning',
    ],
  )
}

async function seedPayroll(status = 'approved'): Promise<Payroll> {
  const ctx = await seedCompany()
  const cashAccountId = await insertCashAccount({
    companyId: ctx.companyId,
    ledgerAccount: '1930',
    iban: DEBTOR.iban,
    source: 'enable_banking',
  })
  const annaId = await insertEmployee(ctx.companyId, ctx.userId, 'Anna', 'Andersson', { clearing: '8327-9', account: '123 456 789-0' })
  const bertilId = await insertEmployee(ctx.companyId, ctx.userId, 'Bertil', 'Berg', { clearing: '6000', account: '123456789' })
  const ceciliaId = await insertEmployee(ctx.companyId, ctx.userId, 'Cecilia', 'Ceder', { clearing: null, account: null })
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-25', $4)`,
    [runId, ctx.companyId, ctx.userId, status],
  )
  await insertRunEmployee(runId, ctx.companyId, annaId, { net: 28291, tax: 6709 })
  await insertRunEmployee(runId, ctx.companyId, bertilId, { net: 27866, tax: 7134, taxOverride: 7000 })
  await insertRunEmployee(runId, ctx.companyId, ceciliaId, { net: 0, tax: 0 })
  return { ...ctx, cashAccountId, runId, annaId, bertilId, ceciliaId }
}

// Service-role style call: no JWT claims on the superuser pool, so the RPC
// takes p_user_id as the actor (the route authenticated the person in code).
async function createSalaryOrders(
  p: Payroll,
  overrides: { idempotencyKey?: string | null; reference?: string | null; confirmed?: boolean; userId?: string; runId?: string } = {},
): Promise<CreateResult> {
  const { rows } = await getPool().query<{ result: CreateResult }>(
    `SELECT public.create_salary_payment_orders($1, $2, $3, $4::jsonb, $5::date, $6, $7, $8, $9) AS result`,
    [
      p.companyId,
      overrides.runId ?? p.runId,
      p.cashAccountId,
      JSON.stringify(DEBTOR),
      '2026-10-27',
      overrides.reference === undefined ? 'Lön 2026-10' : overrides.reference,
      overrides.idempotencyKey === undefined ? randomUUID() : overrides.idempotencyKey,
      overrides.confirmed ?? false,
      overrides.userId ?? p.userId,
    ],
  )
  return rows[0]!.result
}

async function createdSalaryOrders(p: Payroll) {
  const result = await createSalaryOrders(p)
  expect(result.ok).toBe(true)
  return result.orders! as Array<{ id: string; employee_id: string; status: string }>
}

function orderOf(orders: Array<{ id: string; employee_id: string }>, employeeId: string) {
  const order = orders.find((o) => o.employee_id === employeeId)
  expect(order).toBeDefined()
  return order!
}

async function setStatus(orderId: string, status: string, extra = '') {
  await getPool().query(`UPDATE public.payment_orders SET status = $2 ${extra} WHERE id = $1`, [orderId, status])
}

/** draft -> approved -> submitted -> executed, the way the lifecycle trigger allows. */
async function execute(orderId: string) {
  await setStatus(orderId, 'approved')
  await setStatus(orderId, 'submitted', `, provider = 'open_payments', provider_payment_id = 'pay-' || id::text`)
  await setStatus(orderId, 'executed', `, executed_at = now()`)
}

async function runRow(runId: string) {
  const { rows } = await getPool().query(`SELECT status, paid_at FROM public.salary_runs WHERE id = $1`, [runId])
  return rows[0] as { status: string; paid_at: Date | null }
}

async function countOrders(companyId: string, where = 'true') {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1 AND ${where}`,
    [companyId],
  )
  return rows[0].n as number
}

describe('create_salary_payment_orders', () => {
  it('makes one draft per employee with a payout, paying what the run computed to the account on the card', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    expect(orders).toHaveLength(2)

    const { rows } = await getPool().query(
      `SELECT employee_id, purpose, supplier_invoice_id, salary_run_id, status, amount, currency,
              requested_execution_date::text AS date, payee_type, payee_clearing, payee_account, payee_name,
              payee_source, payee_check, reference_type, reference, user_id
         FROM public.payment_orders WHERE salary_run_id = $1 ORDER BY payee_name`,
      [p.runId],
    )
    const common = {
      purpose: 'salary',
      supplier_invoice_id: null,
      salary_run_id: p.runId,
      status: 'draft',
      currency: 'SEK',
      date: '2026-10-27',
      payee_type: 'bank_account',
      payee_source: 'employee',
      payee_check: 'unchecked',
      reference_type: 'message',
      reference: 'Lön 2026-10',
      user_id: p.userId,
    }
    expect(rows).toEqual([
      { ...common, employee_id: p.annaId, amount: '28291.00', payee_clearing: '83279', payee_account: '1234567890', payee_name: 'Anna Andersson' },
      // The override moved 134 kr of tax back to the employee.
      { ...common, employee_id: p.bertilId, amount: '28000.00', payee_clearing: '6000', payee_account: '123456789', payee_name: 'Bertil Berg' },
    ])

    const events = await getPool().query(
      `SELECT event_type, to_status, actor_user_id FROM public.payment_order_events WHERE payment_order_id = ANY($1::uuid[])`,
      [orders.map((o) => o.id)],
    )
    expect(events.rows).toEqual([
      { event_type: 'created', to_status: 'draft', actor_user_id: p.userId },
      { event_type: 'created', to_status: 'draft', actor_user_id: p.userId },
    ])
  })

  it('marks an account the bank already paid salary to as known', async () => {
    const p = await seedPayroll()
    const first = await createdSalaryOrders(p)
    await execute(orderOf(first, p.annaId).id)
    // Bertil's draft is replaced; Anna is paid and stays out.
    const second = await createdSalaryOrders(p)
    expect(second.map((o) => o.employee_id)).toEqual([p.bertilId])

    const next = await seedPayroll()
    // Same company, a later run: Anna's account is known, Bertil's is not.
    const laterRun = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 11, '2026-11-25', 'approved')`,
      [laterRun, p.companyId, p.userId],
    )
    await insertRunEmployee(laterRun, p.companyId, p.annaId, { net: 100, tax: 0 })
    await insertRunEmployee(laterRun, p.companyId, p.bertilId, { net: 100, tax: 0 })
    const later = await createSalaryOrders(p, { runId: laterRun })
    expect(later.ok).toBe(true)
    const checks = Object.fromEntries(later.orders!.map((o) => [o.employee_id, o.payee_check]))
    expect(checks).toEqual({ [p.annaId]: 'known', [p.bertilId]: 'unchecked' })
    // Another company never counts.
    const elsewhere = await createdSalaryOrders(next)
    expect(elsewhere.every((o) => (o as Record<string, unknown>).payee_check === 'unchecked')).toBe(true)
  })

  it('replaces the run\'s drafts and leaves an employee in payment out', async () => {
    const p = await seedPayroll()
    const first = await createdSalaryOrders(p)
    const anna = orderOf(first, p.annaId)
    const bertil = orderOf(first, p.bertilId)
    await setStatus(anna.id, 'approved')

    const second = await createSalaryOrders(p)
    expect(second.ok).toBe(true)
    expect(second.replaced_draft_ids).toEqual([bertil.id])
    expect(second.orders!.map((o) => o.employee_id)).toEqual([p.bertilId])

    const { rows } = await getPool().query(
      `SELECT status, cancelled_by FROM public.payment_orders WHERE id = $1`,
      [bertil.id],
    )
    expect(rows[0]).toEqual({ status: 'cancelled', cancelled_by: p.userId })
    const events = await getPool().query(
      `SELECT event_type, detail FROM public.payment_order_events WHERE payment_order_id = $1 ORDER BY occurred_at`,
      [bertil.id],
    )
    expect(events.rows.map((e) => e.event_type)).toEqual(['created', 'cancelled'])
    expect(events.rows[1].detail).toEqual({ replaced_by_new_draft: true })

    // Everyone approved: nothing left to prepare.
    await setStatus(second.orders![0]!.id as string, 'approved')
    expect(await createSalaryOrders(p)).toMatchObject({ ok: false, code: 'nothing_to_pay', details: { in_payment: 2 } })
  })

  it('pays an employee again once the bank rejected or failed the payment', async () => {
    const p = await seedPayroll()
    const first = await createdSalaryOrders(p)
    const anna = orderOf(first, p.annaId)
    await setStatus(anna.id, 'approved')
    await setStatus(anna.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'pay-r'`)
    await setStatus(anna.id, 'rejected')
    await setStatus(orderOf(first, p.bertilId).id, 'approved')

    const retry = await createSalaryOrders(p)
    expect(retry.ok).toBe(true)
    expect(retry.orders!.map((o) => o.employee_id)).toEqual([p.annaId])
  })

  it('returns the same orders when the key is replayed, and refuses a key another payment used', async () => {
    const p = await seedPayroll()
    const first = await createSalaryOrders(p, { idempotencyKey: 'salary-replay-1' })
    const again = await createSalaryOrders(p, { idempotencyKey: 'salary-replay-1' })
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    expect(again.orders!.map((o) => o.id).sort()).toEqual(first.orders!.map((o) => o.id).sort())
    expect(await countOrders(p.companyId)).toBe(2)

    const { rows } = await getPool().query(`SELECT idempotency_key FROM public.payment_orders WHERE salary_run_id = $1`, [p.runId])
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([`salary-replay-1:${p.annaId}`, `salary-replay-1:${p.bertilId}`].sort())

    // A key whose orders pay another run is a caller bug.
    const otherRun = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 11, '2026-11-25', 'approved')`,
      [otherRun, p.companyId, p.userId],
    )
    expect(await createSalaryOrders(p, { idempotencyKey: 'salary-replay-1', runId: otherRun })).toMatchObject({
      ok: false,
      code: 'idempotency_mismatch',
    })
  })

  it('refuses a run that is not approved, paid or booked, and one not in the company', async () => {
    for (const status of ['draft', 'review']) {
      const p = await seedPayroll(status)
      expect(await createSalaryOrders(p)).toMatchObject({ ok: false, code: 'run_not_payable', details: { status } })
      expect(await countOrders(p.companyId)).toBe(0)
    }
    const p = await seedPayroll()
    expect(await createSalaryOrders(p, { runId: randomUUID() })).toMatchObject({ ok: false, code: 'run_not_found' })
  })

  it('asks the person to confirm nothing was paid for a paid or booked run, or once a payment file was made', async () => {
    for (const status of ['paid', 'booked']) {
      const p = await seedPayroll(status)
      expect(await createSalaryOrders(p)).toMatchObject({ ok: false, code: 'confirmation_required', details: { status } })
      expect(await countOrders(p.companyId)).toBe(0)
      expect(await createSalaryOrders(p, { confirmed: true })).toMatchObject({ ok: true })
    }

    const p = await seedPayroll()
    await getPool().query(`UPDATE public.salary_runs SET payment_file_generated_at = now(), payment_file_format = 'pain001' WHERE id = $1`, [p.runId])
    expect(await createSalaryOrders(p)).toMatchObject({ ok: false, code: 'confirmation_required', details: { status: 'approved' } })
    expect(await createSalaryOrders(p, { confirmed: true })).toMatchObject({ ok: true })
  })

  it('names every employee without a usable account and writes nothing, drafts included', async () => {
    const p = await seedPayroll()
    const first = await createdSalaryOrders(p)
    await getPool().query(`UPDATE public.employees SET bank_account_number = NULL WHERE id = $1`, [p.annaId])
    await getPool().query(`UPDATE public.employees SET clearing_number = '12' WHERE id = $1`, [p.bertilId])

    expect(await createSalaryOrders(p)).toMatchObject({
      ok: false,
      code: 'employee_bank_missing',
      details: {
        employees: [
          { employee_id: p.annaId, name: 'Anna Andersson' },
          { employee_id: p.bertilId, name: 'Bertil Berg' },
        ],
      },
    })
    // The earlier drafts are still there: a refusal changes nothing.
    expect(await countOrders(p.companyId, `status = 'draft'`)).toBe(first.length)
  })

  it('refuses an empty message and a missing key', async () => {
    const p = await seedPayroll()
    expect(await createSalaryOrders(p, { reference: '  ' })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createSalaryOrders(p, { reference: null })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createSalaryOrders(p, { idempotencyKey: null })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createSalaryOrders(p, { idempotencyKey: 'k'.repeat(161) })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await countOrders(p.companyId)).toBe(0)
  })

  it('refuses a sandbox company, even when called directly', async () => {
    const p = await seedPayroll()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)
       ON CONFLICT (company_id) DO UPDATE SET is_sandbox = true`,
      [p.userId, p.companyId],
    )
    expect(await createSalaryOrders(p)).toMatchObject({ ok: false, code: 'sandbox' })
    expect(await countOrders(p.companyId)).toBe(0)
  })

  it('refuses a viewer, a non-member and any browser session; EXECUTE is the service role\'s alone', async () => {
    const p = await seedPayroll()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: p.companyId, userId: viewer, role: 'viewer' })
    await expect(createSalaryOrders(p, { userId: viewer })).rejects.toThrow(/no write role/)
    const stranger = await insertAuthUser()
    await expect(createSalaryOrders(p, { userId: stranger })).rejects.toThrow(/no write role/)

    await expect(
      withUserContext(p.userId, (client) =>
        client.query(
          `SELECT public.create_salary_payment_orders($1, $2, $3, '{}'::jsonb, '2026-10-27'::date, 'Lön', 'k')`,
          [p.companyId, p.runId, p.cashAccountId],
        ),
      ),
    ).rejects.toThrow(/permission denied for function/)

    const { rows } = await getPool().query(
      `SELECT r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can
         FROM pg_proc p CROSS JOIN pg_roles r
        WHERE p.proname = 'create_salary_payment_orders'
          AND p.pronamespace = 'public'::regnamespace
          AND r.rolname IN ('anon', 'authenticated', 'service_role')`,
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) expect([row.rolname, row.can]).toEqual([row.rolname, row.rolname === 'service_role'])
  })
})

describe('what a salary order is', () => {
  function insertOrder(p: Payroll, overrides: Record<string, unknown>) {
    const row: Record<string, unknown> = {
      company_id: p.companyId,
      user_id: p.userId,
      purpose: 'salary',
      salary_run_id: p.runId,
      employee_id: p.annaId,
      amount: 10,
      requested_execution_date: '2026-10-27',
      cash_account_id: p.cashAccountId,
      debtor_snapshot: JSON.stringify(DEBTOR),
      payee_type: 'bank_account',
      payee_clearing: '83279',
      payee_account: '1234567890',
      payee_name: 'Anna Andersson',
      payee_source: 'employee',
      reference_type: 'message',
      reference: 'Lön 2026-10',
      idempotency_key: randomUUID(),
      ...overrides,
    }
    const columns = Object.keys(row)
    return getPool().query(
      `INSERT INTO public.payment_orders (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      columns.map((c) => row[c]),
    )
  }

  it('pins a salary order to a run, an employee, a domestic account of digits, the employee as source and SEK', async () => {
    const p = await seedPayroll()
    await expect(insertOrder(p, { salary_run_id: null })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { employee_id: null })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(
      insertOrder(p, { payee_type: 'bankgiro', payee_bankgiro: '50501055', payee_clearing: null, payee_account: null }),
    ).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { payee_clearing: '83A7' })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { payee_account: '1234-567' })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { payee_source: 'supplier' })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { reference_type: 'ocr', reference: '1234' })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { currency: 'EUR' })).rejects.toThrow(/payment_orders_salary_instruction/)
    await insertOrder(p, {})
  })

  it('never gives another purpose a run, an employee or the employee as payee source', async () => {
    const p = await seedPayroll()
    const skattekonto = {
      purpose: 'skattekonto',
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_clearing: null,
      payee_account: null,
      payee_name: 'Skatteverket',
      payee_source: 'skatteverket',
      reference_type: 'ocr',
      reference: '1655954700217',
    }
    await expect(insertOrder(p, { ...skattekonto, employee_id: null })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(insertOrder(p, { ...skattekonto, salary_run_id: null })).rejects.toThrow(/payment_orders_salary_instruction/)
    await expect(
      insertOrder(p, { ...skattekonto, salary_run_id: null, employee_id: null, payee_source: 'employee' }),
    ).rejects.toThrow(/payment_orders_(salary|skattekonto)_instruction/)
    await insertOrder(p, { ...skattekonto, salary_run_id: null, employee_id: null })
  })

  it('refuses a run or an employee of another company', async () => {
    const p = await seedPayroll()
    const other = await seedPayroll()
    await expect(insertOrder(p, { salary_run_id: other.runId })).rejects.toThrow(/fk_payment_orders_salary_run/)
    await expect(insertOrder(p, { employee_id: other.annaId })).rejects.toThrow(/fk_payment_orders_employee/)
  })

  it('holds one live order per employee and run, executed included', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    await expect(insertOrder(p, {})).rejects.toThrow(/uq_payment_orders_live_salary_per_employee/)

    await execute(orderOf(orders, p.annaId).id)
    await expect(insertOrder(p, {})).rejects.toThrow(/uq_payment_orders_live_salary_per_employee/)

    // A rejected one frees Bertil.
    const bertil = orderOf(orders, p.bertilId).id
    await setStatus(bertil, 'approved')
    await setStatus(bertil, 'submitted', `, provider = 'open_payments', provider_payment_id = 'pay-b'`)
    await setStatus(bertil, 'rejected')
    await insertOrder(p, { employee_id: p.bertilId, payee_clearing: '6000', payee_account: '123456789', payee_name: 'Bertil Berg' })
  })

  it('never changes what a salary order pays, a draft included; the day may still move', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    const id = orderOf(orders, p.annaId).id
    const update = (set: string) => getPool().query(`UPDATE public.payment_orders SET ${set} WHERE id = $1`, [id])

    await expect(update(`amount = 1`)).rejects.toThrow(/pays what the run computed/)
    await expect(update(`payee_account = '9999999999'`)).rejects.toThrow(/pays what the run computed/)
    await expect(update(`payee_name = 'Någon Annan'`)).rejects.toThrow(/pays what the run computed/)
    await expect(update(`reference = 'Bonus'`)).rejects.toThrow(/pays what the run computed/)
    await expect(update(`employee_id = '${p.bertilId}'`)).rejects.toThrow(/never change/)
    const other = await seedPayroll()
    await expect(update(`salary_run_id = '${other.runId}'`)).rejects.toThrow(/never change|fk_payment_orders_salary_run/)

    await update(`requested_execution_date = '2026-10-28'`)
  })
})

describe('the run follows its bank payments', () => {
  it('moves an approved run to paid once every employee with a payout has an executed payment', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)

    await execute(orderOf(orders, p.annaId).id)
    expect(await runRow(p.runId)).toMatchObject({ status: 'approved', paid_at: null })

    await execute(orderOf(orders, p.bertilId).id)
    const run = await runRow(p.runId)
    expect(run.status).toBe('paid')
    expect(run.paid_at).not.toBeNull()
  })

  it('leaves a run that is paid or booked already as it is', async () => {
    const p = await seedPayroll('booked')
    const result = await createSalaryOrders(p, { confirmed: true })
    for (const order of result.orders!) await execute(order.id as string)
    expect(await runRow(p.runId)).toMatchObject({ status: 'booked', paid_at: null })
  })

  it('refuses to take a run back while a payment is approved, at the bank or executed', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    await setStatus(orderOf(orders, p.annaId).id, 'approved')
    await expect(
      getPool().query(`UPDATE public.salary_runs SET status = 'review' WHERE id = $1`, [p.runId]),
    ).rejects.toThrow(/bank payment\(s\) approved, at the bank or executed/)
    expect(await runRow(p.runId)).toMatchObject({ status: 'approved' })
    // Nothing was cancelled by the refused recall.
    expect(await countOrders(p.companyId, `status = 'draft'`)).toBe(1)
  })

  it('cancels the run\'s drafts when it is taken back', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    await getPool().query(`UPDATE public.salary_runs SET status = 'review' WHERE id = $1`, [p.runId])

    expect(await countOrders(p.companyId, `status = 'cancelled'`)).toBe(2)
    const events = await getPool().query(
      `SELECT detail FROM public.payment_order_events
        WHERE payment_order_id = ANY($1::uuid[]) AND event_type = 'cancelled'`,
      [orders.map((o) => o.id)],
    )
    expect(events.rows.map((e) => e.detail)).toEqual([{ reason: 'salary_run_recalled' }, { reason: 'salary_run_recalled' }])
  })

  it('refuses a payment file while a bank payment of the run is live, and allows one once they are cancelled', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    const archive = () =>
      getPool().query(
        `INSERT INTO public.salary_payment_files
           (company_id, salary_run_id, user_id, format, filename, content_type, charset, content, sha256, byte_size,
            payment_date, employee_count, total_amount)
         VALUES ($1, $2, $3, 'pain001', 'lon_2026-10.xml', 'application/xml', 'utf-8', '<x/>', $4, 4,
                 '2026-10-25', 2, 56291)`,
        [p.companyId, p.runId, p.userId, 'a'.repeat(64)],
      )
    await expect(archive()).rejects.toThrow(/paid through the bank/)

    for (const order of orders) await setStatus(order.id, 'cancelled', `, cancelled_at = now()`)
    await archive()
  })
})

describe('signing a salary order', () => {
  async function claim(companyId: string, userId: string, orderIds: string[]) {
    const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; batch?: Record<string, unknown>; orders?: Array<Record<string, unknown>> } }>(
      `SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3) AS result`,
      [companyId, orderIds, userId],
    )
    return rows[0]!.result
  }

  it('claims the run\'s payments as one basket signing', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    for (const order of orders) await setStatus(order.id, 'approved')

    const result = await claim(p.companyId, p.userId, orders.map((o) => o.id))

    expect(result.ok).toBe(true)
    expect(result.batch).toMatchObject({ signing_target: 'basket', order_count: 2, status: 'created' })
    expect(Number(result.batch!.total_amount)).toBe(56291)
  })

  it('goes back to approved when the bank confirmed the cancel of its payment', async () => {
    const p = await seedPayroll()
    const orders = await createdSalaryOrders(p)
    const id = orderOf(orders, p.annaId).id
    await setStatus(id, 'approved')
    const claimed = await claim(p.companyId, p.userId, [id])
    const batchId = claimed.batch!.id as string
    await getPool().query(`UPDATE public.payment_orders SET provider_payment_id = 'sal-pay-1', status = 'awaiting_signature' WHERE id = $1`, [id])

    const { rows } = await getPool().query(
      `SELECT public.release_payment_order($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
      [p.companyId, id, batchId, 'sal-pay-1', 'CANC', 'SIGNING_STOPPED', null, p.userId],
    )
    expect(rows[0].result).toEqual({ ok: true, status: 'approved' })
  })
})
