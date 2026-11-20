/**
 * pg-real tests for 20261030020000_bolaget_capital.sql (and the VALIDATE in
 * 20261030020100): RLS keeps the capital registers to their company, a
 * viewer only reads, a booked dividend keeps its figures and its split per
 * holder, the status only moves forward (a booking's claim is released
 * only while no verifikat is written), nothing is deleted, booked
 * tillskott and registered capital changes are frozen, field 570 is unique
 * per year, the staged capital types are accepted, and no capital table
 * has a column for a personnummer.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

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

async function dividend(company: Company, status = 'decided'): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.dividends
       (company_id, decided_on, decided_by, total_amount, amount_per_share, record_date, record_date_basis, payment_date, created_by)
     VALUES ($1, '2026-05-01', 'arsstamma', 100000, 100, '2026-05-01', 'decision_date', '2026-05-15', $2)
     RETURNING id`,
    [company.companyId, company.userId],
  )
  const id = res.rows[0]!.id
  if (status !== 'decided') {
    await getPool().query(`UPDATE public.dividends SET status = $2, paid_on = CASE WHEN $2 = 'paid' THEN '2026-05-15'::date END WHERE id = $1`, [id, status])
  }
  return id
}

async function distribution(company: Company, dividendId: string, partyId: string, amount = 100000) {
  return getPool().query(
    `INSERT INTO public.dividend_distributions (company_id, dividend_id, party_id, share_count, amount) VALUES ($1, $2, $3, 1000, $4)`,
    [company.companyId, dividendId, partyId, amount],
  )
}

beforeAll(async () => {
  a = await seedCompany()
  b = await seedCompany()
})

describe('dividends: RLS and writer role', () => {
  it('shows a company only its own dividends, lets a member write and a viewer only read', async () => {
    const id = await dividend(a)
    const seenByB = await withUserContext(b.userId, async (client) => (await client.query('SELECT id FROM public.dividends WHERE id = $1', [id])).rowCount)
    const seenByA = await withUserContext(a.userId, async (client) => (await client.query('SELECT id FROM public.dividends WHERE id = $1', [id])).rowCount)
    expect(seenByB).toBe(0)
    expect(seenByA).toBe(1)

    const insert = `INSERT INTO public.dividends (company_id, decided_on, decided_by, total_amount, record_date, record_date_basis, payment_date)
                    VALUES ($1, '2026-05-01', 'arsstamma', 1, '2026-05-01', 'decision_date', '2026-05-01')`
    await expect(withUserContext(b.userId, (client) => client.query(insert, [a.companyId]))).rejects.toMatchObject({ code: '42501' })

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })
    await expect(withUserContext(viewerId, (client) => client.query(insert, [a.companyId]))).rejects.toMatchObject({ code: '42501' })
    expect(await withUserContext(viewerId, async (client) => (await client.query('SELECT id FROM public.dividends WHERE id = $1', [id])).rowCount)).toBe(1)

    expect(await withUserContext(a.userId, async (client) => (await client.query(insert, [a.companyId])).rowCount)).toBe(1)
  })

  it('keeps the other capital registers to their company too', async () => {
    const holder = await party(a, 'Tillskott Person')
    await getPool().query(
      `INSERT INTO public.shareholder_contributions (company_id, party_id, kind, promised_on, amount, conditional) VALUES ($1, $2, 'contribution', '2026-03-01', 500, true)`,
      [a.companyId, holder],
    )
    await getPool().query(
      `INSERT INTO public.capital_changes (company_id, kind, decided_on, decided_by, share_count, share_capital_amount, purpose, target_account)
       VALUES ($1, 'minskning', '2026-06-01', 'extra_stamma', 10, 250, 'fri_fond', '2091')`,
      [a.companyId],
    )
    await getPool().query(`INSERT INTO public.ku31_filings (company_id, income_year, famansforetag) VALUES ($1, 2026, true)`, [a.companyId])
    for (const table of ['shareholder_contributions', 'capital_changes', 'ku31_filings']) {
      const seen = await withUserContext(b.userId, async (client) => (await client.query(`SELECT 1 FROM public.${table} WHERE company_id = $1`, [a.companyId])).rowCount)
      expect(seen, table).toBe(0)
    }
  })
})

describe('dividends: frozen once booked', () => {
  it('lets the split change while decided, and freezes figures and split once booked', async () => {
    const id = await dividend(a)
    const anna = await party(a, 'Anna Utdelning')
    const bo = await party(a, 'Bo Utdelning')
    await distribution(a, id, anna, 60000)
    await distribution(a, id, bo, 40000)
    // While decided: the split is refreshed by delete and insert.
    await getPool().query(`DELETE FROM public.dividend_distributions WHERE dividend_id = $1 AND party_id = $2`, [id, bo])
    await distribution(a, id, bo, 40000)

    await getPool().query(`UPDATE public.dividends SET status = 'booked', source_account = '2098' WHERE id = $1`, [id])
    await expect(getPool().query(`UPDATE public.dividends SET total_amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    await expect(getPool().query(`UPDATE public.dividends SET record_date = '2026-05-02' WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    await expect(getPool().query(`UPDATE public.dividend_distributions SET amount = 1 WHERE dividend_id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    await expect(getPool().query(`DELETE FROM public.dividend_distributions WHERE dividend_id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    const carl = await party(a, 'Carl Utdelning')
    await expect(distribution(a, id, carl, 1)).rejects.toThrow(/DIVIDEND_FROZEN/)

    // Paying is the one change left; once the payout verifikat is written nothing moves.
    const c = await seedCompany()
    const payout = await insertPostedJournalEntry({ userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, voucherNumber: 1 })
    await getPool().query(`UPDATE public.dividends SET status = 'paid', paid_on = '2026-05-15', payout_entry_id = $2 WHERE id = $1`, [id, payout])
    await expect(getPool().query(`UPDATE public.dividends SET status = 'booked' WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_STATUS_INVALID/)
    await expect(getPool().query(`UPDATE public.dividends SET paid_on = '2026-05-16' WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    await expect(getPool().query(`UPDATE public.dividends SET payout_entry_id = NULL WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
  })

  it('lets a booking claim be released while no verifikat is written, never after', async () => {
    const c = await seedCompany()
    const id = await dividend(c)
    // Claimed, the posting failed: back to decided.
    await getPool().query(`UPDATE public.dividends SET status = 'booked', source_account = '2098' WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.dividends SET status = 'decided' WHERE id = $1`, [id])
    // Claimed and posted: the verifikat id is written once and the claim stays.
    const entry = await insertPostedJournalEntry({ userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, voucherNumber: 1 })
    await getPool().query(`UPDATE public.dividends SET status = 'booked', source_account = '2098' WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.dividends SET decision_entry_id = $2 WHERE id = $1`, [id, entry])
    await expect(getPool().query(`UPDATE public.dividends SET status = 'decided' WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_STATUS_INVALID/)
    await expect(getPool().query(`UPDATE public.dividends SET decision_entry_id = NULL WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_FROZEN/)
    // The payout claim works the same way.
    await getPool().query(`UPDATE public.dividends SET status = 'paid', paid_on = '2026-05-15' WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.dividends SET status = 'booked', paid_on = NULL WHERE id = $1`, [id])
  })

  it('never deletes a dividend; a decided one is cancelled', async () => {
    const id = await dividend(a)
    await expect(getPool().query(`DELETE FROM public.dividends WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_APPEND_ONLY/)
    await getPool().query(`UPDATE public.dividends SET status = 'cancelled' WHERE id = $1`, [id])
    await expect(getPool().query(`UPDATE public.dividends SET status = 'decided' WHERE id = $1`, [id])).rejects.toThrow(/DIVIDEND_STATUS_INVALID/)
  })

  it('refuses a payment day before the decision and a dividend not decided by a stämma', async () => {
    await expect(getPool().query(
      `INSERT INTO public.dividends (company_id, decided_on, decided_by, total_amount, record_date, record_date_basis, payment_date)
       VALUES ($1, '2026-05-01', 'arsstamma', 1, '2026-05-01', 'decision_date', '2026-04-30')`,
      [a.companyId],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(
      `INSERT INTO public.dividends (company_id, decided_on, decided_by, total_amount, record_date, record_date_basis, payment_date, status)
       VALUES ($1, '2026-05-01', 'styrelse', 1, '2026-05-01', 'decision_date', '2026-05-01', 'decided')`,
      [a.companyId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a split row on its dividend\'s company and one row per holder', async () => {
    const id = await dividend(a)
    const anna = await party(a, 'Anna Dubbel')
    await distribution(a, id, anna)
    await expect(distribution(a, id, anna)).rejects.toMatchObject({ code: '23505' })
    const other = await party(b, 'Annan Bolag')
    await expect(distribution(b, id, other)).rejects.toMatchObject({ code: '23503' })
  })
})

describe('tillskott and capital changes: frozen once booked', () => {
  it('keeps a booked tillskott as booked and never deletes it', async () => {
    const holder = await party(a, 'Frusen Tillskott')
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO public.shareholder_contributions (company_id, party_id, kind, promised_on, amount, conditional, status) VALUES ($1, $2, 'contribution', '2026-03-01', 500, false, 'booked') RETURNING id`,
      [a.companyId, holder],
    )
    const id = res.rows[0]!.id
    await expect(getPool().query(`UPDATE public.shareholder_contributions SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/CONTRIBUTION_FROZEN/)
    await expect(getPool().query(`DELETE FROM public.shareholder_contributions WHERE id = $1`, [id])).rejects.toThrow(/CONTRIBUTION_APPEND_ONLY/)
    await getPool().query(`UPDATE public.shareholder_contributions SET note = 'Avtal i arkivet' WHERE id = $1`, [id])
    await expect(getPool().query(
      `INSERT INTO public.shareholder_contributions (company_id, party_id, kind, promised_on, amount, conditional, counter_account) VALUES ($1, $2, 'contribution', '2026-03-01', 1, false, '2893')`,
      [a.companyId, holder],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a registered capital change as registered and its figures once money is booked', async () => {
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO public.capital_changes (company_id, kind, decided_on, decided_by, share_count, share_capital_amount, price_per_share, premium_amount)
       VALUES ($1, 'nyemission', '2026-09-01', 'extra_stamma', 100, 2500, 1000, 97500) RETURNING id`,
      [a.companyId],
    )
    const id = res.rows[0]!.id
    await getPool().query(`UPDATE public.capital_changes SET status = 'registered', registered_on = '2026-10-01' WHERE id = $1`, [id])
    await expect(getPool().query(`UPDATE public.capital_changes SET share_capital_amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/CAPITAL_CHANGE_FROZEN/)
    await expect(getPool().query(`UPDATE public.capital_changes SET status = 'cancelled' WHERE id = $1`, [id])).rejects.toThrow(/CAPITAL_CHANGE_FROZEN/)
    await expect(getPool().query(`DELETE FROM public.capital_changes WHERE id = $1`, [id])).rejects.toThrow(/CAPITAL_CHANGE_APPEND_ONLY/)
    await expect(getPool().query(
      `INSERT INTO public.capital_changes (company_id, kind, decided_on, decided_by, share_count, share_capital_amount) VALUES ($1, 'fondemission', '2026-09-01', 'arsstamma', 0, 100)`,
      [a.companyId],
    )).rejects.toMatchObject({ code: '23514' })
  })
})

describe('KU31', () => {
  it('holds one answer per year and one specification number per recipient and year', async () => {
    await expect(getPool().query(`INSERT INTO public.ku31_filings (company_id, income_year) VALUES ($1, 2026)`, [a.companyId])).rejects.toMatchObject({ code: '23505' })
    const anna = await party(b, 'Anna KU')
    const bo = await party(b, 'Bo KU')
    await getPool().query(`INSERT INTO public.ku31_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 1)`, [b.companyId, anna])
    await expect(getPool().query(`INSERT INTO public.ku31_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 1)`, [b.companyId, bo])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.ku31_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 2)`, [b.companyId, anna])).rejects.toMatchObject({ code: '23505' })
    await expect(getPool().query(`INSERT INTO public.ku31_specification_numbers (company_id, income_year, party_id, specification_number) VALUES ($1, 2026, $2, 0)`, [b.companyId, bo])).rejects.toMatchObject({ code: '23514' })
  })

  it('has no column for a personnummer in any capital table', async () => {
    const res = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('dividends', 'dividend_distributions', 'ku31_filings', 'ku31_specification_numbers', 'shareholder_contributions', 'capital_changes')
          AND (column_name ILIKE '%personnummer%' OR column_name ILIKE '%personal_number%')`,
    )
    expect(res.rows).toEqual([])
  })
})

describe('checks expanded by the migration', () => {
  it('accepts the capital pending operation types', async () => {
    for (const type of ['create_dividend', 'book_dividend', 'pay_dividend', 'create_shareholder_contribution', 'create_capital_change', 'book_capital_change']) {
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
