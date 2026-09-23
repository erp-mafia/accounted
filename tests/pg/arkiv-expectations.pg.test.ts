import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Arkiv phase 9. A document_expected finding is a finding like the others:
 * one per key, closed with a resolution, and it carries a note that says why
 * a person or an agent closed it. The note is constrained to the three
 * answers the product knows how to remember.
 */
describe('arkiv_findings, document_expected', () => {
  it('accepts the new kind, keeps the note to its three values, and closes with a note', async () => {
    const { companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.arkiv_findings (company_id, kind, key, severity, subject_kind, detail)
       VALUES ($1, 'document_expected', 'document_expected:loan', 'info', 'company', '{"rule": "loan", "expected_type": "agreement.loan"}')
       RETURNING id, status`,
      [companyId],
    )
    expect(rows[0].status).toBe('open')

    await expect(getPool().query(`UPDATE public.arkiv_findings SET resolution_note = 'because' WHERE id = $1`, [rows[0].id])).rejects.toThrow(
      /resolution_note/,
    )

    await getPool().query(
      `UPDATE public.arkiv_findings SET status = 'dismissed', resolution = 'dismissed', resolution_note = 'not_applicable', resolved_at = now() WHERE id = $1`,
      [rows[0].id],
    )
    const after = await getPool().query(`SELECT status, resolution, resolution_note FROM public.arkiv_findings WHERE id = $1`, [rows[0].id])
    expect(after.rows[0]).toEqual({ status: 'dismissed', resolution: 'dismissed', resolution_note: 'not_applicable' })

    await expect(
      getPool().query(`INSERT INTO public.arkiv_findings (company_id, kind, key, severity, subject_kind) VALUES ($1, 'document_wished', 'x', 'info', 'company')`, [companyId]),
    ).rejects.toThrow(/arkiv_findings_kind_check/)
  })
})
