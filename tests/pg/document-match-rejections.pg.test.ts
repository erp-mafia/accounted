import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertTransaction } from './fixtures'

/**
 * Migration 20260908090000: document_match_rejections and match_shadow_log.
 *
 * Both are company-scoped through user_company_ids(). A rejection is
 * append-only (no update or delete, enforced by audit_log_immutable), and the
 * same pair cannot be recorded twice for one company.
 */
async function insertDocument(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, $4, 'kvitto.pdf', $5)`,
    [id, userId, companyId, `test/${id}.pdf`, id.replace(/-/g, '')],
  )
  return id
}

describe('document_match_rejections (pg)', () => {
  it('is visible to the company and invisible to a stranger', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument(companyId, userId)
    const txId = await insertTransaction({ companyId, userId, amount: -120 })
    await getPool().query(
      `INSERT INTO public.document_match_rejections (company_id, user_id, document_id, transaction_id, source)
       VALUES ($1, $2, $3, $4, 'unmatch')`,
      [companyId, userId, docId, txId],
    )

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT count(*)::int AS n FROM public.document_match_rejections WHERE company_id = $1`, [companyId]),
    )
    expect(own.rows[0].n).toBe(1)

    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, (client) =>
      client.query(`SELECT count(*)::int AS n FROM public.document_match_rejections WHERE company_id = $1`, [companyId]),
    )
    expect(other.rows[0].n).toBe(0)
  })

  it('refuses a duplicate pair and any update or delete', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument(companyId, userId)
    const txId = await insertTransaction({ companyId, userId, amount: -120 })
    const insert = `INSERT INTO public.document_match_rejections (company_id, user_id, document_id, transaction_id, source)
                    VALUES ($1, $2, $3, $4, 'unmatch')`
    await getPool().query(insert, [companyId, userId, docId, txId])
    await expect(getPool().query(insert, [companyId, userId, docId, txId])).rejects.toThrow(/duplicate key/)
    await expect(
      getPool().query(`UPDATE public.document_match_rejections SET source = 'picker' WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow()
    await expect(
      getPool().query(`DELETE FROM public.document_match_rejections WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow()
  })
})

describe('match_shadow_log (pg)', () => {
  it('accepts a decision row without a user and scopes it to the company', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument(companyId, userId)
    const txId = await insertTransaction({ companyId, userId, amount: -120 })
    await getPool().query(
      `INSERT INTO public.match_shadow_log
         (company_id, user_id, run_id, trigger, document_id, transaction_id, confidence, components, decision, decided_by, reason, acted)
       VALUES ($1, NULL, 'run-1', 'cron', $2, $3, 0.91, '{"match_reasons":["Exakt belopp"]}', 'propose', 'autonomy', 'not_earned', true)`,
      [companyId, docId, txId],
    )

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT decision, human_outcome FROM public.match_shadow_log WHERE company_id = $1`, [companyId]),
    )
    expect(own.rows).toHaveLength(1)
    expect(own.rows[0].decision).toBe('propose')
    expect(own.rows[0].human_outcome).toBeNull()

    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, (client) =>
      client.query(`SELECT count(*)::int AS n FROM public.match_shadow_log WHERE company_id = $1`, [companyId]),
    )
    expect(other.rows[0].n).toBe(0)
  })

  it('rejects a decision or outcome outside the vocabulary', async () => {
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.match_shadow_log (company_id, run_id, trigger, decision, decided_by)
         VALUES ($1, 'run-2', 'cron', 'guess', 'matcher')`,
        [companyId],
      ),
    ).rejects.toThrow(/check constraint/)
  })
})
