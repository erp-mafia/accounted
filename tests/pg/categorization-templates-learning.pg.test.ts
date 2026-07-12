import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Covers 20260711100000_categorization_templates_learning_fix:
 *
 * The multi-tenant refactor (20260330130000) re-scoped this table to
 * company_id and the insert path (lib/bookkeeping/counterparty-templates.ts
 * insertOrUpdateTemplate) stopped writing user_id, but the column kept its
 * NOT NULL. Every template insert failed silently for months; the unit tests
 * stayed green because they mock Supabase. This test locks the real schema
 * contract: the EXACT column set the lib writes must insert cleanly.
 */

const LIB_INSERT_COLUMNS = `
  company_id, counterparty_name, counterparty_aliases,
  debit_account, credit_account, vat_treatment, vat_account,
  category, line_pattern, occurrence_count, confidence,
  last_seen_date, source`

async function insertTemplate(companyId: string, counterpartyName: string) {
  return getPool().query(
    `INSERT INTO public.categorization_templates (${LIB_INSERT_COLUMNS})
     VALUES ($1, $2, ARRAY['telia sverige ab'], '6200', '1930',
             'standard_25', '2641', NULL, NULL, 1, 0.45, '2026-06-15', 'user_approved')
     RETURNING id, company_id, user_id, is_active`,
    [companyId, counterpartyName],
  )
}

describe('categorization_templates: learning write contract', () => {
  it('accepts the exact column set the lib writes (no user_id)', async () => {
    const { companyId } = await seedCompany()

    const { rows } = await insertTemplate(companyId, `telia-${randomUUID()}`)

    expect(rows).toHaveLength(1)
    expect(rows[0].company_id).toBe(companyId)
    expect(rows[0].user_id).toBeNull()
    expect(rows[0].is_active).toBe(true)
  })

  it('enforces one template per (company_id, counterparty_name)', async () => {
    const { companyId } = await seedCompany()
    const name = `telia-${randomUUID()}`

    await insertTemplate(companyId, name)
    await expect(insertTemplate(companyId, name)).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('allows the same counterparty_name in different companies', async () => {
    const { companyId: companyA } = await seedCompany()
    const { companyId: companyB } = await seedCompany()
    const name = `telia-${randomUUID()}`

    await insertTemplate(companyA, name)
    const { rows } = await insertTemplate(companyB, name)
    expect(rows).toHaveLength(1)
  })

  it('still rejects a company_id that is not a real company (FK intact)', async () => {
    await expect(insertTemplate(randomUUID(), `ghost-${randomUUID()}`)).rejects.toMatchObject({
      code: '23503',
    })
  })
})
