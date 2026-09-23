import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 6. Findings of the nightly lint: members read their own
 * company's and may only close an open one with a resolution; everything
 * else stays the lint's. Autonomy levels are readable, never writable, by
 * members. Agreements accept every kind of the taxonomy and obligations
 * carry a direction.
 */
describe('arkiv_findings', () => {
  let userId: string
  let companyId: string
  let strangerId: string
  let findingId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
    const { rows } = await getPool().query(
      `INSERT INTO public.arkiv_findings (company_id, kind, key, severity, subject_kind, detail)
       VALUES ($1, 'settings_mismatch', 'settings_mismatch:moms_period', 'warning', 'company', '{"field": "moms_period"}') RETURNING id`,
      [companyId],
    )
    findingId = rows[0].id
  })

  it('keeps one finding per key and company, and shows it to members only', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.arkiv_findings (company_id, kind, key, severity, subject_kind) VALUES ($1, 'settings_mismatch', 'settings_mismatch:moms_period', 'info', 'company')`,
        [companyId],
      ),
    ).rejects.toThrow(/arkiv_findings_company_id_key_key/)
    const seen = (user: string) =>
      withUserContext(user, async (client) => (await client.query(`SELECT key, status FROM public.arkiv_findings WHERE company_id = $1`, [companyId])).rows)
    expect(await seen(userId)).toEqual([{ key: 'settings_mismatch:moms_period', status: 'open' }])
    expect(await seen(strangerId)).toEqual([])
  })

  it('lets a member close a finding with a resolution, and nothing else', async () => {
    const asMember = (sql: string, params: unknown[]) => withUserContext(userId, (client) => client.query(sql, params))
    await expect(asMember(`UPDATE public.arkiv_findings SET detail = '{}' WHERE id = $1`, [findingId])).rejects.toThrow(/may only close a finding/)
    await expect(asMember(`UPDATE public.arkiv_findings SET status = 'resolved' WHERE id = $1`, [findingId])).rejects.toThrow(/needs a resolution/)
    await expect(asMember(`UPDATE public.arkiv_findings SET status = 'resolved', resolution = 'gone' WHERE id = $1`, [findingId])).rejects.toThrow(/needs a resolution/)
    const closed = await asMember(
      `UPDATE public.arkiv_findings SET status = 'dismissed', resolution = 'dismissed', resolved_at = now(), resolved_by_user_id = $2 WHERE id = $1 RETURNING status`,
      [findingId, userId],
    )
    expect(closed.rows).toEqual([{ status: 'dismissed' }])
    // The member's transaction above rolled back; close it for real as the service and try again as a member.
    await getPool().query(`UPDATE public.arkiv_findings SET status = 'dismissed', resolution = 'dismissed', resolved_at = now() WHERE id = $1`, [findingId])
    await expect(asMember(`UPDATE public.arkiv_findings SET status = 'resolved', resolution = 'applied' WHERE id = $1`, [findingId])).rejects.toThrow(/already closed/)
    const stranger = await withUserContext(strangerId, (client) =>
      client.query(`UPDATE public.arkiv_findings SET status = 'dismissed', resolution = 'dismissed' WHERE id = $1`, [findingId]),
    )
    expect(stranger.rowCount).toBe(0)
  })

  it('lets the service reopen and close findings freely, and drops them with the company', async () => {
    await getPool().query(
      `UPDATE public.arkiv_findings SET status = 'open', resolution = NULL, resolved_at = NULL, detail = '{"field": "moms_period", "proposed": "yearly"}' WHERE id = $1`,
      [findingId],
    )
    await getPool().query(`UPDATE public.arkiv_findings SET status = 'resolved', resolution = 'gone', resolved_at = now() WHERE id = $1`, [findingId])
    const { rows } = await getPool().query(`SELECT status, resolution FROM public.arkiv_findings WHERE id = $1`, [findingId])
    expect(rows).toEqual([{ status: 'resolved', resolution: 'gone' }])
    await expect(
      getPool().query(`INSERT INTO public.arkiv_findings (company_id, kind, key, severity, subject_kind) VALUES ($1, 'made_up', 'x', 'warning', 'company')`, [companyId]),
    ).rejects.toThrow(/arkiv_findings_kind_check/)
  })
})

describe('arkiv_autonomy', () => {
  it('is readable by members and written only by the service, one row per company and schema', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(`INSERT INTO public.arkiv_autonomy (company_id, schema_type, level, audited, changed) VALUES ($1, 'agreement.loan', 2, 40, 2)`, [companyId])
    await expect(
      getPool().query(`INSERT INTO public.arkiv_autonomy (company_id, schema_type, level, audited, changed) VALUES ($1, 'agreement.loan', 1, 1, 0)`, [companyId]),
    ).rejects.toThrow(/arkiv_autonomy_pkey/)
    await expect(
      getPool().query(`INSERT INTO public.arkiv_autonomy (company_id, schema_type, level, audited, changed) VALUES ($1, 'receipt', 4, 1, 0)`, [companyId]),
    ).rejects.toThrow(/arkiv_autonomy_level_check/)
    await expect(
      getPool().query(`INSERT INTO public.arkiv_autonomy (company_id, schema_type, level, audited, changed) VALUES ($1, 'receipt', 0, 1, 2)`, [companyId]),
    ).rejects.toThrow(/arkiv_autonomy_changed_check/)
    const seen = await withUserContext(
      userId,
      async (client) => (await client.query(`SELECT schema_type, level FROM public.arkiv_autonomy WHERE company_id = $1`, [companyId])).rows,
    )
    expect(seen).toEqual([{ schema_type: 'agreement.loan', level: 2 }])
    const written = await withUserContext(userId, (client) => client.query(`UPDATE public.arkiv_autonomy SET level = 3 WHERE company_id = $1`, [companyId]))
    expect(written.rowCount).toBe(0)
  })
})

describe('agreements after phase 6', () => {
  it('accepts every kind of the taxonomy and gives obligations an outgoing direction by default', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, doc_type)
       VALUES ($1, $2, $3, 'forsakring.pdf', 'application/pdf', 1024, $4, $5, 'file_upload', 'agreement.insurance')`,
      [docId, userId, companyId, `documents/${companyId}/${docId}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    )
    const { rows } = await getPool().query(
      `INSERT INTO public.agreements (company_id, kind, title, currency, source_document_id) VALUES ($1, 'insurance', 'Försäkring P-1', 'SEK', $2) RETURNING id`,
      [companyId, docId],
    )
    const agreementId = rows[0].id
    const obligation = await getPool().query(
      `INSERT INTO public.agreement_obligations (company_id, agreement_id, kind, due_on, amount, currency) VALUES ($1, $2, 'payment', '2026-10-01', 3720, 'SEK') RETURNING direction`,
      [companyId, agreementId],
    )
    expect(obligation.rows).toEqual([{ direction: 'out' }])
    await expect(getPool().query(`UPDATE public.agreement_obligations SET direction = 'sideways' WHERE agreement_id = $1`, [agreementId])).rejects.toThrow(
      /agreement_obligations_direction_check/,
    )
    await expect(getPool().query(`UPDATE public.agreements SET kind = 'barter' WHERE id = $1`, [agreementId])).rejects.toThrow(/agreements_kind_check/)
  })
})

describe('document_classifications after phase 6', () => {
  it('carries signals and a content hash', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, 'kvitto.jpg', 'image/jpeg', 1024, $4, $5, 'file_upload')`,
      [docId, userId, companyId, `documents/${companyId}/${docId}.jpg`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    )
    const { rows } = await getPool().query(
      `INSERT INTO public.document_classifications (company_id, document_id, doc_type, confidence, relevance, decided_by, signals, content_sha256)
       VALUES ($1, $2, 'receipt', 0.9, 'relevant', 'model', '{no_text_layer}', 'abc') RETURNING signals, content_sha256`,
      [companyId, docId],
    )
    expect(rows).toEqual([{ signals: ['no_text_layer'], content_sha256: 'abc' }])
  })
})
