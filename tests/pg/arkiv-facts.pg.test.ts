import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 5: company_facts is bitemporal and append-only. The guard
 * allows closing, deprecating, confirming and adding evidence, nothing else;
 * one live confirmed value per single-valued predicate and validity window;
 * record_company_fact supersedes or appends evidence; revert_company_fact
 * deprecates and reinstates; members read, only the service writes; the
 * proposal operation type exists.
 */
type Fact = { id: string; value_text: string; sys_to: string | null; rank: string; supersedes_id: string | null; sources: unknown[]; status: string }

async function record(companyId: string, predicate: string, value: string, opts: { validFrom?: string | null; validTo?: string | null; evidence?: Record<string, unknown> | null; source?: string; approvedBy?: string | null } = {}): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT public.record_company_fact($1, 'company', $1, $2, to_jsonb($3::text), $3, true, $4, $5, $6, NULL, NULL, $7, 1, NULL, NULL, $8) AS id`,
    [companyId, predicate, value, opts.validFrom ?? null, opts.validTo ?? null, opts.source ?? 'person', opts.evidence ? JSON.stringify(opts.evidence) : null, opts.approvedBy ?? null],
  )
  return rows[0].id
}

async function fact(id: string): Promise<Fact> {
  const { rows } = await getPool().query(`SELECT id, value_text, sys_to, rank, supersedes_id, sources, status FROM public.company_facts WHERE id = $1`, [id])
  return rows[0]
}

describe('company_facts', () => {
  let userId: string
  let companyId: string
  let strangerId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
  })

  it('records a fact, supersedes it with a new value, and only adds evidence for the same value', async () => {
    const first = await record(companyId, 'vat_period', 'helt beskattningsår', { evidence: { document_id: 'doc-1', page: 1 } })
    const same = await record(companyId, 'vat_period', 'helt beskattningsår', { evidence: { document_id: 'doc-2', page: 3 } })
    expect(same).toBe(first)
    expect((await fact(first)).sources).toHaveLength(2)
    const second = await record(companyId, 'vat_period', 'kvartal')
    expect(second).not.toBe(first)
    expect(await fact(first)).toMatchObject({ sys_to: expect.any(Date), rank: 'normal' })
    expect(await fact(second)).toMatchObject({ sys_to: null, supersedes_id: first, value_text: 'kvartal' })
  })

  it('keeps one live confirmed value per single-valued predicate and window', async () => {
    await expect(
      getPool().query(`INSERT INTO public.company_facts (company_id, subject_kind, subject_id, predicate, value, value_text, source_kind) VALUES ($1, 'company', $1, 'vat_period', '"månad"', 'månad', 'person')`, [companyId]),
    ).rejects.toThrow(/exclusion constraint/)
    // A different validity window is a different fact.
    const later = await record(companyId, 'vat_period', 'månad', { validFrom: '2030-01-01' })
    expect(await fact(later)).toMatchObject({ sys_to: null })
  })

  it('never deletes, and refuses every update but closing, deprecating, confirming and evidence', async () => {
    const id = await record(companyId, 'auditor', 'Ingen revisor')
    await expect(getPool().query(`DELETE FROM public.company_facts WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(getPool().query(`UPDATE public.company_facts SET value_text = 'x' WHERE id = $1`, [id])).rejects.toThrow(/immutable/)
    await expect(getPool().query(`UPDATE public.company_facts SET rank = 'deprecated' WHERE id = $1`, [id])).rejects.toThrow(/company_facts_check|deprecation_reason/)
    await getPool().query(`UPDATE public.company_facts SET sources = sources || '[{"document_id":"doc-9"}]'::jsonb WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.company_facts SET rank = 'deprecated', deprecation_reason = 'fel' WHERE id = $1`, [id])
    await expect(getPool().query(`UPDATE public.company_facts SET rank = 'normal', deprecation_reason = NULL WHERE id = $1`, [id])).rejects.toThrow(/stays deprecated/)
  })

  it('requires an approver on an agent fact, and lets revert deprecate and reinstate in one call', async () => {
    await expect(record(companyId, 'registered_office', 'Stockholm', { source: 'agent' })).rejects.toThrow(/company_facts_check/)
    const before = await record(companyId, 'registered_office', 'Stockholm')
    const after = await record(companyId, 'registered_office', 'Göteborg', { source: 'agent', approvedBy: userId })
    const { rows } = await getPool().query(`SELECT public.revert_company_fact($1, 'fel stad') AS id`, [after])
    const reinstated = rows[0].id
    expect(reinstated).not.toBeNull()
    expect(await fact(after)).toMatchObject({ rank: 'deprecated', sys_to: expect.any(Date) })
    expect(await fact(reinstated)).toMatchObject({ value_text: 'Stockholm', sys_to: null, supersedes_id: after })
    expect(await fact(before)).toMatchObject({ sys_to: expect.any(Date) })
    const again = await getPool().query(`SELECT public.revert_company_fact($1, 'igen') AS id`, [after])
    expect(again.rows[0].id).toBeNull()
  })

  it('lets members read, shows strangers nothing, and keeps writes and the functions to the service', async () => {
    const read = (user: string) => withUserContext(user, async (client) => (await client.query(`SELECT count(*)::int AS n FROM public.company_facts WHERE company_id = $1`, [companyId])).rows[0].n)
    expect(await read(userId)).toBeGreaterThan(0)
    expect(await read(strangerId)).toBe(0)
    const inserted = withUserContext(userId, (client) =>
      client.query(`INSERT INTO public.company_facts (company_id, subject_kind, subject_id, predicate, value, value_text, source_kind) VALUES ($1, 'company', $1, 'fiscal_year', '"0101-1231"', '0101-1231', 'person')`, [companyId]),
    )
    await expect(inserted).rejects.toThrow(/row-level security/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT public.revert_company_fact($1, 'x')`, [randomUUID()]))).rejects.toThrow(/permission denied/)
  })

  it('accepts the proposal operation type', async () => {
    await expect(
      getPool().query(`INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params) VALUES ($1, $2, 'arkiv_propose_fact', 'Faktum', '{}')`, [userId, companyId]),
    ).resolves.toBeTruthy()
    await expect(
      getPool().query(`INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params) VALUES ($1, $2, 'arkiv_delete_fact', 'x', '{}')`, [userId, companyId]),
    ).rejects.toThrow(/pending_operations_operation_type_check/)
  })
})
