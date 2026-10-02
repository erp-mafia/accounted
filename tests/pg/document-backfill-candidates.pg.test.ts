import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertCompany, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * document_backfill_candidates() hands the read backfill only rows its stamp
 * can land on: unread, not a structured archive, not on an entry in a closed
 * or locked period (enforce_period_lock_documents refuses the update), not
 * the archived source of a migration reset. Before it, a refused row stayed
 * the newest unread and was read again every run.
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

  it('is for the service role only', async () => {
    const { userId } = await seedCompany()
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.document_backfill_candidates(1)`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.document_retry_candidates(ARRAY['ai_gated'], 1)`))).rejects.toThrow(/permission denied/)
  })
})
