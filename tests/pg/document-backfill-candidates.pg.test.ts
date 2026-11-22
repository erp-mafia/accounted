import { randomUUID } from 'crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
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

/**
 * 20261123004000 reads the small side of each check once per call (the held
 * read jobs, the reset companies, the closed or locked periods) instead of
 * probing it per document: on production the hold was a nested loop over every
 * held job for every document walked (3.5 million comparisons with about
 * 3 000 held jobs, 0.5 s of a 0.55 s call). The answer must not move: the
 * shipped body of 20261112152731 runs next to the new function on the same
 * rows, in one statement so both see the same snapshot and the same now().
 *
 * The documents, their jobs (some due an hour ago), the locks and the reset
 * are seeded inside a transaction that is rolled back: no other suite's
 * backfill or claim_document_jobs call ever sees them.
 */
describe('document_backfill_candidates reads each check once per call (20261123004000)', () => {
  const shipped = readFileSync(
    new URL('../../supabase/migrations/20261112152731_document_read_candidates_skip_open_jobs.sql', import.meta.url), 'utf8',
  ).split('CREATE OR REPLACE FUNCTION public.document_backfill_candidates')[1]!.split('AS $$')[1]!.split('$$;')[0]!
    .replaceAll('p_limit', '$1::int')

  type Company = { userId: string; companyId: string; fiscalPeriodId: string }
  let open: Company, locked: Company, closed: Company, source: Company
  let openEntry: string, lockedEntry: string, closedEntry: string, replacement: string

  beforeAll(async () => {
    open = await seedCompany()
    openEntry = await insertPostedJournalEntry({ userId: open.userId, companyId: open.companyId, fiscalPeriodId: open.fiscalPeriodId })
    locked = await seedCompany()
    lockedEntry = await insertPostedJournalEntry({ userId: locked.userId, companyId: locked.companyId, fiscalPeriodId: locked.fiscalPeriodId })
    closed = await seedCompany()
    closedEntry = await insertPostedJournalEntry({ userId: closed.userId, companyId: closed.companyId, fiscalPeriodId: closed.fiscalPeriodId })
    source = await seedCompany()
    replacement = await insertCompany({ createdBy: source.userId })
  })

  /**
   * Seeds every branch on one client in an open transaction and returns the ids, newest first. Two days ahead and
   * a second apart: the rows lead every other row, and no two tie on created_at, so the order and the cut at the
   * limit are the same whichever plan reads them. The caller rolls back.
   */
  async function seed(client: PoolClient): Promise<string[]> {
    const base = Date.now() + 2 * 86_400_000
    const mine: string[] = []
    const doc = async (p: Company & { mime?: string | null; entryId?: string; readAt?: string | null; retryAfter?: string }) => {
      const id = randomUUID()
      await client.query(
        `INSERT INTO public.document_attachments
           (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, journal_entry_id, pages_read_at, read_retry_after, created_at)
         VALUES ($1, $2, $3, 'underlag.pdf', $4, 1024, $5, $6, 'file_upload', $7, $8, $9, $10)`,
        [id, p.userId, p.companyId, p.mime === undefined ? 'application/pdf' : p.mime, `documents/${p.companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0'), p.entryId ?? null, p.readAt ?? null, p.retryAfter ?? null, new Date(base - 1000 * mine.length).toISOString()],
      )
      mine.push(id)
      return id
    }
    // run_after and locked_at an interval ago (59 or 61 minutes: either side of the hour), or tomorrow.
    const job = async (companyId: string, documentId: string, p: { kind?: string; status: string; attempts?: number; ago?: string }) => {
      const when = p.ago ? `now() - interval '${p.ago}'` : `now() + interval '1 day'`
      await client.query(
        `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, locked_at, run_after)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'running' THEN ${when} END, ${when})`,
        [companyId, documentId, p.kind ?? 'read', p.status, p.attempts ?? (p.status === 'queued' ? 0 : 1)],
      )
    }

    for (let round = 0; round < 3; round++) {
      await doc(open)
      await doc({ ...open, entryId: openEntry })
      await doc({ ...open, mime: null })
      for (const mime of ['application/json', 'application/xml', 'text/xml']) await doc({ ...open, mime })
      await doc({ ...open, readAt: new Date().toISOString() })
      await doc({ ...locked, entryId: lockedEntry })
      await doc(locked)
      await doc({ ...closed, entryId: closedEntry })
      await doc(source)
      await doc({ ...open, retryAfter: new Date(Date.now() + 3_600_000).toISOString() })
      await doc({ ...open, retryAfter: new Date(Date.now() - 60_000).toISOString() })
      for (const status of ['queued', 'running', 'failed', 'done']) {
        for (const ago of [undefined, '59 minutes', '61 minutes']) {
          const id = await doc({ ...open, entryId: round === 1 ? openEntry : undefined })
          await job(open.companyId, id, { status, ago })
        }
      }
      const gaveUp = await doc(open)
      await job(open.companyId, gaveUp, { status: 'failed', attempts: 5 })
      const otherStep = await doc(open)
      await job(open.companyId, otherStep, { kind: 'classify', status: 'queued' })
      const heldOnLocked = await doc({ ...locked, entryId: lockedEntry })
      await job(locked.companyId, heldOnLocked, { status: 'queued' })
    }

    // After the documents: the triggers refuse a document on a locked period or a reset company.
    await client.query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked.fiscalPeriodId])
    await client.query(`UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`, [closed.fiscalPeriodId])
    await client.query(
      `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'owner confirmed archive and replace for the test', '{}', '{}')`,
      [source.companyId, replacement],
    )
    return mine
  }

  /** Seeds, then runs fn as the service role in the same transaction, which is rolled back. `before` runs first, as the superuser. */
  async function seeded<T>(fn: (client: PoolClient, mine: string[]) => Promise<T>, before: string[] = []): Promise<T> {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (const statement of before) await client.query(statement)
      const mine = await seed(client)
      await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
      await client.query('SET LOCAL ROLE service_role')
      return await fn(client, mine)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('answers as the shipped body did, row for row and in order, at every limit', async () => {
    const { compared, mine } = await seeded(async (client, mine) => {
      const compared: Array<{ limit: number | null; before: string[]; after: string[] }> = []
      for (const limit of [null, -1, 0, 1, 2, 5, 9, 17, 40, 500, 501]) {
        const { rows } = await client.query<{ before: string[]; after: string[] }>(
          `SELECT
             (SELECT coalesce(array_agg(o.id ORDER BY o.created_at DESC), '{}') FROM (${shipped}) o) AS before,
             (SELECT coalesce(array_agg(f.id ORDER BY f.created_at DESC), '{}') FROM public.document_backfill_candidates($1) f) AS after`,
          [limit],
        )
        compared.push({ limit, before: rows[0]!.before.filter((id) => mine.includes(id)), after: rows[0]!.after.filter((id) => mine.includes(id)) })
      }
      return { compared, mine }
    })
    for (const { limit, before, after } of compared) expect(after, `limit ${limit}`).toEqual(before)
    // The seed reaches every branch: some rows come back, and the limit cuts.
    const all = compared.find((c) => c.limit === 500)!.after
    expect(all.length).toBeGreaterThan(17)
    expect(all.length).toBeLessThan(mine.length)
  })

  it('reads the held jobs, the reset companies and the closed periods once per call, the voucher once per document it tests', async () => {
    interface Node { 'Relation Name'?: string; 'Parent Relationship'?: string; 'Actual Loops'?: number; Plans?: Node[] }
    const notices: string[] = []
    const onNotice = (notice: { message?: string }) => {
      if (notice.message) notices.push(notice.message)
    }
    await seeded(
      async (client) => {
        client.on('notice', onNotice)
        try {
          await client.query('SELECT count(*) FROM public.document_backfill_candidates(500)')
        } finally {
          client.off('notice', onNotice)
        }
      },
      // auto_explain's settings are the superuser's to set: before the role changes.
      ['log_min_duration = 0', 'log_nested_statements = on', 'log_analyze = on', 'log_format = json', 'log_level = notice'].map((s) => `SET LOCAL auto_explain.${s}`),
    )
    const plan = notices.filter((m) => m.includes('"Plan"') && m.includes('document_jobs')).map((m) => (JSON.parse(m.slice(m.indexOf('{'))) as { Plan: Node }).Plan)[0]!
    const scans: Node[] = []
    const walk = (node: Node) => {
      if (node['Relation Name']) scans.push(node)
      for (const child of node.Plans ?? []) walk(child)
    }
    walk(plan)
    const loops = (relation: string) => scans.filter((s) => s['Relation Name'] === relation).map((s) => s['Actual Loops'])
    for (const relation of ['document_jobs', 'company_migration_resets', 'fiscal_periods']) {
      expect(loops(relation), relation).toEqual([1])
      expect(scans.find((s) => s['Relation Name'] === relation)!['Parent Relationship'], relation).toBe('SubPlan')
    }
    // The voucher is read per document that passed the cheaper tests: more than once, never in a join.
    expect(loops('journal_entries')).toHaveLength(1)
    expect(loops('journal_entries')[0]).toBeGreaterThan(1)
  })
})
