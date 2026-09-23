import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { STANDARD_VOUCHER_SERIES_MAP } from '@/lib/bookkeeping/voucher-series-resolver'

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
    // The default is a JSONB literal cast: we don't pin the exact whitespace,
    // just verify the migration installed a default that includes the expected
    // source_type keys.
    const defaultValue = result.rows[0]?.column_default ?? ''
    expect(defaultValue).toMatch(/jsonb/)
    expect(defaultValue).toMatch(/manual/)
    expect(defaultValue).toMatch(/supplier_invoice_registered/)
    expect(defaultValue).toMatch(/salary_payment/)
  })

  // Since migration 20260906210500 (#2184) a fresh row starts on the standard
  // set, not on all-A; the exhaustive equality with the TS map and the
  // "existing rows untouched" rule live in
  // tests/pg/voucher-series-standard-default.pg.test.ts. This test keeps the
  // representative letters readable at a glance.
  it('a freshly inserted company_settings row gets the standard series set', async () => {
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
    // A stays the general series; the reskontra, lön and moms flows get their own.
    expect(map.manual).toBe('A')
    expect(map.bank_transaction).toBe('A')
    expect(map.invoice_created).toBe('B')
    expect(map.invoice_paid).toBe('C')
    expect(map.supplier_invoice_registered).toBe('D')
    expect(map.supplier_invoice_paid).toBe('E')
    expect(map.salary_payment).toBe('K')
    expect(map.vat_settlement).toBe('M')
    expect(map).toEqual(STANDARD_VOUCHER_SERIES_MAP)
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

    // An explicit layout of the company's own (Björn Lundén style letters)
    // replaces the default wholesale; nothing merges the standard set back in.
    const updated = {
      manual: 'A',
      supplier_invoice_registered: 'L',
      supplier_invoice_paid: 'U',
      salary_payment: 'N',
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
