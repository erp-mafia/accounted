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
