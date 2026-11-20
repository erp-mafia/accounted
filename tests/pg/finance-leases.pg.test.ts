/**
 * pg-real tests for 20261027180107_finance_leases.sql: the opt-in column,
 * the lessee register's RLS (company isolation, a booked lease cannot be
 * deleted) and the one-posting-per-year key.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

let companyA: { userId: string; companyId: string; fiscalPeriodId: string }
let companyB: { userId: string; companyId: string; fiscalPeriodId: string }

async function insertLease(company: { userId: string; companyId: string }, initialEntryId: string | null = null) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.finance_leases
       (id, company_id, user_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year,
        payments_in_advance, annual_rate_percent, useful_life_months, asset_account,
        accumulated_depreciation_account, liability_account, lease_cost_account, initial_entry_id)
     VALUES ($1, $2, $3, 'Grävmaskin', '2026-01-01', 100000, 3000, 36, 12, true, 6, 60,
             '1227', '1229', '2399', '5220', $4)`,
    [id, company.companyId, company.userId, initialEntryId],
  )
  return id
}

beforeAll(async () => {
  companyA = await seedCompany()
  companyB = await seedCompany()
})

describe('finance leases: schema', () => {
  it('adds the opt-in as NOT NULL default false', async () => {
    const res = await getPool().query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'finance_lease_capitalisation'`,
    )
    expect(res.rows).toEqual([{ is_nullable: 'NO', column_default: 'false' }])
  })

  it('refuses impossible terms and a direct cost without its account', async () => {
    await expect(getPool().query(
      `INSERT INTO public.finance_leases
         (company_id, user_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year,
          annual_rate_percent, useful_life_months, asset_account, accumulated_depreciation_account,
          liability_account, lease_cost_account)
       VALUES ($1, $2, 'X', '2026-01-01', 100, 10, 12, 5, 6, 12, '1227', '1229', '2399', '5220')`,
      [companyA.companyId, companyA.userId],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(
      `INSERT INTO public.finance_leases
         (company_id, user_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year,
          annual_rate_percent, useful_life_months, asset_account, accumulated_depreciation_account,
          liability_account, lease_cost_account, direct_costs)
       VALUES ($1, $2, 'X', '2026-01-01', 100, 10, 12, 12, 6, 12, '1227', '1229', '2399', '5220', 500)`,
      [companyA.companyId, companyA.userId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps one posting per company and financial year', async () => {
    await getPool().query(
      `INSERT INTO public.finance_lease_postings (company_id, fiscal_period_id) VALUES ($1, $2)`,
      [companyA.companyId, companyA.fiscalPeriodId],
    )
    await expect(getPool().query(
      `INSERT INTO public.finance_lease_postings (company_id, fiscal_period_id) VALUES ($1, $2)`,
      [companyA.companyId, companyA.fiscalPeriodId],
    )).rejects.toMatchObject({ code: '23505' })
  })
})

describe('finance leases: RLS', () => {
  it('shows a company only its own leases', async () => {
    const leaseId = await insertLease(companyA)
    const seenByB = await withUserContext(companyB.userId, async (client) =>
      (await client.query('SELECT id FROM public.finance_leases WHERE id = $1', [leaseId])).rowCount)
    const seenByA = await withUserContext(companyA.userId, async (client) =>
      (await client.query('SELECT id FROM public.finance_leases WHERE id = $1', [leaseId])).rowCount)
    expect(seenByB).toBe(0)
    expect(seenByA).toBe(1)
  })

  it('deletes an unbooked lease but keeps one whose start is booked', async () => {
    const unbooked = await insertLease(companyA)
    const entryId = await insertPostedJournalEntry({
      userId: companyA.userId,
      companyId: companyA.companyId,
      fiscalPeriodId: companyA.fiscalPeriodId,
    })
    const booked = await insertLease(companyA, entryId)
    const deleted = await withUserContext(companyA.userId, async (client) =>
      (await client.query('DELETE FROM public.finance_leases WHERE id = ANY($1::uuid[])', [[unbooked, booked]])).rowCount)
    expect(deleted).toBe(1)
    const left = await getPool().query('SELECT id FROM public.finance_leases WHERE id = $1', [booked])
    expect(left.rowCount).toBe(1)
  })

  it('lets a viewer read the register but not write it', async () => {
    const leaseId = await insertLease(companyA)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: companyA.companyId, userId: viewerId, role: 'viewer' })
    const seen = await withUserContext(viewerId, async (client) =>
      (await client.query('SELECT id FROM public.finance_leases WHERE id = $1', [leaseId])).rowCount)
    expect(seen).toBe(1)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.finance_leases
         (company_id, user_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year,
          payments_in_advance, annual_rate_percent, useful_life_months, asset_account,
          accumulated_depreciation_account, liability_account, lease_cost_account)
       VALUES ($1, $2, 'Bil', '2026-01-01', 100000, 3000, 36, 12, true, 6, 60, '1227', '1229', '2399', '5220')`,
      [companyA.companyId, viewerId],
    ))).rejects.toMatchObject({ code: '42501' })
    await expect(withUserContext(viewerId, (client) =>
      client.query(`UPDATE public.finance_leases SET name = 'Ändrad' WHERE id = $1`, [leaseId]),
    )).rejects.toMatchObject({ code: '42501' })
    const deleted = await withUserContext(viewerId, async (client) =>
      (await client.query('DELETE FROM public.finance_leases WHERE id = $1', [leaseId])).rowCount)
    expect(deleted).toBe(0)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.finance_lease_postings (company_id, fiscal_period_id) VALUES ($1, $2)`,
      [companyA.companyId, companyA.fiscalPeriodId],
    ))).rejects.toMatchObject({ code: '42501' })
  })
})
