import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

async function setTreatment(companyId: string, treatment: string | null) {
  return getPool().query(
    `UPDATE public.chart_of_accounts
     SET default_vat_treatment = $2
     WHERE company_id = $1 AND account_number = '3001'`,
    [companyId, treatment],
  )
}

describe('chart_of_accounts.default_vat_treatment', () => {
  it('accepts every supported treatment and NULL', async () => {
    const { companyId } = await seedCompany()
    const treatments = [
      'standard_25', 'reduced_12', 'reduced_6', 'exempt',
      'reverse_charge_domestic', 'reverse_charge_eu_goods',
      'reverse_charge_eu_services', 'export_goods', 'export_services',
      'vmb', 'rental_voluntary', null,
    ]
    for (const treatment of treatments) {
      await expect(setTreatment(companyId, treatment)).resolves.toBeDefined()
    }
  })

  it('rejects unknown treatments', async () => {
    const { companyId } = await seedCompany()
    await expect(setTreatment(companyId, 'unknown')).rejects.toThrow()
  })
})
