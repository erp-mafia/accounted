/**
 * The one reading of an open inbox item over a real PostgREST: the embed that
 * says whether a verifikat holds the document, and the filters beside it, are
 * PostgREST's grammar, which no mock can vouch for. The rest of the readers run
 * on real Postgres in tests/pg/inbox-item-open-doors.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fetchOverviewRowsForCompanies } from '@/lib/clients/fetch-client-overview'
import { readInboxItemBookingState } from '@/lib/documents/inbox-item-claim'
import { listInboxItemsPage } from '@/lib/documents/inbox-item-actions'
import { INBOX_ITEM_DOCUMENT_HOLD, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import type { OperationContext } from '@/lib/operations/types'
import { findUnderlagCandidates } from '@/lib/agent-context/underlag-candidates'
import { countInboxDocuments } from '@/lib/worklist/categories'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

const log = { debug() {}, info() {}, warn() {}, error() {} } as never
const supabase = createToolPgClient()

let companyId: string
let userId: string
let fiscalPeriodId: string
let open: string
let held: string
let heldBy: string
let reversed: string
let routed: string

async function document(journalEntryId: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type, journal_entry_id)
     VALUES ($1, $2, $3, $4, 'kvitto.pdf', $5, 'application/pdf', $6)`,
    [id, companyId, userId, `${companyId}/${id}.pdf`, `sha-${id}`, journalEntryId],
  )
  return id
}

async function item(documentId: string, routedAt: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data, routed_to_arkiv_at)
     VALUES ($1, $2, $3, $4, 'received', 'upload', $5, $6)`,
    [id, companyId, userId, documentId, JSON.stringify({ supplier: { name: 'Butiken AB' }, invoice: { invoiceDate: '2026-03-02', currency: 'SEK' }, totals: { total: 500 } }), routedAt],
  )
  return id
}

const entry = (description: string) =>
  insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-03-02',
    description,
    lines: [
      { accountNumber: '6110', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
    ],
  })

beforeAll(async () => {
  ;({ userId, companyId, fiscalPeriodId } = await seedCompany())
  await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, company_name) VALUES ($1, $2, 'Bolaget AB')`, [userId, companyId])
  heldBy = await entry('Håller dokumentet')
  const spent = await entry('Återförd')
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [spent])
  open = await item(await document())
  held = await item(await document(heldBy))
  reversed = await item(await document(spent))
  routed = await item(await document(), '2026-03-03T10:00:00Z')
})

describe('the document hold', () => {
  it('the embed reads a live verifikat as holding the document and a reversed one as not', async () => {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select(`id, ${INBOX_ITEM_DOCUMENT_HOLD}`)
      .eq('company_id', companyId)
    expect(error).toBeNull()
    const rows = (data as unknown as Array<DocumentHoldRow & { id: string }>).map((row) => withDocumentHold(row))
    const byId = new Map(rows.map((row) => [row.id, row.document_journal_entry_id]))
    expect(byId.get(held)).toBe(heldBy)
    expect(byId.get(reversed)).toBeNull()
    expect(byId.get(open)).toBeNull()
    expect(byId.get(routed)).toBeNull()
  })

  it('a booking door reads the same hold', async () => {
    await expect(readInboxItemBookingState(supabase, companyId, held)).resolves.toEqual({ state: 'booked', journal_entry_id: heldBy, supplier_invoice_id: null })
    await expect(readInboxItemBookingState(supabase, companyId, reversed)).resolves.toEqual({
      state: 'open',
      replaces: null,
      // The underlag rides along, so the voucher executor can run the FX check.
      extracted_data: expect.objectContaining({ totals: { total: 500 } }),
      // The item's own document, which a door that books the item links.
      document_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })
})

describe('the counts and the lists over a real PostgREST', () => {
  it('Hem and the client overview count the same two documents', async () => {
    await expect(countInboxDocuments(supabase, companyId)).resolves.toBe(2)
    const [row] = await fetchOverviewRowsForCompanies(supabase, [{ id: companyId, name: 'Bolaget AB', org_number: null }])
    expect(row!.inboxCount).toBe(2)
  })

  it('v1 unprocessed_only lists the open items', async () => {
    const page = await listInboxItemsPage({ supabase, companyId, userId, log } as OperationContext, { unprocessed_only: 'true' })
    if (!page.ok || page.dryRun) throw new Error('list refused')
    expect(page.data.inbox_items.map((row) => row.inbox_item_id).sort()).toEqual([open, reversed].sort())
  })

  it('the agent candidates filter on the document in SQL', async () => {
    const candidates = await findUnderlagCandidates(supabase, companyId, {
      id: 'tx',
      date: '2026-03-02',
      description: 'Butiken',
      merchant_name: 'Butiken AB',
      amount: -500,
      currency: 'SEK',
    })
    expect(candidates.map((candidate) => candidate.inbox_item_id)).toEqual([open])
  })
})
