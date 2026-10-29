/**
 * pg-real tests for 20261030040000_bolaget_owner_tax.sql (and the VALIDATE
 * in 20261030040100): RLS keeps the owner tax tables to their company, a
 * viewer only reads, the owner loan register's shape constraints hold (the
 * account on the right side, a security only given, a related person named,
 * a repayment dated), a loan is never deleted and who registered it never
 * changes, one set of K10 figures per owner and year from 2026, one
 * interest row per loan and year, field 570 is unique per year, the staged
 * owner tax types are accepted, and no owner tax table has a column for a
 * personnummer.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

type Company = { userId: string; companyId: string; fiscalPeriodId: string }

let a: Company
let b: Company

async function party(company: Company, name: string, kind = 'person'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.parties (id, company_id, user_id, display_name, kind, origin) VALUES ($1, $2, $3, $4, $5, 'bolaget')`,
    [id, company.companyId, company.userId, name, kind],
  )
  return id
}

async function loan(company: Company, partyId: string, over: Record<string, unknown> = {}): Promise<string> {
  const row = { direction: 'borrows', account: '2893', principal: 200000, outstanding: 200000, start_date: '2026-03-01', ...over }
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.owner_loans (company_id, party_id, direction, account, principal, outstanding, start_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [company.companyId, partyId, row.direction, row.account, row.principal, row.outstanding, row.start_date, company.userId],
  )
  return res.rows[0]!.id
}

beforeAll(async () => {
  a = await seedCompany()
  b = await seedCompany()
})

describe('owner tax tables: RLS and writer role', () => {
  it('shows a company only its own loans, lets a member write and a viewer only read', async () => {
    const anna = await party(a, 'Anna Lån')
    const id = await loan(a, anna)
    const seenByB = await withUserContext(b.userId, async (client) => (await client.query('SELECT id FROM public.owner_loans WHERE id = $1', [id])).rowCount)
    const seenByA = await withUserContext(a.userId, async (client) => (await client.query('SELECT id FROM public.owner_loans WHERE id = $1', [id])).rowCount)
    expect(seenByB).toBe(0)
    expect(seenByA).toBe(1)

    const insert = `INSERT INTO public.owner_loans (company_id, party_id, direction, account, principal, outstanding, start_date)
                    VALUES ($1, $2, 'borrows', '2893', 1, 1, '2026-01-01')`
    await expect(withUserContext(b.userId, (client) => client.query(insert, [a.companyId, anna]))).rejects.toMatchObject({ code: '42501' })

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })
    await expect(withUserContext(viewerId, (client) => client.query(insert, [a.companyId, anna]))).rejects.toMatchObject({ code: '42501' })
    expect(await withUserContext(viewerId, async (client) => (await client.query('SELECT id FROM public.owner_loans WHERE id = $1', [id])).rowCount)).toBe(1)

    expect(await withUserContext(a.userId, async (client) => (await client.query(insert, [a.companyId, anna])).rowCount)).toBe(1)
  })

  it('keeps the K10 figures, the interest and the KU20 numbers to their company too', async () => {
    const anna = await party(a, 'Anna K10')
    const id = await loan(a, anna)
    await getPool().query(`INSERT INTO public.k10_owner_inputs (company_id, party_id, income_year, saved_dividend_space) VALUES ($1, $2, 2026, 100000)`, [a.companyId, anna])
    await getPool().query(`INSERT INTO public.owner_loan_interest (company_id, owner_loan_id, income_year, interest_amount, tax_withheld) VALUES ($1, $2, 2026, 8000, 2400)`, [a.companyId, id])
    await getPool().query(`INSERT INTO public.ku20_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 1)`, [a.companyId, anna])
    for (const table of ['k10_owner_inputs', 'owner_loan_interest', 'ku20_specification_numbers']) {
      const seen = await withUserContext(b.userId, async (client) => (await client.query(`SELECT 1 FROM public.${table} WHERE company_id = $1`, [a.companyId])).rowCount)
      expect(seen, table).toBe(0)
    }
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })
    await expect(
      withUserContext(viewerId, (client) => client.query(`UPDATE public.k10_owner_inputs SET saved_dividend_space = 1 WHERE party_id = $1`, [anna])),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('owner_loans: shape and history', () => {
  it('refuses an account on the wrong side, a security the company takes, and a related person without the insider', async () => {
    const anna = await party(a, 'Anna Form')
    await expect(loan(a, anna, { direction: 'lends', account: '2893' })).rejects.toMatchObject({ code: '23514' })
    await expect(loan(a, anna, { direction: 'borrows', account: '1685' })).rejects.toMatchObject({ code: '23514' })
    await expect(loan(a, anna, { account: '1930' })).rejects.toMatchObject({ code: '23514' })
    await expect(loan(a, anna, { outstanding: 300000 })).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(
      `INSERT INTO public.owner_loans (company_id, party_id, kind, direction, principal, outstanding, start_date) VALUES ($1, $2, 'security', 'borrows', 1, 1, '2026-01-01')`,
      [a.companyId, anna],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(
      `INSERT INTO public.owner_loans (company_id, party_id, direction, account, relation, principal, outstanding, start_date) VALUES ($1, $2, 'lends', '1685', 'related_person', 1, 1, '2026-01-01')`,
      [a.companyId, anna],
    )).rejects.toMatchObject({ code: '23514' })
    // A security needs no account; a loan does.
    await getPool().query(
      `INSERT INTO public.owner_loans (company_id, party_id, kind, direction, principal, outstanding, start_date) VALUES ($1, $2, 'security', 'lends', 50000, 50000, '2026-01-01')`,
      [a.companyId, anna],
    )
    await expect(loan(a, anna, { account: null })).rejects.toMatchObject({ code: '23514' })
  })

  it('names a party and a related insider of the same company only', async () => {
    const other = await party(b, 'Annan Bolag')
    await expect(loan(a, other)).rejects.toMatchObject({ code: '23503' })
    const anna = await party(a, 'Anna Insider')
    const spouse = await party(a, 'Make Insider')
    await getPool().query(
      `INSERT INTO public.owner_loans (company_id, party_id, direction, account, relation, related_to_party_id, relation_detail, principal, outstanding, start_date)
       VALUES ($1, $2, 'lends', '1685', 'related_person', $3, 'make', 1, 1, '2026-01-01')`,
      [a.companyId, spouse, anna],
    )
    await expect(getPool().query(
      `INSERT INTO public.owner_loans (company_id, party_id, direction, account, relation, related_to_party_id, principal, outstanding, start_date)
       VALUES ($1, $2, 'lends', '1685', 'related_person', $2, 1, 1, '2026-01-01')`,
      [a.companyId, spouse],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('dates a repayment, never deletes a loan and never rewrites who registered it', async () => {
    const anna = await party(a, 'Anna Historik')
    const id = await loan(a, anna)
    await expect(getPool().query(`UPDATE public.owner_loans SET status = 'repaid' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(`UPDATE public.owner_loans SET status = 'repaid', repaid_on = '2026-01-01', outstanding = 0 WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
    await getPool().query(`UPDATE public.owner_loans SET status = 'repaid', repaid_on = '2026-11-30', outstanding = 0 WHERE id = $1`, [id])
    await expect(getPool().query(`DELETE FROM public.owner_loans WHERE id = $1`, [id])).rejects.toThrow(/OWNER_LOAN_APPEND_ONLY/)
    await expect(getPool().query(`UPDATE public.owner_loans SET created_by = NULL WHERE id = $1`, [id])).rejects.toThrow(/OWNER_LOAN_APPEND_ONLY/)
    await expect(getPool().query(`UPDATE public.owner_loans SET company_id = $2 WHERE id = $1`, [id, b.companyId])).rejects.toThrow(/OWNER_LOAN_APPEND_ONLY/)
  })
})

describe('K10 figures, interest and KU20 numbers', () => {
  it('holds one set of K10 figures per owner and year, from 2026, never negative', async () => {
    const anna = await party(b, 'Anna Unik')
    await getPool().query(`INSERT INTO public.k10_owner_inputs (company_id, party_id, income_year) VALUES ($1, $2, 2026)`, [b.companyId, anna])
    await expect(getPool().query(`INSERT INTO public.k10_owner_inputs (company_id, party_id, income_year) VALUES ($1, $2, 2026)`, [b.companyId, anna])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.k10_owner_inputs (company_id, party_id, income_year) VALUES ($1, $2, 2025)`, [b.companyId, anna])).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(`INSERT INTO public.k10_owner_inputs (company_id, party_id, income_year, saved_dividend_space) VALUES ($1, $2, 2027, -1)`, [b.companyId, anna])).rejects.toMatchObject({ code: '23514' })
  })

  it('holds one interest row per loan and year, with tax no larger than the interest, on the loan\'s company', async () => {
    const anna = await party(b, 'Anna Ränta')
    const id = await loan(b, anna)
    await getPool().query(`INSERT INTO public.owner_loan_interest (company_id, owner_loan_id, income_year, interest_amount) VALUES ($1, $2, 2026, 8000)`, [b.companyId, id])
    await expect(getPool().query(`INSERT INTO public.owner_loan_interest (company_id, owner_loan_id, income_year, interest_amount) VALUES ($1, $2, 2026, 1)`, [b.companyId, id])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.owner_loan_interest (company_id, owner_loan_id, income_year, interest_amount, tax_withheld) VALUES ($1, $2, 2025, 100, 200)`, [b.companyId, id])).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(`INSERT INTO public.owner_loan_interest (company_id, owner_loan_id, income_year, interest_amount) VALUES ($1, $2, 2024, 1)`, [a.companyId, id])).rejects.toMatchObject({ code: '23503' })
  })

  it('holds one KU20 specification number per recipient and year, unique per year', async () => {
    const anna = await party(b, 'Anna KU20')
    const bo = await party(b, 'Bo KU20')
    await getPool().query(`INSERT INTO public.ku20_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 1)`, [b.companyId, anna])
    await expect(getPool().query(`INSERT INTO public.ku20_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 1)`, [b.companyId, bo])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.ku20_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 2)`, [b.companyId, anna])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.ku20_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 0)`, [b.companyId, bo])).rejects.toMatchObject({ code: '23514' })
  })

  it('has no column for a personnummer in any owner tax table', async () => {
    const res = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('k10_owner_inputs', 'owner_loans', 'owner_loan_interest', 'ku20_specification_numbers')
          AND (column_name ILIKE '%personnummer%' OR column_name ILIKE '%personal_number%')`,
    )
    expect(res.rows).toEqual([])
  })
})

describe('checks expanded by the migration', () => {
  it('accepts the owner tax pending operation types', async () => {
    for (const type of ['set_k10_owner_inputs', 'create_owner_loan', 'update_owner_loan', 'set_owner_loan_interest']) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, $3, 'test')`, [a.userId, a.companyId, type])
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  })
})
