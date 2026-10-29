import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * A worker that died during a document job's last attempt left it 'running'
 * where neither claim takes it over (#115). fail_abandoned_document_jobs
 * fails exactly those rows and returns them; every other job stays as it is.
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'kvitto.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

type Job = { status: string; attempts: number; locked_at: string | null; locked_by: string | null; last_error: string | null }

describe('fail_abandoned_document_jobs', () => {
  let userId: string
  let companyId: string
  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
  })

  /** One job on its own document, locked `lockedMinutesAgo` before now. */
  const job = async (status: string, attempts: number, lockedMinutesAgo: number | null): Promise<string> => {
    const doc = await insertDocument(userId, companyId)
    await getPool().query(
      `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, locked_at, locked_by, last_error)
       VALUES ($1, $2, 'read', $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END,
               CASE WHEN $5::int IS NULL THEN NULL ELSE 'cron:old' END, 'Bedrock 503')`,
      [companyId, doc, status, attempts, lockedMinutesAgo],
    )
    return doc
  }
  const read = async (doc: string): Promise<Job> =>
    (await getPool().query(`SELECT status, attempts, locked_at, locked_by, last_error FROM public.document_jobs WHERE document_id = $1`, [doc])).rows[0]
  const sweep = async (): Promise<string[]> =>
    (await getPool().query(`SELECT document_id FROM public.fail_abandoned_document_jobs()`)).rows.map((r) => r.document_id)

  it('fails a job left running on its last attempt past the takeover window, and returns it', async () => {
    const abandoned = await job('running', 5, 11)
    const returned = await sweep()
    expect(returned).toContain(abandoned)
    expect(await read(abandoned)).toEqual({
      status: 'failed', attempts: 5, locked_at: null, locked_by: null, last_error: 'worker stopped during the last attempt',
    })
    // Settled once: a second sweep does not return it again.
    expect(await sweep()).not.toContain(abandoned)
  })

  it('leaves every other job as it is', async () => {
    const untouched = {
      // A live worker on its last attempt: inside the takeover window.
      runningRecently: await job('running', 5, 2),
      // A dead worker with attempts left: claim_document_jobs takes it over.
      runningWithAttemptsLeft: await job('running', 4, 30),
      failedAtMax: await job('failed', 5, null),
      queued: await job('queued', 0, null),
      done: await job('done', 5, null),
    }
    const before = Object.fromEntries(await Promise.all(Object.entries(untouched).map(async ([k, doc]) => [k, await read(doc)])))
    const returned = await sweep()
    for (const [name, doc] of Object.entries(untouched)) {
      expect(returned, name).not.toContain(doc)
      expect(await read(doc), name).toEqual(before[name])
    }
  })

  it('judges staleness by the time it is given', async () => {
    const doc = await job('running', 5, 2)
    const later = await getPool().query(`SELECT document_id FROM public.fail_abandoned_document_jobs(now() + interval '9 minutes')`)
    expect(later.rows.map((r) => r.document_id)).toContain(doc)
    expect((await read(doc)).status).toBe('failed')
  })

  it('lets enqueue_document_job queue the step again once the job is failed', async () => {
    const doc = await job('running', 5, 11)
    const enqueue = async () => (await getPool().query(`SELECT public.enqueue_document_job($1, $2, 'read') AS queued`, [companyId, doc])).rows[0].queued
    expect(await enqueue()).toBe(false)
    await sweep()
    expect(await enqueue()).toBe(true)
    expect(await read(doc)).toMatchObject({ status: 'queued', attempts: 0 })
  })

  it('is closed to members', async () => {
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.fail_abandoned_document_jobs()`))).rejects.toThrow(/permission denied/)
  })
})
