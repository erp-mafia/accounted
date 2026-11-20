import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20260919130000_employee_opening_balances_vacation_categories.sql and
 * 20260919130100_salary_line_items_vacation_category.sql:
 *   - the categorized pools on employee_opening_balances are bounded 0..40,
 *     the förskottsskuld is non-negative, ytd_net accepts NULL on both the
 *     opening row and the payslip snapshot
 *   - the derived lock trigger covers the new columns (an UPDATE that only
 *     touches a new pool is refused once a booked run exists)
 *   - employee_vacation_balances pools are non-negative
 *   - salary_line_items.vacation_category is a closed enum tied to
 *     item_type = 'vacation', and vacation_saved_year only rides on 'saved'
 */

async function seed(): Promise<{ userId: string; companyId: string; employeeId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  return { userId, companyId, employeeId }
}

async function insertOpening(params: {
  companyId: string
  employeeId: string
  ytdNet?: number | null
  asOf?: string | null
  unpaid?: number
  advance?: number
  extraPaid?: number
  debt?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employee_opening_balances
       (id, company_id, employee_id, cutover_date, ytd_gross, ytd_tax, ytd_net,
        vacation_as_of_date, vacation_unpaid_days_remaining, vacation_advance_days_remaining,
        vacation_extra_paid_days_remaining, opening_advance_vacation_debt)
     VALUES ($1, $2, $3, '2026-09-01', 280000, 64000, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      params.companyId,
      params.employeeId,
      params.ytdNet === undefined ? 216000 : params.ytdNet,
      params.asOf ?? null,
      params.unpaid ?? 0,
      params.advance ?? 0,
      params.extraPaid ?? 0,
      params.debt ?? 0,
    ],
  )
  return id
}

async function seedRun(params: {
  companyId: string
  userId: string
  employeeId: string
  status: 'draft' | 'booked'
}): Promise<{ runId: string; sreId: string }> {
  const runId = randomUUID()
  const sreId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 9, '2026-09-25', $4)`,
    [runId, params.companyId, params.userId, params.status],
  )
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
    [sreId, runId, params.employeeId, params.companyId],
  )
  return { runId, sreId }
}

function insertLine(params: {
  companyId: string
  sreId: string
  itemType: string
  category: string | null
  savedYear: string | null
}) {
  return getPool().query(
    `INSERT INTO public.salary_line_items
       (id, salary_run_employee_id, company_id, item_type, description, quantity, amount, vacation_category, vacation_saved_year)
     VALUES ($1, $2, $3, $4, 'Semester', 2, -3000, $5, $6)`,
    [randomUUID(), params.sreId, params.companyId, params.itemType, params.category, params.savedYear],
  )
}

describe('employee_opening_balances categorized pools', () => {
  it('stores every pool, the as-of date and the förskottsskuld', async () => {
    const s = await seed()
    const id = await insertOpening({ ...s, asOf: '2026-07-31', unpaid: 5, advance: 3, extraPaid: 2, debt: 4500 })
    const res = await getPool().query(
      `SELECT vacation_as_of_date::text AS as_of, vacation_unpaid_days_remaining, vacation_advance_days_remaining,
              vacation_extra_paid_days_remaining, opening_advance_vacation_debt
         FROM public.employee_opening_balances WHERE id = $1`,
      [id],
    )
    expect(res.rows[0].as_of).toBe('2026-07-31')
    expect(Number(res.rows[0].vacation_unpaid_days_remaining)).toBe(5)
    expect(Number(res.rows[0].vacation_advance_days_remaining)).toBe(3)
    expect(Number(res.rows[0].vacation_extra_paid_days_remaining)).toBe(2)
    expect(Number(res.rows[0].opening_advance_vacation_debt)).toBe(4500)
  })

  it('defaults a legacy insert to 0 pools and a NULL as-of date', async () => {
    const s = await seed()
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.employee_opening_balances (id, company_id, employee_id, cutover_date)
       VALUES ($1, $2, $3, '2026-09-01')`,
      [id, s.companyId, s.employeeId],
    )
    const res = await getPool().query(
      `SELECT vacation_as_of_date, vacation_unpaid_days_remaining, vacation_advance_days_remaining,
              vacation_extra_paid_days_remaining, opening_advance_vacation_debt, ytd_net
         FROM public.employee_opening_balances WHERE id = $1`,
      [id],
    )
    expect(res.rows[0].vacation_as_of_date).toBeNull()
    expect(Number(res.rows[0].vacation_unpaid_days_remaining)).toBe(0)
    expect(Number(res.rows[0].vacation_advance_days_remaining)).toBe(0)
    expect(Number(res.rows[0].vacation_extra_paid_days_remaining)).toBe(0)
    expect(Number(res.rows[0].opening_advance_vacation_debt)).toBe(0)
    expect(Number(res.rows[0].ytd_net)).toBe(0)
  })

  it('bounds each day pool to 0..40 and the debt to >= 0', async () => {
    const s = await seed()
    await expect(insertOpening({ ...s, unpaid: 41 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOpening({ ...s, unpaid: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOpening({ ...s, advance: 40.5 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOpening({ ...s, extraPaid: -0.5 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOpening({ ...s, debt: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOpening({ ...s, unpaid: 40, advance: 40, extraPaid: 40, debt: 0 })).resolves.toBeDefined()
  })

  it('accepts an unknown historical net as NULL on the opening row and the payslip snapshot', async () => {
    const s = await seed()
    const id = await insertOpening({ ...s, ytdNet: null })
    const opening = await getPool().query(
      `SELECT ytd_net FROM public.employee_opening_balances WHERE id = $1`,
      [id],
    )
    expect(opening.rows[0].ytd_net).toBeNull()

    const { sreId } = await seedRun({ ...s, status: 'draft' })
    await getPool().query(`UPDATE public.salary_run_employees SET ytd_net = NULL WHERE id = $1`, [sreId])
    const sre = await getPool().query(`SELECT ytd_net FROM public.salary_run_employees WHERE id = $1`, [sreId])
    expect(sre.rows[0].ytd_net).toBeNull()
  })
})

describe('enforce_opening_balances_lock covers the new columns', () => {
  it('refuses an UPDATE that only touches a new pool once a booked run exists', async () => {
    const s = await seed()
    const id = await insertOpening({ ...s, unpaid: 2 })
    await seedRun({ ...s, status: 'booked' })

    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET vacation_unpaid_days_remaining = 3 WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET vacation_as_of_date = '2026-07-31' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/låsta/)
    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET opening_advance_vacation_debt = 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/låsta/)
  })

  it('still allows the pools to change while the run is a draft', async () => {
    const s = await seed()
    const id = await insertOpening({ ...s, unpaid: 2 })
    await seedRun({ ...s, status: 'draft' })
    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET vacation_advance_days_remaining = 4 WHERE id = $1`,
        [id],
      ),
    ).resolves.toBeDefined()
  })
})

describe('employee_vacation_balances pools', () => {
  it('defaults to 0 / {} and refuses negative pools', async () => {
    const s = await seed()
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.employee_vacation_balances (id, company_id, employee_id, vacation_year_start)
       VALUES ($1, $2, $3, '2026-01-01')`,
      [id, s.companyId, s.employeeId],
    )
    const res = await getPool().query(
      `SELECT unpaid_days, advance_days, saved_days_taken FROM public.employee_vacation_balances WHERE id = $1`,
      [id],
    )
    expect(Number(res.rows[0].unpaid_days)).toBe(0)
    expect(Number(res.rows[0].advance_days)).toBe(0)
    expect(res.rows[0].saved_days_taken).toEqual({})

    await expect(
      getPool().query(`UPDATE public.employee_vacation_balances SET unpaid_days = -1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.employee_vacation_balances SET advance_days = -1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.employee_vacation_balances SET saved_days_taken = '[]' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('salary_line_items.vacation_category', () => {
  it('accepts every category on a vacation line and NULL everywhere', async () => {
    const s = await seed()
    const { sreId } = await seedRun({ ...s, status: 'draft' })
    for (const category of ['paid', 'extra_paid', 'saved', 'unpaid', 'advance']) {
      await expect(
        insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category, savedYear: null }),
      ).resolves.toBeDefined()
    }
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'bonus', category: null, savedYear: null }),
    ).resolves.toBeDefined()
  })

  it('refuses a category on a non-vacation line and an unknown category', async () => {
    const s = await seed()
    const { sreId } = await seedRun({ ...s, status: 'draft' })
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'bonus', category: 'paid', savedYear: null }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category: 'sparad', savedYear: null }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('ties vacation_saved_year to category saved and a four-digit year', async () => {
    const s = await seed()
    const { sreId } = await seedRun({ ...s, status: 'draft' })
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category: 'saved', savedYear: '2025' }),
    ).resolves.toBeDefined()
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category: 'paid', savedYear: '2025' }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category: null, savedYear: '2025' }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertLine({ companyId: s.companyId, sreId, itemType: 'vacation', category: 'saved', savedYear: '25' }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('both CHECKs are validated (not left NOT VALID)', async () => {
    const res = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT c.conname, c.convalidated
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'salary_line_items'
          AND c.conname IN ('salary_line_items_vacation_category_check', 'salary_line_items_vacation_saved_year_check')
        ORDER BY c.conname`,
    )
    expect(res.rows.map((r) => r.conname)).toEqual([
      'salary_line_items_vacation_category_check',
      'salary_line_items_vacation_saved_year_check',
    ])
    expect(res.rows.every((r) => r.convalidated)).toBe(true)
  })
})
