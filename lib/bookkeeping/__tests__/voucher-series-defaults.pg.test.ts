import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

describe('company_settings.default_voucher_series_per_source_type', () => {
  it('column exists with the expected default JSONB shape', async () => {
    const result = await getPool().query<{ column_default: string | null }>(
      `SELECT column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'company_settings'
         AND column_name = 'default_voucher_series_per_source_type'`,
    )

    expect(result.rows).toHaveLength(1)
    // The default is a JSONB literal cast — we don't pin the exact whitespace,
    // just verify the migration installed a default that includes the expected
    // source_type keys.
    const defaultValue = result.rows[0]?.column_default ?? ''
    expect(defaultValue).toMatch(/jsonb/)
    expect(defaultValue).toMatch(/manual/)
    expect(defaultValue).toMatch(/supplier_invoice_registered/)
    expect(defaultValue).toMatch(/salary_payment/)
  })

  it('a freshly inserted company_settings row gets all-A defaults', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    // upsert in case a trigger has already created the row.
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id)
       VALUES ($1, $2)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )

    const { rows } = await getPool().query<{
      default_voucher_series_per_source_type: Record<string, string>
    }>(
      `SELECT default_voucher_series_per_source_type
       FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )

    expect(rows).toHaveLength(1)
    const map = rows[0]!.default_voucher_series_per_source_type
    expect(map).toBeDefined()
    expect(map.manual).toBe('A')
    expect(map.supplier_invoice_registered).toBe('A')
    expect(map.salary_payment).toBe('A')
    expect(map.bank_transaction).toBe('A')
  })

  it('accepts user updates to per-source-type series mapping', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id)
       VALUES ($1, $2)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )

    // Configure per common Swedish convention: B for supplier, C for salary.
    const updated = {
      manual: 'A',
      supplier_invoice_registered: 'B',
      supplier_invoice_paid: 'B',
      salary_payment: 'C',
    }
    await getPool().query(
      `UPDATE public.company_settings
         SET default_voucher_series_per_source_type = $1::jsonb
       WHERE company_id = $2`,
      [JSON.stringify(updated), companyId],
    )

    const { rows } = await getPool().query<{
      default_voucher_series_per_source_type: Record<string, string>
    }>(
      `SELECT default_voucher_series_per_source_type
       FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )

    expect(rows[0]!.default_voucher_series_per_source_type).toEqual(updated)
  })
})
