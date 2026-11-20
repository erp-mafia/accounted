/**
 * pg-real test for vat_eu_trade_fiscal_years (migration 20261114101159):
 * whether each helårsmoms period's books show EU trade, as the nightly
 * deadline job last read them. Members read their company's rows; nobody but
 * the service role writes them; one row per period; the key is YYYY-MM.
 */
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seedCompany() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

const insertRow = (companyId: string, key: string, hasEuTrade = true) =>
  getPool().query(
    'INSERT INTO public.vat_eu_trade_fiscal_years (company_id, fiscal_year_end, has_eu_trade) VALUES ($1, $2, $3)',
    [companyId, key, hasEuTrade],
  )

describe('vat_eu_trade_fiscal_years', () => {
  it('lets a member read the company\'s periods and a stranger none', async () => {
    const member = await seedCompany()
    const stranger = await insertAuthUser()
    await insertRow(member.companyId, '2026-12')

    const seen = await withUserContext(member.userId, (client) =>
      client.query(
        'SELECT fiscal_year_end, has_eu_trade, checked_at IS NOT NULL AS checked FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1',
        [member.companyId],
      ),
    )
    expect(seen.rows).toEqual([{ fiscal_year_end: '2026-12', has_eu_trade: true, checked: true }])

    const hidden = await withUserContext(stranger, (client) =>
      client.query('SELECT fiscal_year_end FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1', [member.companyId]),
    )
    expect(hidden.rows).toEqual([])
  })

  it('refuses every write by a member: only the nightly job writes', async () => {
    const { userId, companyId } = await seedCompany()
    await insertRow(companyId, '2025-12', false)

    for (const statement of [
      "INSERT INTO public.vat_eu_trade_fiscal_years (company_id, fiscal_year_end, has_eu_trade) VALUES ($1, '2026-12', true)",
      'UPDATE public.vat_eu_trade_fiscal_years SET has_eu_trade = true WHERE company_id = $1',
      'DELETE FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1',
    ]) {
      await expect(withUserContext(userId, (client) => client.query(statement, [companyId]))).rejects.toThrow(
        /permission denied/,
      )
    }
    const { rows } = await getPool().query(
      'SELECT fiscal_year_end, has_eu_trade FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1',
      [companyId],
    )
    expect(rows).toEqual([{ fiscal_year_end: '2025-12', has_eu_trade: false }])
  })

  // The two writes recordEuTradeChecks sends (lib/tax/fiscal-year-eu-trade.ts),
  // as PostgREST runs them: a yes is an upsert over anything; a no is an
  // insert that skips an existing row plus an update of rows that say no.
  const writeYes = (companyId: string, key: string) =>
    getPool().query(
      `INSERT INTO public.vat_eu_trade_fiscal_years (company_id, fiscal_year_end, has_eu_trade, checked_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (company_id, fiscal_year_end) DO UPDATE SET has_eu_trade = EXCLUDED.has_eu_trade, checked_at = EXCLUDED.checked_at`,
      [companyId, key],
    )
  const writeNo = async (companyId: string, key: string) => {
    await getPool().query(
      `INSERT INTO public.vat_eu_trade_fiscal_years (company_id, fiscal_year_end, has_eu_trade, checked_at)
       VALUES ($1, $2, false, now()) ON CONFLICT (company_id, fiscal_year_end) DO NOTHING`,
      [companyId, key],
    )
    await getPool().query(
      `UPDATE public.vat_eu_trade_fiscal_years SET checked_at = now()
       WHERE company_id = $1 AND fiscal_year_end = ANY($2) AND has_eu_trade = false`,
      [companyId, [key]],
    )
  }
  const answer = async (companyId: string, key: string) =>
    (
      await getPool().query(
        'SELECT has_eu_trade FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1 AND fiscal_year_end = $2',
        [companyId, key],
      )
    ).rows[0]?.has_eu_trade

  it('turns a no into a yes, and never a yes into a no', async () => {
    const { companyId } = await seedCompany()

    await writeNo(companyId, '2026-12')
    expect(await answer(companyId, '2026-12')).toBe(false)
    await writeYes(companyId, '2026-12')
    expect(await answer(companyId, '2026-12')).toBe(true)
    await writeNo(companyId, '2026-12')
    expect(await answer(companyId, '2026-12')).toBe(true)
  })

  it('keeps one row per period, requires the answer and refuses a key that is not a month', async () => {
    const { companyId } = await seedCompany()
    await insertRow(companyId, '2026-06')

    await expect(insertRow(companyId, '2026-06')).rejects.toThrow(/duplicate key/)
    await expect(
      getPool().query("INSERT INTO public.vat_eu_trade_fiscal_years (company_id, fiscal_year_end) VALUES ($1, '2026-07')", [companyId]),
    ).rejects.toThrow(/null value/)
    await expect(insertRow(companyId, '2026-13')).rejects.toThrow(/check/i)
  })
})
