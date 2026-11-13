import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction, type InboxSnapshot } from '../inbox'
import { inboxInputHash } from '../provenance'
import { passed } from '../checks'

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
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const SHA = 'e'.repeat(64)

describe('snapshotInboxExtraction', () => {
  it("takes the document's reading (the model's own) over the item's edited one, with the rules and inputs it is decided on", async () => {
    const { client } = fakeClient({
      document_attachments: { data: { extracted_data: reading, extraction_model: 'claude-sonnet', sha256_hash: SHA } },
    })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toEqual({
      companyId: 'company-1',
      inboxItemId: 'item-1',
      documentId: 'doc-1',
      extraction: reading,
      model: 'claude-sonnet',
      ruleVersion: 'inbox-extraction.1',
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it("hashes the document's bytes in: the same reading on another file is another input", async () => {
    const hashWith = async (sha: string) =>
      (await snapshotInboxExtraction(
        fakeClient({ document_attachments: { data: { extracted_data: reading, extraction_model: 'claude-sonnet', sha256_hash: sha } } }).client as never,
        'company-1',
        { id: 'item-1', document_id: 'doc-1' },
      )).inputHash

    expect(await hashWith(SHA)).toBe(await hashWith(SHA))
    expect(await hashWith(SHA)).not.toBe(await hashWith('f'.repeat(64)))
  })

  it('hashes an item without a document over its own reading', async () => {
    const { client } = fakeClient()

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: null, extracted_data: edited })

    expect(snap).toMatchObject({ extraction: edited, ruleVersion: 'inbox-extraction.1', inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('falls back to the item when the document was never read (skipped or failed)', async () => {
    const { client } = fakeClient({ document_attachments: { data: { extracted_data: null, extraction_model: 'skipped:no_ai' } } })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toMatchObject({ extraction: edited, model: null })
  })

  it("takes the kept model reading over a document a person's correction was mirrored onto", async () => {
    const { client } = fakeClient({
      document_attachments: {
        data: {
          extracted_data: edited,
          extraction_model: 'claude-sonnet',
          extracted_at: '2026-10-01T08:00:00.000Z',
          model_reading: { extracted_data: reading, extraction_model: 'claude-sonnet', extracted_at: '2026-10-01T08:00:00.000Z' },
        },
      },
    })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toMatchObject({ extraction: reading, model: 'claude-sonnet' })
  })

  it('ignores a kept reading a newer extraction replaced', async () => {
    const fresh = { ...reading, totals: { total: 510 } }
    const { client } = fakeClient({
      document_attachments: {
        data: {
          extracted_data: fresh,
          extraction_model: 'gemma',
          extracted_at: '2026-10-02T08:00:00.000Z',
          model_reading: { extracted_data: reading, extraction_model: 'claude-sonnet', extracted_at: '2026-10-01T08:00:00.000Z' },
        },
      },
    })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: edited })

    expect(snap).toMatchObject({ extraction: fresh, model: 'gemma' })
  })

  it('never throws on a failed read, and then records no inputs hash: the document is unknown', async () => {
    const { client } = fakeClient({ document_attachments: { data: null, error: { message: 'timeout' } } })

    const snap = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1', extracted_data: null })

    expect(snap.extraction).toBeNull()
    expect(snap.inputHash).toBeNull()
  })
})

describe('recordInboxDecision', () => {
  const snap: InboxSnapshot = {
    companyId: 'company-1',
    inboxItemId: 'item-1',
    documentId: 'doc-1',
    extraction: reading,
    model: 'claude-sonnet',
    ruleVersion: 'inbox-extraction.1+a38016f12abc',
    inputHash: 'a'.repeat(64),
  }

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
        rule_version: 'inbox-extraction.1+a38016f12abc',
        input_hash: 'a'.repeat(64),
        checks: null,
        pending_operation_id: null,
      },
    })
    // No approval policy decides an underlag, so neither a policy nor a band is written.
    expect(inserts[0].row).not.toHaveProperty('policy_version')
    expect(inserts[0].row).not.toHaveProperty('confidence_band')
  })

  it('stamps the trace id of the request that recorded the decision, and none outside a request scope', async () => {
    const { client, inserts } = fakeClient()
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'

    await runWithTrace(traceId, () =>
      recordInboxDecision(client as never, snap, { supplier_invoice_id: 'si-1', fields: {} }, 'user-1'),
    )
    await recordInboxDecision(client as never, snap, { supplier_invoice_id: 'si-1', fields: {} }, 'user-1')

    expect(inserts[0].row).toMatchObject({ trace_id: traceId })
    expect(inserts[1].row).not.toHaveProperty('trace_id')
  })

  it('records the guards the door ran and the operation whose approval carried the decision', async () => {
    const { client, inserts } = fakeClient()
    const checks = [passed('already_booked'), passed('period_lock')]

    await runInOperationCommit('op-7', () =>
      recordInboxDecision(client as never, snap, { supplier_invoice_id: 'si-1', fields: {} }, 'user-1', checks),
    )

    expect(inserts[0].row).toMatchObject({ checks, pending_operation_id: 'op-7' })
    expect(inserts[0].row).not.toHaveProperty('agent_reason')
  })

  it("copies the approved operation's agent_reason onto the underlag decision", async () => {
    const { client, inserts } = fakeClient()

    await runInOperationCommit(
      'op-7',
      () => recordInboxDecision(client as never, snap, { supplier_invoice_id: 'si-1', fields: {} }, 'user-1'),
      'Telia invoice, same supplier and amount as the bank line on the 3rd.',
    )

    expect(inserts[0].row).toMatchObject({
      pending_operation_id: 'op-7',
      agent_reason: 'Telia invoice, same supplier and amount as the bank line on the 3rd.',
    })
  })

  it('lets an auditor recompute the inputs hash from the recorded row and the document', async () => {
    const { client } = fakeClient({ document_attachments: { data: { extracted_data: reading, extraction_model: 'claude-sonnet', sha256_hash: SHA } } })
    const taken = await snapshotInboxExtraction(client as never, 'company-1', { id: 'item-1', document_id: 'doc-1' })
    const recorder = fakeClient()

    await recordInboxDecision(recorder.client as never, taken, { supplier_invoice_id: 'si-1', fields: { invoice_number: 'F-1' } }, 'user-1')

    const row = recorder.inserts[0].row as { input_hash: string; document_id: string; suggestions: Array<Record<string, unknown>> }
    expect(row.input_hash).toBe(inboxInputHash({
      documentId: row.document_id,
      documentSha256: SHA,
      suggestions: row.suggestions.map(({ matches_final: _matched, ...offered }) => offered) as never,
    }))
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

describe('recordInboxDecision: the document was deleted meanwhile', () => {
  const DOCUMENT_GONE = {
    code: '23503',
    message: 'insert or update on table "suggestion_log" violates foreign key constraint "suggestion_log_document_id_fkey"',
  }
  const gone: InboxSnapshot = { companyId: 'company-1', inboxItemId: 'item-1', documentId: 'doc-1', extraction: reading, model: null }

  /** Refuses each insert that names a document with `refusal`; records every attempt. */
  function refusingClient(refusal: { code?: string; message: string }) {
    const inserts: Array<Record<string, unknown>> = []
    const client = {
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row)
          return { error: row.document_id ? refusal : null }
        },
      }),
    }
    return { client, inserts }
  }

  it('keeps a booking decision, on its inbox item alone', async () => {
    const { client, inserts } = refusingClient(DOCUMENT_GONE)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await recordInboxDecision(client as never, gone, { supplier_invoice_id: 'si-1', fields: { supplier_name: 'Telia' } }, 'user-1')

    expect(inserts).toHaveLength(2)
    expect(inserts[0]).toMatchObject({ inbox_item_id: 'item-1', document_id: 'doc-1' })
    expect(inserts[1]).toMatchObject({ inbox_item_id: 'item-1', document_id: null, final: { supplier_invoice_id: 'si-1' } })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('writes no second row for a dismissal, and reports no failure: the row would leave with its document', async () => {
    const { client, inserts } = refusingClient(DOCUMENT_GONE)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await recordInboxDecision(client as never, gone, null, 'user-1')

    expect(inserts).toHaveLength(1)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('does not retry any other refusal, another foreign key included', async () => {
    const other = refusingClient({ code: '23503', message: 'violates foreign key constraint "suggestion_log_inbox_item_id_fkey"' })
    const denied = refusingClient({ code: '42501', message: 'permission denied' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await recordInboxDecision(other.client as never, gone, { fields: {} }, 'user-1')
    await recordInboxDecision(denied.client as never, gone, { fields: {} }, 'user-1')

    expect(other.inserts).toHaveLength(1)
    expect(denied.inserts).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
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
