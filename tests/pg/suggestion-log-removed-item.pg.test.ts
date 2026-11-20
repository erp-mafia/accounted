/**
 * Senast borttagna on real Postgres (migration 20261117192013): deleting an
 * inbox item keeps its row on the decision the deletion writes
 * (suggestion_log.removed_item), and putting it back inserts that row again
 * under its own id.
 *
 * The production services run here as they do behind the dashboard
 * (deleteInboxItem, listRemovedInboxItems, restoreInboxItem), each on a
 * signed-in member's own client, so RLS, the constraints and the keys decide
 * what they decide in production:
 *
 *   1. the item comes back as it was: reading, mail fields, door, arrival
 *      time (so usage counts it in the month it always belonged to);
 *   2. once: a second restore, two at the same time, and a mail that was
 *      delivered again meanwhile all leave one item;
 *   3. not when its document was booked since;
 *   4. a viewer reads the list and cannot restore; a member of another
 *      company sees nothing;
 *   5. the copy leaves with its document;
 *   6. only the decision that deleted an inbox item can carry one.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts;
 * every request must stay inside the shim's grammar, asserted after each
 * test) and match on arrival's look in the bank after a restore, which has
 * its own tests.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { deleteInboxItem } from '@/lib/documents/inbox-item-actions'
import { listRemovedInboxItems, restoreInboxItem } from '@/lib/operations/inbox-restore'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import type { OperationContext } from '@/lib/operations/types'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany, setActiveCompany } from './fixtures'
import { getPool } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'

vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn(async () => undefined) }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

const shims: PgRest[] = []

/** A supabase-js client acting as a signed-in member, through RLS: what PostgREST gives a browser session. */
function memberClient(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  shims.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    global: { fetch: rest.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }

/** The operation context a dashboard door builds for a signed-in member. */
function as(userId: string, inCompany: string): OperationContext {
  return { supabase: memberClient(userId), companyId: inCompany, userId, log } as unknown as OperationContext
}

afterEach(() => {
  const unsupported = shims.flatMap((rest) => rest.unsupported.splice(0))
  shims.length = 0
  expect(unsupported).toEqual([])
})

// An e-invoice's reading lives on the item alone: its document carries none.
const READING = {
  supplier: { name: 'Nordisk Kontorsservice AB', orgNumber: '556000-0001' },
  invoice: { invoiceNumber: 'F-1001', invoiceDate: '2026-08-10', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  lineItems: [{ description: 'Pärmar' }],
}
const ARRIVED = '2026-08-12T07:30:00.000Z'

let ownerId: string
let viewerId: string
let strangerId: string
let companyId: string
let fiscalPeriodId: string

beforeAll(async () => {
  ;({ userId: ownerId, companyId, fiscalPeriodId } = await seedCompany())
  viewerId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
  const other = await seedCompany()
  strangerId = other.userId
  await setActiveCompany(ownerId, companyId)
  await setActiveCompany(viewerId, companyId)
  await setActiveCompany(strangerId, other.companyId)
})

async function document(fileName = 'faktura-augusti.pdf'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf')`,
    [id, companyId, ownerId, `${companyId}/${id}.pdf`, fileName, `sha-${id}`],
  )
  return id
}

/** An open item as the mail door files it, arrived in August. */
async function inboxItem(documentId: string, mail: { emailId?: string; attachmentId?: string } = {}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items
       (id, company_id, user_id, document_id, status, source, extracted_data, extraction_skipped, kind_hint, channel_context,
        email_from, email_subject, email_received_at, email_body_text, resend_email_id, resend_attachment_id, created_at)
     VALUES ($1, $2, $3, $4, 'received', 'email', $5, false, 'supplier_invoice', $6,
             'faktura@example.test', 'Faktura F-1001', $7, 'Hej, här kommer fakturan.', $8, $9, $7)`,
    [id, companyId, ownerId, documentId, JSON.stringify(READING), JSON.stringify({ intake_source: 'intake_email' }), ARRIVED, mail.emailId ?? `mail-${id}`, mail.attachmentId ?? 'att-1'],
  )
  return id
}

const KEPT_COLUMNS =
  'id, company_id, user_id, document_id, status, source, extracted_data, extraction_skipped, kind_hint, channel_context, email_from, email_subject, email_received_at, email_body_text, resend_email_id, resend_attachment_id, created_at, matched_transaction_id, routed_to_arkiv_at'

async function itemRow(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await getPool().query(`SELECT ${KEPT_COLUMNS} FROM public.invoice_inbox_items WHERE id = $1`, [id])
  return rows[0] ?? null
}

async function itemsOfDocument(documentId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.invoice_inbox_items WHERE document_id = $1`, [documentId])
  return rows[0]!.n
}

async function keptCopies(documentId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT removed_item->>'id' AS id FROM public.suggestion_log WHERE document_id = $1 AND removed_item IS NOT NULL ORDER BY created_at`,
    [documentId],
  )
  return rows.map((row) => row.id)
}

/** A deleted item: filed, then deleted by the owner on their own session. */
async function deletedItem(mail: { emailId?: string; attachmentId?: string } = {}): Promise<{ itemId: string; documentId: string; before: Record<string, unknown> }> {
  const documentId = await document()
  const itemId = await inboxItem(documentId, mail)
  const before = (await itemRow(itemId))!
  expect(await deleteInboxItem(as(ownerId, companyId), itemId)).toMatchObject({ ok: true, data: { id: itemId, deleted: true } })
  expect(await itemRow(itemId)).toBeNull()
  // The decision the deletion wrote keeps the row.
  expect(await keptCopies(documentId)).toEqual([itemId])
  return { itemId, documentId, before }
}

const removedIds = async (ctx: OperationContext): Promise<string[]> => {
  const outcome = await listRemovedInboxItems(ctx)
  if (!outcome.ok || outcome.dryRun) throw new Error(`list failed: ${JSON.stringify(outcome)}`)
  return outcome.data.removed_items.map((row) => row.inbox_item_id)
}

describe('a deleted inbox item is put back from the copy its deletion kept', () => {
  it('lists it with its file, reading, who and when, and puts it back as it was', async () => {
    const { itemId, documentId, before } = await deletedItem()

    const listed = await listRemovedInboxItems(as(ownerId, companyId))
    if (!listed.ok || listed.dryRun) throw new Error(`list failed: ${JSON.stringify(listed)}`)
    const row = listed.data.removed_items.find((r) => r.inbox_item_id === itemId)
    expect(row).toMatchObject({
      inbox_item_id: itemId,
      document_id: documentId,
      file_name: 'faktura-augusti.pdf',
      vendor_name: 'Nordisk Kontorsservice AB',
      amount: 1250,
      currency: 'SEK',
      email_from: 'faktura@example.test',
      email_subject: 'Faktura F-1001',
      removed_by: { actor_type: 'user', user_id: ownerId },
    })
    expect(Date.now() - new Date(row!.removed_at).getTime()).toBeLessThan(60_000)

    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toEqual({
      ok: true,
      data: { id: itemId, document_id: documentId, restored: true },
    })

    // The same row: its id, its reading (the document has none to stand in), its mail and its arrival time,
    // so usage (which counts read documents by created_at) keeps it in August and adds nothing to this month.
    expect(await itemRow(itemId)).toEqual(before)
    expect((before.created_at as Date).toISOString()).toBe(ARRIVED)
    expect(vi.mocked(proposeBankMatchForInboxItem)).toHaveBeenCalledWith(expect.anything(), companyId, itemId, expect.anything())
    // Back in the inbox, so no longer among the deleted.
    expect(await removedIds(as(ownerId, companyId))).not.toContain(itemId)
  })

  it('happens once: again, and twice at the same time, leave one item', async () => {
    const first = await deletedItem()
    expect(await restoreInboxItem(as(ownerId, companyId), first.itemId)).toMatchObject({ ok: true })
    expect(await restoreInboxItem(as(ownerId, companyId), first.itemId)).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(await itemsOfDocument(first.documentId)).toBe(1)

    const second = await deletedItem()
    const outcomes = await Promise.all([
      restoreInboxItem(as(ownerId, companyId), second.itemId),
      restoreInboxItem(as(ownerId, companyId), second.itemId),
    ])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.ok)).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(await itemsOfDocument(second.documentId)).toBe(1)
  })

  it('deleted a second time, it is put back from the later copy', async () => {
    const { itemId, documentId } = await deletedItem()
    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toMatchObject({ ok: true })
    await getPool().query(`UPDATE public.invoice_inbox_items SET email_subject = 'Rättad efter att den lades tillbaka' WHERE id = $1`, [itemId])
    expect(await deleteInboxItem(as(ownerId, companyId), itemId)).toMatchObject({ ok: true })
    expect(await keptCopies(documentId)).toEqual([itemId, itemId])

    // One row for the document in the list, and the later copy is what comes back.
    expect((await removedIds(as(ownerId, companyId))).filter((id) => id === itemId)).toHaveLength(1)
    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toMatchObject({ ok: true })
    expect((await itemRow(itemId))?.email_subject).toBe('Rättad efter att den lades tillbaka')
  })

  it('is refused when the same mail was delivered again meanwhile: the key it is recognised by is taken', async () => {
    const { itemId, documentId } = await deletedItem({ emailId: 'mail-redelivered', attachmentId: 'att-7' })
    // The redelivery filed a new item, on a new document, under the same mail and attachment ids.
    const redelivered = await inboxItem(await document('faktura-augusti-igen.pdf'), { emailId: 'mail-redelivered', attachmentId: 'att-7' })

    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(await itemRow(itemId)).toBeNull()
    expect(await itemsOfDocument(documentId)).toBe(0)
    expect(await itemRow(redelivered)).not.toBeNull()
  })

  it('is refused, and no longer listed, once a verifikat holds its document', async () => {
    const { itemId, documentId } = await deletedItem()
    const journalEntryId = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId })
    await getPool().query(`UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`, [journalEntryId, documentId])

    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toEqual({
      ok: false,
      code: 'INBOX_ITEM_RESTORE_BOOKED',
      details: { journal_entry_id: journalEntryId },
    })
    expect(await itemRow(itemId)).toBeNull()
    expect(await removedIds(as(ownerId, companyId))).not.toContain(itemId)
  })

  it('lets a viewer read the list and refuses their restore; a member of another company sees nothing', async () => {
    const { itemId } = await deletedItem()

    expect(await removedIds(as(viewerId, companyId))).toContain(itemId)
    // The door refuses a viewer before this; the database refuses the row behind it.
    expect(await restoreInboxItem(as(viewerId, companyId), itemId)).toMatchObject({ ok: false })
    expect(await itemRow(itemId)).toBeNull()

    // Even naming the company: its decisions are not theirs to read.
    expect(await removedIds(as(strangerId, companyId))).toEqual([])
    expect(await restoreInboxItem(as(strangerId, companyId), itemId)).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
    expect(await itemRow(itemId)).toBeNull()

    // Still there for someone who may write.
    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toMatchObject({ ok: true })
  })

  it('has nothing to put back once the document is deleted from the archive: the copy leaves with it', async () => {
    const { itemId, documentId } = await deletedItem()
    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])

    expect(await keptCopies(documentId)).toEqual([])
    expect(await removedIds(as(ownerId, companyId))).not.toContain(itemId)
    expect(await restoreInboxItem(as(ownerId, companyId), itemId)).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
  })
})

describe('suggestion_log.removed_item', () => {
  const insert = (documentId: string, outcome: string, final: string | null, removedItem: string, kind = 'inbox_item') =>
    getPool().query(
      `INSERT INTO public.suggestion_log (company_id, kind, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, removed_item)
       VALUES ($1, $2, $3, '[]'::jsonb, NULL, $4::jsonb, $5, 'user', $6, $7::jsonb)`,
      [companyId, kind, documentId, final, outcome, ownerId, removedItem],
    )

  it('is carried only by the decision that deleted an inbox item, as a row', async () => {
    const documentId = await document()
    const item = JSON.stringify({ id: randomUUID(), document_id: documentId })

    await expect(insert(documentId, 'dismissed', null, item)).resolves.toMatchObject({ rowCount: 1 })
    // A booking keeps no item, and neither does anything that is not a row.
    await expect(insert(documentId, 'manual', '{}', item)).rejects.toThrow(/suggestion_log_removed_item/)
    await expect(insert(documentId, 'dismissed', null, '"not a row"')).rejects.toThrow(/suggestion_log_removed_item/)
    await expect(insert(documentId, 'dismissed', null, '[]')).rejects.toThrow(/suggestion_log_removed_item/)
  })

  it('has the index the list and the restore read through', async () => {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_suggestion_log_removed_items'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(/\(company_id, created_at DESC\) WHERE \(removed_item IS NOT NULL\)/)
  })
})
