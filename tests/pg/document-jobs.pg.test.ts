import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 3. The job queue: one job per step per document, claimed with
 * SKIP LOCKED, queued again only once finished, invisible to members. The
 * record: saved through save_document_extraction (supersedes in one
 * transaction, refuses a stale base), one current row per document,
 * readable by members only, gone with its document.
 */
async function insertDocument(userId: string, companyId: string, docType: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, doc_type, page_count)
     VALUES ($1, $2, $3, 'avtal.pdf', 'application/pdf', 1024, $4, $5, 'file_upload', $6, $7)`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0'), docType, docType ? 3 : null],
  )
  return id
}

type ClaimedRow = { id: string; company_id: string; document_id: string; kind: string; attempts: number }

const claim = async (batchSize: number, worker: string): Promise<ClaimedRow[]> =>
  (await getPool().query(`SELECT * FROM public.claim_document_jobs($1, $2)`, [batchSize, worker])).rows

describe('document_jobs', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    // The claim spans every tenant by design. Only this file writes far-past
    // jobs, so a database reused across runs drops the previous run's
    // claimable leftovers before the ordering assertions.
    await getPool().query(`DELETE FROM public.document_jobs WHERE run_after < '2001-01-01'`)
  })

  it('queues one job per step per document, and queues a step again only once it finished', async () => {
    const doc = await insertDocument(userId, companyId)
    const enqueue = async () => (await getPool().query(`SELECT public.enqueue_document_job($1, $2, 'read') AS queued`, [companyId, doc])).rows[0].queued
    expect(await enqueue()).toBe(true)
    expect(await enqueue()).toBe(false)
    await getPool().query(`UPDATE public.document_jobs SET status = 'done', attempts = 1, result = 'read 1 pages (pdf_text)' WHERE document_id = $1`, [doc])
    expect(await enqueue()).toBe(true)
    const { rows } = await getPool().query(`SELECT status, attempts, result FROM public.document_jobs WHERE document_id = $1`, [doc])
    expect(rows).toEqual([{ status: 'queued', attempts: 0, result: null }])
  })

  it('claims the longest-due job first, marks it running and counts the attempt', async () => {
    const [older, newer, later] = [await insertDocument(userId, companyId), await insertDocument(userId, companyId), await insertDocument(userId, companyId)]
    await getPool().query(
      `INSERT INTO public.document_jobs (company_id, document_id, kind, run_after) VALUES
         ($1, $2, 'read', '2000-01-01'), ($1, $3, 'read', '2000-01-02'), ($1, $4, 'read', now() + interval '1 hour')`,
      [companyId, older, newer, later],
    )
    expect(await claim(1, 'worker-1')).toEqual([expect.objectContaining({ document_id: older, attempts: 1 })])
    expect(await claim(1, 'worker-2')).toEqual([expect.objectContaining({ document_id: newer })])
    const { rows } = await getPool().query(`SELECT status, locked_by FROM public.document_jobs WHERE document_id = $1`, [older])
    expect(rows[0]).toEqual({ status: 'running', locked_by: 'worker-1' })
    expect((await claim(500, 'worker-3')).filter((r) => r.document_id === later)).toEqual([])
  })

  it('takes over a job whose worker died, and gives up after max_attempts', async () => {
    const doc = await insertDocument(userId, companyId)
    await getPool().query(
      `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, locked_at, run_after)
       VALUES ($1, $2, 'extract', 'running', 1, now() - interval '11 minutes', '2000-01-01')`,
      [companyId, doc],
    )
    expect((await claim(500, 'worker-4')).filter((r) => r.document_id === doc)).toEqual([expect.objectContaining({ attempts: 2 })])
    await getPool().query(`UPDATE public.document_jobs SET status = 'failed', attempts = max_attempts WHERE document_id = $1`, [doc])
    expect((await claim(500, 'worker-5')).filter((r) => r.document_id === doc)).toEqual([])
  })

  it('rejects a bad batch size and keeps the queue from members', async () => {
    await expect(claim(0, 'worker')).rejects.toThrow(/p_batch_size/)
    const seen = await withUserContext(userId, async (client) => (await client.query(`SELECT id FROM public.document_jobs WHERE company_id = $1`, [companyId])).rows)
    expect(seen).toEqual([])
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.claim_document_jobs(1, 'member')`))).rejects.toThrow(/permission denied/)
    const doc = await insertDocument(userId, companyId)
    await expect(withUserContext(userId, (client) => client.query(`SELECT public.enqueue_document_job($1, $2, 'read')`, [companyId, doc]))).rejects.toThrow(/permission denied/)
  })

  it('backfills extraction only for admitted, typed, read documents of the given companies that never had a job', async () => {
    const { userId: owner, companyId: company } = await seedCompany()
    const typed = await insertDocument(owner, company, 'agreement.loan')
    await insertDocument(owner, company)
    const held = await insertDocument(owner, company, 'receipt')
    await getPool().query(`UPDATE public.document_attachments SET admission_state = 'held' WHERE id = $1`, [held])
    const backfill = async (companyIds: string[]) =>
      (await getPool().query(`SELECT public.enqueue_missing_document_extractions($1::uuid[], 50) AS queued`, [companyIds])).rows[0].queued

    expect(await backfill([company])).toBe(1)
    expect(await backfill([company])).toBe(0)
    const { rows } = await getPool().query(`SELECT document_id FROM public.document_jobs WHERE company_id = $1 AND kind = 'extract'`, [company])
    expect(rows).toEqual([{ document_id: typed }])
    await getPool().query(`UPDATE public.document_jobs SET status = 'failed', attempts = max_attempts WHERE document_id = $1`, [typed])
    expect(await backfill([company])).toBe(0)
    expect(await backfill([randomUUID()])).toBe(0)
  })
})

describe('document_extractions', () => {
  let userId: string
  let companyId: string
  let strangerId: string
  let documentId: string
  let activityId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
    documentId = await insertDocument(userId, companyId, 'agreement.loan')
    await getPool().query(
      `INSERT INTO public.extraction_schemas (schema_type, version, json_schema, field_kinds) VALUES ('agreement.loan', 1, '{}', '{}') ON CONFLICT DO NOTHING`,
    )
    const agent = await getPool().query(`INSERT INTO public.agents (kind, name, version) VALUES ('software', 'arkiv.extract', $1) RETURNING id`, [`test-${randomUUID()}`])
    const activity = await getPool().query(
      `INSERT INTO public.activities (company_id, document_id, agent_id, kind, started_at, ended_at, outcome)
       VALUES ($1, $2, $3, 'extract', now(), now(), 'review') RETURNING id`,
      [companyId, documentId, agent.rows[0].id],
    )
    activityId = activity.rows[0].id
  })

  const save = async (supersedesId: string | null, pass = 'consensus', version = 1): Promise<string> =>
    (
      await getPool().query(
        `SELECT public.save_document_extraction($1, $2, $3, 'agreement.loan', $4, $5, '{"principal": {"value": 1000000}}', '[]', '{interest_rate}') AS id`,
        [documentId, supersedesId, activityId, version, pass],
      )
    ).rows[0].id

  const currentId = async (): Promise<string> =>
    (await getPool().query(`SELECT id FROM public.document_extractions WHERE document_id = $1 AND is_current`, [documentId])).rows[0].id

  it('saves the first record, supersedes it with the next, and stamps the document', async () => {
    const first = await save(null)
    const second = await save(first, 'human')
    const { rows } = await getPool().query(`SELECT id, is_current, supersedes_id FROM public.document_extractions WHERE document_id = $1`, [documentId])
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: first, is_current: false, supersedes_id: null },
        { id: second, is_current: true, supersedes_id: first },
      ]),
    )
    const doc = await getPool().query(`SELECT fields_extracted_at FROM public.document_attachments WHERE id = $1`, [documentId])
    expect(doc.rows[0].fields_extracted_at).not.toBeNull()
  })

  it('refuses a stale base, an unregistered schema version and an unknown pass, changing nothing', async () => {
    const before = await currentId()
    await expect(save(null)).rejects.toThrow(/changed since it was read/)
    await expect(save(before, 'consensus', 99)).rejects.toThrow(/document_extractions_schema_type_schema_version_fkey/)
    await expect(save(before, 'guess')).rejects.toThrow(/document_extractions_pass_check/)
    expect(await currentId()).toBe(before)
  })

  it('allows one current record per document', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.document_extractions (company_id, document_id, activity_id, schema_type, schema_version, pass, payload)
         VALUES ($1, $2, $3, 'agreement.loan', 1, 'human', '{}')`,
        [companyId, documentId, activityId],
      ),
    ).rejects.toThrow(/idx_document_extractions_current/)
  })

  it('lets members read the record and its activity, shows strangers nothing, and lets only the service write', async () => {
    const read = (user: string) =>
      withUserContext(user, async (client) => ({
        extractions: (await client.query(`SELECT review_fields FROM public.document_extractions WHERE document_id = $1 AND is_current`, [documentId])).rows,
        activities: (await client.query(`SELECT kind FROM public.activities WHERE id = $1`, [activityId])).rows,
      }))
    expect(await read(userId)).toEqual({ extractions: [{ review_fields: ['interest_rate'] }], activities: [{ kind: 'extract' }] })
    expect(await read(strangerId)).toEqual({ extractions: [], activities: [] })
    const updated = await withUserContext(userId, (client) => client.query(`UPDATE public.document_extractions SET review_fields = '{}' WHERE document_id = $1`, [documentId]))
    expect(updated.rowCount).toBe(0)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT public.save_document_extraction($1, NULL, $2, 'agreement.loan', 1, 'human', '{}', '[]', '{}')`, [documentId, activityId]),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('shows software agents to every signed-in user and a person\'s agent to that person only', async () => {
    const person = (await getPool().query(`INSERT INTO public.agents (kind, name, user_id) VALUES ('human', 'person', $1) RETURNING id`, [userId])).rows[0].id
    const visible = (user: string) =>
      withUserContext(user, async (client) => (await client.query(`SELECT kind FROM public.agents WHERE id = $1 OR name = 'arkiv.extract'`, [person])).rows.map((r) => r.kind))
    expect(await visible(userId)).toContain('human')
    const seenByStranger = await visible(strangerId)
    expect(seenByStranger).toContain('software')
    expect(seenByStranger).not.toContain('human')
  })

  it('removes the record, its activities and its jobs with the document', async () => {
    await getPool().query(`INSERT INTO public.document_jobs (company_id, document_id, kind) VALUES ($1, $2, 'extract')`, [companyId, documentId])
    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])
    const { rows } = await getPool().query(
      `SELECT (SELECT count(*) FROM public.document_extractions WHERE document_id = $1)::int AS extractions,
              (SELECT count(*) FROM public.activities WHERE document_id = $1)::int AS activities,
              (SELECT count(*) FROM public.document_jobs WHERE document_id = $1)::int AS jobs`,
      [documentId],
    )
    expect(rows[0]).toEqual({ extractions: 0, activities: 0, jobs: 0 })
  })
})
