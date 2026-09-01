import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * invoice_inbox_items.kind_hint (migration 20260901210000, issue #2129).
 *
 * The plus-address tag on the shared inbox address (+lev / +ver) lands here
 * as the sender's declared document kind. These tests pin the two accepted
 * values, that the CHECK refuses anything else, and that the column is
 * nullable with a NULL default so untagged mail and pre-migration rows are
 * untouched.
 */
describe('invoice_inbox_items.kind_hint (pg)', () => {
  it.each(['supplier_invoice', 'receipt'])('accepts %s', async (hint) => {
    const { userId, companyId } = await seedCompany()

    const { rows } = await getPool().query<{ kind_hint: string }>(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, kind_hint)
       VALUES ($1, $2, 'email', $3)
       RETURNING kind_hint`,
      [companyId, userId, hint],
    )
    expect(rows[0].kind_hint).toBe(hint)
  })

  it('refuses a hint outside the two documented tags', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, kind_hint)
         VALUES ($1, $2, 'email', 'government_letter')`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_kind_hint_check|violates check constraint/i)
  })

  it('defaults to NULL when the writer says nothing', async () => {
    const { userId, companyId } = await seedCompany()

    const { rows } = await getPool().query<{ kind_hint: string | null }>(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, source)
       VALUES ($1, $2, 'upload')
       RETURNING kind_hint`,
      [companyId, userId],
    )
    expect(rows[0].kind_hint).toBeNull()
  })
})
