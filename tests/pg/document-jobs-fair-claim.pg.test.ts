import { randomUUID } from 'crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * claim_document_jobs serves companies, not the oldest job across all of them
 * (crm#2166). It took the job with the oldest run_after, so one company that
 * queued thousands of jobs at once (a migration import queues a read job per
 * document) held every other company's documents behind all of them: 35 hours
 * at the worst in production (2026-11-22). Now each claim draws a company
 * among those with a due job and takes that company's longest-due job.
 *
 * Every job here is due in 1999 and every claim is made as of the end of
 * 1999, so no other file's jobs are due for these claims, and theirs never
 * meet these (document-jobs.pg.test.ts claims as of early 2000 and drops what
 * is left before 2001 first).
 */
const AS_OF = '1999-12-31T00:00:00Z'

type ClaimedRow = { id: string; company_id: string; document_id: string; kind: string; attempts: number }

async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'kvitto.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

/** A company with one queued read job per run_after, each on its own document; the documents in that order. */
async function companyWithJobs(runAfters: string[]): Promise<{ companyId: string; documents: string[] }> {
  const { userId, companyId } = await seedCompany()
  const documents: string[] = []
  for (const runAfter of runAfters) {
    const documentId = await insertDocument(userId, companyId)
    await getPool().query(`INSERT INTO public.document_jobs (company_id, document_id, kind, run_after) VALUES ($1, $2, 'read', $3)`, [companyId, documentId, runAfter])
    documents.push(documentId)
  }
  return { companyId, documents }
}

/** `count` run_after times an hour apart, from `from`. */
const hourly = (from: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * 3_600_000).toISOString())

const claim = async (batchSize: number, worker = 'worker'): Promise<ClaimedRow[]> =>
  (await getPool().query(`SELECT * FROM public.claim_document_jobs($1, $2, $3)`, [batchSize, worker, AS_OF])).rows

describe('claim_document_jobs: a company drawn per job', () => {
  // Only this file writes jobs due in 1999: what an earlier test left is dropped, so each test sees its own, and
  // nothing is left for another file's claim made as of now.
  const dropLeftovers = async () => {
    await getPool().query(`DELETE FROM public.document_jobs WHERE run_after < '2000-01-01'`)
  }
  beforeEach(dropLeftovers)
  afterAll(dropLeftovers)

  it('takes one job from each company before a second from any, however many one company has queued', async () => {
    const bulk = await companyWithJobs(hourly('1999-01-01T00:00:00Z', 40))
    const other = await companyWithJobs(['1999-06-01T00:00:00Z'])

    // The old claim took the bulk company's two oldest; the other company's document waited behind all 40.
    const first = await claim(2)
    expect(first.map((job) => job.document_id).sort()).toEqual([bulk.documents[0], other.documents[0]].sort())
    expect(first.every((job) => job.attempts === 1)).toBe(true)

    // The other company has nothing left: the bulk company's next jobs, in its own order.
    expect((await claim(2)).map((job) => job.document_id)).toEqual(bulk.documents.slice(1, 3))
  })

  it('reaches a company with one job within a few single claims while another has 30 older ones queued', async () => {
    const bulk = await companyWithJobs(hourly('1999-02-01T00:00:00Z', 30))
    const other = await companyWithJobs(['1999-07-01T00:00:00Z'])

    // One job a claim, as the worker claims. Each claim draws one of the two companies at even odds, so the
    // chance that 20 claims all go to the bulk company is 2^-20, about one in a million. The old claim gave the
    // other company's job the 31st claim.
    const claimed: string[] = []
    for (let i = 0; i < 20 && !claimed.includes(other.documents[0]); i++) {
      claimed.push(...(await claim(1)).map((job) => job.document_id))
    }
    expect(claimed).toContain(other.documents[0])
    // The bulk company's jobs came longest-due first all the same.
    const bulkClaimed = claimed.filter((doc) => doc !== other.documents[0])
    expect(bulkClaimed).toEqual(bulk.documents.slice(0, bulkClaimed.length))
  })

  it('passes over a job another worker is claiming for the same company\'s next one, instead of coming back empty', async () => {
    const only = await companyWithJobs(hourly('1999-03-01T00:00:00Z', 4))
    const other = await getClient()
    try {
      // Another worker's claim holds the two oldest rows until it commits.
      await other.query('BEGIN')
      await other.query(`SELECT id FROM public.document_jobs WHERE document_id = ANY ($1) FOR UPDATE`, [only.documents.slice(0, 2)])
      // An empty answer ends the worker's run (lib/documents/jobs/queue.ts), as if nothing were due.
      expect((await claim(1)).map((job) => job.document_id)).toEqual([only.documents[2]])
    } finally {
      await other.query('ROLLBACK')
      other.release()
    }
  })

  it('claims nothing that is not due: a wait still ahead, a job that gave up, a job a live worker holds', async () => {
    const { userId, companyId } = await seedCompany()
    const job = async (status: string, attempts: number, runAfter: string, lockedAt: string | null): Promise<string> => {
      const documentId = await insertDocument(userId, companyId)
      await getPool().query(
        `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, run_after, locked_at) VALUES ($1, $2, 'read', $3, $4, $5, $6)`,
        [companyId, documentId, status, attempts, runAfter, lockedAt],
      )
      return documentId
    }
    await job('failed', 1, '1999-12-31T01:00:00Z', null)
    await job('failed', 5, '1999-04-01T00:00:00Z', null)
    await job('running', 1, '1999-04-01T00:00:00Z', '1999-12-30T23:55:00Z')
    await job('done', 1, '1999-04-01T00:00:00Z', null)
    expect(await claim(500)).toEqual([])

    // A worker that died mid-job, locked more than ten minutes before the claim: taken over, its attempt counted.
    const abandoned = await job('running', 2, '1999-04-01T00:00:00Z', '1999-12-30T23:45:00Z')
    expect(await claim(500)).toEqual([expect.objectContaining({ document_id: abandoned, attempts: 3 })])
  })
})
