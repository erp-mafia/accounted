import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261027213119_shift_premium_rule_forms: the amount
// form CHECK (exactly the field of the chosen form), the validity order, the
// provenance pair on salary_line_items, and the NO ACTION back-link that
// makes lib/salary/shift-premium-rules.ts switch a used rule off instead of
// deleting it.

interface Seed {
  companyId: string
  sreId: string
}

async function seed(): Promise<Seed> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 4, '2026-04-25', 'draft')`,
    [runId, companyId, userId],
  )
  const sreId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 40000, 100)`,
    [sreId, runId, employeeId, companyId],
  )
  return { companyId, sreId }
}

interface RuleFields {
  amount_form?: string
  premium_percent?: number | null
  monthly_divisor?: number | null
  sek_per_hour?: number | null
  hourly_divisor?: number | null
  valid_from?: string | null
  valid_to?: string | null
}

async function insertRule(companyId: string, fields: RuleFields): Promise<string> {
  const id = randomUUID()
  const columns = ['id', 'company_id', 'name', 'day_of_week', 'start_time', 'end_time', 'item_type']
  const values: unknown[] = [id, companyId, 'OB kväll', [1, 2, 3, 4, 5], '18:00', '06:00', 'ob_weekday_evening']
  for (const [key, value] of Object.entries(fields)) {
    columns.push(key)
    values.push(value)
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  await getPool().query(`INSERT INTO public.shift_premium_rules (${columns.join(', ')}) VALUES (${placeholders})`, values)
  return id
}

describe('shift_premium_rules amount forms', () => {
  it('keeps percent_of_hourly as the default form, so an existing-style insert still works', async () => {
    const { companyId } = await seed()
    const id = await insertRule(companyId, { premium_percent: 50 })
    const { rows } = await getPool().query<{ amount_form: string; valid_from: string | null }>(
      `SELECT amount_form, valid_from FROM public.shift_premium_rules WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ amount_form: 'percent_of_hourly', valid_from: null })
  })

  it('accepts exactly the field of each form', async () => {
    const { companyId } = await seed()
    await insertRule(companyId, { amount_form: 'percent_of_hourly', premium_percent: 50, hourly_divisor: 166 })
    await insertRule(companyId, { amount_form: 'monthly_divisor', monthly_divisor: 480, valid_from: '2025-04-01' })
    await insertRule(companyId, {
      amount_form: 'sek_per_hour',
      sek_per_hour: 27.59,
      valid_from: '2026-04-01',
      valid_to: '2027-03-31',
    })
  })

  it.each<[string, RuleFields]>([
    ['a divisor rule that also carries a percent', { amount_form: 'monthly_divisor', monthly_divisor: 480, premium_percent: 50 }],
    ['a divisor rule without its divisor', { amount_form: 'monthly_divisor' }],
    ['a fixed-amount rule with an hourly divisor', { amount_form: 'sek_per_hour', sek_per_hour: 20, hourly_divisor: 166 }],
    ['a percent rule without its percent', { amount_form: 'percent_of_hourly' }],
    ['an unknown form', { amount_form: 'per_shift', premium_percent: 50 }],
    ['a divisor below 1', { amount_form: 'monthly_divisor', monthly_divisor: 0.5 }],
    ['a negative fixed amount', { amount_form: 'sek_per_hour', sek_per_hour: -1 }],
    ['a validity that ends before it starts', { premium_percent: 50, valid_from: '2026-04-01', valid_to: '2026-03-31' }],
  ])('refuses %s', async (_label, fields) => {
    const { companyId } = await seed()
    await expect(insertRule(companyId, fields)).rejects.toMatchObject({ code: '23514' })
  })
})

describe('salary_line_items premium provenance', () => {
  async function premiumLine(s: Seed, fields: { itemType: string; ruleId: string | null; basis: unknown }) {
    await getPool().query(
      `INSERT INTO public.salary_line_items
         (id, salary_run_employee_id, company_id, item_type, description, quantity, amount, source_premium_rule_id, premium_basis)
       VALUES ($1, $2, $3, $4, 'OB kväll (2026-04-07, 3 h)', 3, 250, $5, $6)`,
      [randomUUID(), s.sreId, s.companyId, fields.itemType, fields.ruleId, fields.basis],
    )
  }

  it('stores the rule and its frozen basis on a derived premium line', async () => {
    const s = await seed()
    const ruleId = await insertRule(s.companyId, { amount_form: 'monthly_divisor', monthly_divisor: 480 })
    await premiumLine(s, { itemType: 'ob_weekday_evening', ruleId, basis: { v: 1, rule_id: ruleId, monthly_divisor: 480 } })
  })

  it('refuses half the pair, and provenance on a type the engine does not derive', async () => {
    const s = await seed()
    const ruleId = await insertRule(s.companyId, { premium_percent: 50 })
    await expect(premiumLine(s, { itemType: 'ob_weekday_evening', ruleId, basis: null })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(premiumLine(s, { itemType: 'ob_weekday_evening', ruleId: null, basis: { v: 1 } })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(premiumLine(s, { itemType: 'bonus', ruleId, basis: { v: 1 } })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses to delete a rule a line derives from (NO ACTION), and still deletes an unused one', async () => {
    const s = await seed()
    const used = await insertRule(s.companyId, { premium_percent: 50 })
    const unused = await insertRule(s.companyId, { premium_percent: 70 })
    await premiumLine(s, { itemType: 'ob_weekday_evening', ruleId: used, basis: { v: 1, rule_id: used } })

    await expect(getPool().query(`DELETE FROM public.shift_premium_rules WHERE id = $1`, [used])).rejects.toMatchObject({
      code: '23503',
    })
    // The service's fallback: switch it off.
    const off = await getPool().query(`UPDATE public.shift_premium_rules SET is_active = false WHERE id = $1`, [used])
    expect(off.rowCount).toBe(1)

    const del = await getPool().query(`DELETE FROM public.shift_premium_rules WHERE id = $1`, [unused])
    expect(del.rowCount).toBe(1)

    const { rows } = await getPool().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'public.salary_line_items'::regclass
          AND conname = 'salary_line_items_source_premium_rule_id_fkey'`,
    )
    expect(rows).toEqual([{ confdeltype: 'a' }])
  })
})
