import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction, type InboxSnapshot } from '../inbox'

const mockGetActor = vi.fn()
vi.mock('@/lib/bookkeeping/actor-context', () => ({
  getActor: () => mockGetActor(),
}))

/** A client answering one maybeSingle read per table and recording inserts. */
function fakeClient(reads: Record<string, { data: unknown; error?: { message: string } | null }> = {}, insertError?: string) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const chain = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => reads[table] ?? { data: null, error: null },
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return { error: insertError ? { message: insertError } : null }
      },
    }
    return q
  }
  return { client: { from: chain }, inserts }
}

const reading = { supplier: { name: 'Telia' }, invoice: { invoiceNumber: 'F-1' }, totals: { total: 500 }, confidence: 0.9 }
const edited = { ...reading, invoice: { invoiceNumber: 'F-2' } }

beforeEach(() => {
  vi.clearAllMocks()
  mockGetActor.mockReturnValue(undefined)
})

describe('snapshotInboxExtraction', () => {
  it("takes the document's reading (the model's own) over the item's edited one", async () => {
    const { client } = fakeClient({ document_attachments: { data: { extracted_data: reading, extraction_model: 'claude-sonnet' } } })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toEqual({ companyId: 'company-1', inboxItemId: 'item-1', documentId: 'doc-1', extraction: reading, model: 'claude-sonnet' })
  })

  it('falls back to the item when the document was never read (skipped or failed)', async () => {
    const { client } = fakeClient({ document_attachments: { data: { extracted_data: null, extraction_model: 'skipped:no_ai' } } })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toMatchObject({ extraction: edited, model: null })
  })

  it('never throws on a failed read', async () => {
    const { client } = fakeClient({ document_attachments: { data: null, error: { message: 'timeout' } } })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: null })

    expect(snap.extraction).toBeNull()
  })
})

describe('recordInboxDecision', () => {
  const snap: InboxSnapshot = { companyId: 'company-1', inboxItemId: 'item-1', documentId: 'doc-1', extraction: reading, model: 'claude-sonnet' }

  it('writes an inbox_item row for the registration, as the deciding user', async () => {
    const { client, inserts } = fakeClient()

    await recordInboxDecision(client as never, snap, {
      supplier_invoice_id: 'si-1',
      journal_entry_id: 'je-1',
      fields: { supplier_name: 'Telia', invoice_number: 'F-2', total: 500 },
      lines: [{ account: '6212', debit: 400, credit: 0 }, { account: '2641', debit: 100, credit: 0 }, { account: '2440', debit: 0, credit: 500 }],
    }, 'user-1')

    expect(inserts[0]).toMatchObject({
      table: 'suggestion_log',
      row: {
        company_id: 'company-1',
        kind: 'inbox_item',
        inbox_item_id: 'item-1',
        document_id: 'doc-1',
        acted_on: 0,
        outcome: 'changed',
        actor_type: 'user',
        resolved_by: 'user-1',
        final: { supplier_invoice_id: 'si-1', journal_entry_id: 'je-1', changed_fields: ['invoice_number'], fields: { accounts: ['6212'] } },
      },
    })
  })

  it('records a deletion against the document only, so the row outlives the item', async () => {
    const { client, inserts } = fakeClient()

    await recordInboxDecision(client as never, snap, null, 'user-1')

    expect(inserts[0].row).toMatchObject({ inbox_item_id: null, document_id: 'doc-1', outcome: 'dismissed', final: null, acted_on: null })
  })

  it('records nothing for a deleted item without a document: no row could outlive it', async () => {
    const { client, inserts } = fakeClient()

    await recordInboxDecision(client as never, { ...snap, documentId: null }, null, 'user-1')

    expect(inserts).toEqual([])
  })

  it('never throws: a refused insert is logged and the booking stands', async () => {
    const { client } = fakeClient({}, 'permission denied')

    await expect(recordInboxDecision(client as never, snap, { fields: {} }, 'user-1')).resolves.toBeUndefined()
  })
})

describe('loadEntryLines', () => {
  it("reads the verifikat's lines through the company-scoped entry", async () => {
    const { client } = fakeClient({
      journal_entries: { data: { lines: [{ account_number: '6212', debit_amount: '400.00', credit_amount: 0 }] } },
    })

    expect(await loadEntryLines(client as never, 'company-1', 'je-1')).toEqual([{ account: '6212', debit: 400, credit: 0 }])
  })

  it('answers no lines without an entry, or when the read fails', async () => {
    const failing = fakeClient({ journal_entries: { data: null, error: { message: 'timeout' } } })
    expect(await loadEntryLines(failing.client as never, 'company-1', 'je-1')).toEqual([])
    expect(await loadEntryLines(failing.client as never, 'company-1', null)).toEqual([])
  })
})
