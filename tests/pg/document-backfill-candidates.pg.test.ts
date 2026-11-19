import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertCompany, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * document_backfill_candidates() hands the read backfill only rows its stamp
 * can land on: unread, not a structured archive, not on an entry in a closed
 * or locked period (enforce_period_lock_documents refuses the update), not
 * the archived source of a migration reset. Before it, a refused row stayed
 * the newest unread and was read again every run.
 *
 * Nor a document the job queue is still going to read (20261112152731): its
 * read job is running, or queued or failed with attempts left. The backfill
 * reading it too sent every page to the model twice and raced the queue on
 * the document's pages. The hold ends when the queue has not acted for an
 * hour. Nor a document whose last reading got no answer, until its wait is
 * over: note_document_read_unavailable counts those, once per wait, and sets
 * the wait. A document given up on stays unread and is taken again daily.
 */
const future = new Date(Date.now() + 86_400_000).toISOString() // ours sort first, whatever else the database holds

const past = '2000-01-01T00:00:00Z' // gated rows retry oldest stamp first: ours lead that list too

async function insertDocument(p: { userId: string; companyId: string; mime?: string; entryId?: string; readAt?: string | null; readError?: string | null }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, journal_entry_id, pages_read_at, read_error, created_at)
     VALUES ($1, $2, $3, 'underlag.pdf', $4, 1024, $5, $6, 'file_upload', $7, $8, $9, $10)`,
    [id, p.userId, p.companyId, p.mime ?? 'application/pdf', `documents/${p.companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0'), p.entryId ?? null, p.readAt ?? null, p.readError ?? null, future],
  )
  return id
}

// Not due until tomorrow, so no other suite's claim_document_jobs call takes one of these and changes its status.
async function insertJob(p: { companyId: string; documentId: string; kind: string; status: string; attempts?: number }): Promise<void> {
  await getPool().query(
    `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, locked_at, run_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.companyId, p.documentId, p.kind, p.status, p.attempts ?? (p.status === 'queued' ? 0 : 1), p.status === 'running' ? new Date().toISOString() : null, future],
  )
}

/**
 * Runs fn in a transaction that is rolled back: what it changes is never
 * visible to another suite (a job made due here would otherwise be there for
 * any claim_document_jobs call to take).
 */
async function rolledBack<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('document_backfill_candidates and document_retry_candidates', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const open = await seedCompany()
    ids.unread = await insertDocument(open)
    ids.json = await insertDocument({ ...open, mime: 'application/json' })
    ids.read = await insertDocument({ ...open, readAt: new Date().toISOString() })
    const openEntry = await insertPostedJournalEntry({ userId: open.userId, companyId: open.companyId, fiscalPeriodId: open.fiscalPeriodId })
    ids.onOpenEntry = await insertDocument({ ...open, entryId: openEntry })

    const locked = await seedCompany()
    const lockedEntry = await insertPostedJournalEntry({ userId: locked.userId, companyId: locked.companyId, fiscalPeriodId: locked.fiscalPeriodId })
    ids.onLockedEntry = await insertDocument({ ...locked, entryId: lockedEntry })
    ids.gatedOnLockedEntry = await insertDocument({ ...locked, entryId: lockedEntry, readAt: past, readError: 'ai_gated' })
    ids.gatedOnOpenEntry = await insertDocument({ ...open, entryId: openEntry, readAt: past, readError: 'ai_gated' })
    ids.readFine = await insertDocument({ ...open, readAt: past })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked.fiscalPeriodId])

    // Unread documents by the state of their read job, and one whose only job is another step.
    for (const status of ['queued', 'running', 'failed', 'done']) {
      ids[`unreadJob_${status}`] = await insertDocument(open)
      await insertJob({ companyId: open.companyId, documentId: ids[`unreadJob_${status}`], kind: 'read', status })
    }
    // A read job that gave up: failed with no attempts left (max_attempts is 5).
    ids.unreadJob_gaveUp = await insertDocument(open)
    await insertJob({ companyId: open.companyId, documentId: ids.unreadJob_gaveUp, kind: 'read', status: 'failed', attempts: 5 })
    // Unread documents for the count of readings without an answer.
    ids.unanswered = await insertDocument(open)
    ids.unansweredLongAgo = await insertDocument(open)
    ids.unansweredCapped = await insertDocument({ ...open, readAt: past, readError: 'partial:budget' })
    ids.unansweredBurst = await insertDocument(open)
    // Given up on: still unread (pages_read_at NULL), read_error says so.
    ids.gaveUp = await insertDocument({ ...open, readError: 'read_failed: gave up' })
    ids.unreadOtherJob = await insertDocument(open)
    await insertJob({ companyId: open.companyId, documentId: ids.unreadOtherJob, kind: 'classify', status: 'queued' })
    // The same for a document capped at one page, which the retry pass reads again.
    for (const status of ['queued', 'running', 'failed', 'done']) {
      ids[`cappedJob_${status}`] = await insertDocument({ ...open, readAt: past, readError: 'partial:budget' })
      await insertJob({ companyId: open.companyId, documentId: ids[`cappedJob_${status}`], kind: 'read', status })
    }
    ids.cappedJob_gaveUp = await insertDocument({ ...open, readAt: past, readError: 'partial:budget' })
    await insertJob({ companyId: open.companyId, documentId: ids.cappedJob_gaveUp, kind: 'read', status: 'failed', attempts: 5 })

    const source = await seedCompany()
    ids.resetSource = await insertDocument(source)
    const replacement = await insertCompany({ createdBy: source.userId })
    await getPool().query(
      `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'owner confirmed archive and replace for the test', '{}', '{}')`,
      [source.companyId, replacement],
    )
  })

  const candidates = () =>
    runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.document_backfill_candidates(500)`)
      return new Set(rows.map((r) => r.id))
    })

  it('returns unread documents, on an open entry or none', async () => {
    const got = await candidates()
    expect(got.has(ids.unread)).toBe(true)
    expect(got.has(ids.onOpenEntry)).toBe(true)
  })

  it('leaves out what is read, what is never read, and what the stamp could not land on', async () => {
    const got = await candidates()
    expect(got.has(ids.read)).toBe(false)
    expect(got.has(ids.json)).toBe(false)
    expect(got.has(ids.onLockedEntry)).toBe(false)
    expect(got.has(ids.resetSource)).toBe(false)
  })

  it('agrees with the trigger: the stamp on a locked-period document is refused', async () => {
    await expect(getPool().query(`UPDATE public.document_attachments SET pages_read_at = now() WHERE id = $1`, [ids.onLockedEntry])).rejects.toThrow(/locked\/closed fiscal period/)
  })

  it('retries gated documents it can stamp, never one on a locked period', async () => {
    const got = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.document_retry_candidates(ARRAY['ai_gated','partial:ai_gated'], 500)`)
      return new Set(rows.map((r) => r.id))
    })
    expect(got.has(ids.gatedOnOpenEntry)).toBe(true)
    expect(got.has(ids.gatedOnLockedEntry)).toBe(false)
    expect(got.has(ids.readFine)).toBe(false)
  })

  it('leaves an unread document to the job queue while the queue will still read it', async () => {
    const got = await candidates()
    expect(got.has(ids.unreadJob_queued)).toBe(false)
    expect(got.has(ids.unreadJob_running)).toBe(false)
    // Failed with attempts left: claim_document_jobs takes it again after its backoff, so the backfill reading it
    // meanwhile is the same read done twice.
    expect(got.has(ids.unreadJob_failed)).toBe(false)
    // A read job that gave up, or ended without a read, no longer holds the document: the backfill is what is left.
    expect(got.has(ids.unreadJob_gaveUp)).toBe(true)
    expect(got.has(ids.unreadJob_done)).toBe(true)
    // Another step's job says nothing about the read.
    expect(got.has(ids.unreadOtherJob)).toBe(true)
  })

  const retryCandidates = (client: PoolClient) =>
    client.query<{ id: string }>(`SELECT id FROM public.document_retry_candidates(ARRAY['partial:budget'], 500)`).then(({ rows }) => new Set(rows.map((r) => r.id)))

  it('leaves a document the retry pass would read again to the job queue the same way', async () => {
    const got = await runAsServiceRole(retryCandidates)
    expect(got.has(ids.cappedJob_queued)).toBe(false)
    expect(got.has(ids.cappedJob_running)).toBe(false)
    expect(got.has(ids.cappedJob_failed)).toBe(false)
    expect(got.has(ids.cappedJob_gaveUp)).toBe(true)
    expect(got.has(ids.cappedJob_done)).toBe(true)
  })

  it('stops waiting for a queue that is not draining: a job due or locked more than an hour ago holds nothing', async () => {
    await rolledBack(async (client) => {
      const held = [ids.unreadJob_queued, ids.unreadJob_failed, ids.cappedJob_queued, ids.cappedJob_failed]
      // Due 59 minutes ago: the worker may still be on its way.
      await client.query(`UPDATE public.document_jobs SET run_after = now() - interval '59 minutes' WHERE document_id = ANY($1) AND kind = 'read'`, [held])
      await client.query(`UPDATE public.document_jobs SET locked_at = now() - interval '59 minutes' WHERE document_id = ANY($1) AND kind = 'read'`, [[ids.unreadJob_running, ids.cappedJob_running]])
      let unread = new Set((await client.query<{ id: string }>(`SELECT id FROM public.document_backfill_candidates(500)`)).rows.map((r) => r.id))
      let capped = await retryCandidates(client)
      for (const id of [ids.unreadJob_queued, ids.unreadJob_failed, ids.unreadJob_running]) expect(unread.has(id)).toBe(false)
      for (const id of [ids.cappedJob_queued, ids.cappedJob_failed, ids.cappedJob_running]) expect(capped.has(id)).toBe(false)

      // Due, or locked, 61 minutes ago: nobody is draining the queue, and the backfill is the reader that is left.
      await client.query(`UPDATE public.document_jobs SET run_after = now() - interval '61 minutes' WHERE document_id = ANY($1) AND kind = 'read'`, [held])
      await client.query(`UPDATE public.document_jobs SET locked_at = now() - interval '61 minutes' WHERE document_id = ANY($1) AND kind = 'read'`, [[ids.unreadJob_running, ids.cappedJob_running]])
      unread = new Set((await client.query<{ id: string }>(`SELECT id FROM public.document_backfill_candidates(500)`)).rows.map((r) => r.id))
      capped = await retryCandidates(client)
      for (const id of [ids.unreadJob_queued, ids.unreadJob_failed, ids.unreadJob_running]) expect(unread.has(id)).toBe(true)
      for (const id of [ids.cappedJob_queued, ids.cappedJob_failed, ids.cappedJob_running]) expect(capped.has(id)).toBe(true)
    })
  })

  // What lib/documents/read/store.ts passes (READ_RETRY_WAIT_MINUTES): the queue's outage backoff, then a day.
  const WAITS = [30, 60, 120, 240, 1440]
  type Noted = { failures: number; counted: boolean }
  const note = (documentId: string) =>
    runAsServiceRole(
      async (client) =>
        (await client.query<Noted>(`SELECT failures, counted FROM public.note_document_read_unavailable($1, $2::integer[])`, [documentId, WAITS])).rows[0],
    )
  const waitMinutes = async (documentId: string) =>
    Number((await getPool().query<{ m: string }>(`SELECT round(extract(epoch FROM (read_retry_after - now())) / 60) AS m FROM public.document_attachments WHERE id = $1`, [documentId])).rows[0].m)
  /** As if the wait were over: the next failure may count. */
  const waitOver = (documentId: string) =>
    getPool().query(`UPDATE public.document_attachments SET read_retry_after = now() - interval '1 minute' WHERE id = $1`, [documentId])

  it('counts the readings that got no answer, each once its wait is over, and sets the wait before the next', async () => {
    expect((await candidates()).has(ids.unanswered)).toBe(true)
    const seen: Array<[number, boolean, number]> = []
    for (let i = 0; i < 6; i++) {
      if (i > 0) await waitOver(ids.unanswered)
      const { failures, counted } = await note(ids.unanswered)
      seen.push([failures, counted, await waitMinutes(ids.unanswered)])
    }
    // 30 + 60 + 120 + 240 minutes before the fifth can count: 7.5 hours at the least. From the fifth on, a day.
    expect(seen).toEqual([[1, true, 30], [2, true, 60], [3, true, 120], [4, true, 240], [5, true, 1440], [6, true, 1440]])
  })

  it('does not count a failure inside the wait: fast retries (the upload screen polls every 1.5 s) are one failure, not five', async () => {
    expect(await note(ids.unansweredBurst)).toEqual({ failures: 1, counted: true })
    for (let i = 0; i < 5; i++) expect(await note(ids.unansweredBurst)).toEqual({ failures: 1, counted: false })
    // The wait stays what the counted failure set.
    expect(await waitMinutes(ids.unansweredBurst)).toBe(30)
  })

  it('keeps a document out of the backfill until its wait is over, in the unread pass and the retry pass', async () => {
    await note(ids.unanswered)
    await note(ids.unansweredCapped)
    expect((await candidates()).has(ids.unanswered)).toBe(false)
    expect((await runAsServiceRole(retryCandidates)).has(ids.unansweredCapped)).toBe(false)
    await waitOver(ids.unanswered)
    await waitOver(ids.unansweredCapped)
    expect((await candidates()).has(ids.unanswered)).toBe(true)
    expect((await runAsServiceRole(retryCandidates)).has(ids.unansweredCapped)).toBe(true)
  })

  it('takes a document given up on again once a day: it is still unread, and waits out its day', async () => {
    await getPool().query(`UPDATE public.document_attachments SET read_failures = 5, read_retry_after = now() + interval '1 day' WHERE id = $1`, [ids.gaveUp])
    expect((await candidates()).has(ids.gaveUp)).toBe(false)
    await waitOver(ids.gaveUp)
    expect((await candidates()).has(ids.gaveUp)).toBe(true)
    // Its next failure counts, and waits another day.
    expect(await note(ids.gaveUp)).toEqual({ failures: 6, counted: true })
    expect(await waitMinutes(ids.gaveUp)).toBe(1440)
  })

  it('starts the count again when the last wait ended more than a day ago: a new episode, not the fifth try of an old one', async () => {
    await getPool().query(`UPDATE public.document_attachments SET read_failures = 4, read_retry_after = now() - interval '25 hours' WHERE id = $1`, [ids.unansweredLongAgo])
    expect(await note(ids.unansweredLongAgo)).toEqual({ failures: 1, counted: true })
    // Within the day it goes on counting.
    await getPool().query(`UPDATE public.document_attachments SET read_failures = 4, read_retry_after = now() - interval '23 hours' WHERE id = $1`, [ids.unansweredLongAgo])
    expect(await note(ids.unansweredLongAgo)).toEqual({ failures: 5, counted: true })
  })

  it('counts readings in a row: a document stamped after its last unanswered reading starts again at one', async () => {
    // Three unanswered readings, the last noted two hours ago (its wait, 120 minutes, just over); stamped long before.
    const setState = (pagesReadAt: string) =>
      getPool().query(
        `UPDATE public.document_attachments SET read_failures = 3, read_retry_after = now() - interval '1 minute', pages_read_at = $2 WHERE id = $1`,
        [ids.unansweredCapped, pagesReadAt],
      )
    await setState(past)
    expect(await note(ids.unansweredCapped)).toEqual({ failures: 4, counted: true })
    // Read after that last unanswered reading (a later pass got an answer): the row is broken.
    await setState(new Date().toISOString())
    expect(await note(ids.unansweredCapped)).toEqual({ failures: 1, counted: true })
  })

  it('counts nothing for a document on a locked period: the row refuses every update, and the backfill never takes it', async () => {
    await expect(note(ids.onLockedEntry)).rejects.toThrow(/locked\/closed fiscal period/)
  })

  it('is for the service role only', async () => {
    const { userId } = await seedCompany()
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.document_backfill_candidates(1)`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.document_retry_candidates(ARRAY['ai_gated'], 1)`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT public.note_document_read_unavailable($1, ARRAY[30])`, [ids.unanswered]))).rejects.toThrow(/permission denied/)
  })
})
