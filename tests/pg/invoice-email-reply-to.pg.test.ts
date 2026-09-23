import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for migration 20260914110000: the invoice_email_reply_to
// column and its format CHECK on company_settings.

describe('company_settings.invoice_email_reply_to', () => {
  it('accepts null and a plain address', async () => {
    const { companyId, userId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, invoice_email_reply_to) VALUES ($1, $2, NULL)`,
      [userId, companyId],
    )
    await getPool().query(
      `UPDATE public.company_settings SET invoice_email_reply_to = 'faktura@example.test' WHERE company_id = $1`,
      [companyId],
    )
    const { rows } = await getPool().query(
      `SELECT invoice_email_reply_to FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0].invoice_email_reply_to).toBe('faktura@example.test')
  })

  it('rejects a value that is not an email address', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.company_settings (user_id, company_id, invoice_email_reply_to) VALUES ($1, $2, 'svara till mig')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/company_settings_invoice_email_reply_to_format/)
  })
})
