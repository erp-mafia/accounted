/**
 * Stage-time behaviour of gnubok_attach_document_to_transaction, generated
 * from the operation transactions.attach-document: the staging dry run is
 * attachDocumentToTransaction's own (lib/transactions/document-attach.ts),
 * so a pairing the approval would refuse is refused before anything is
 * staged. The hand-written tool staged it and the approval failed. The
 * preview keeps AttachDocumentPreview's shape, the period status is read
 * for the transaction date, and a document someone else already holds
 * carries the shared-document warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

// The real check by default; a case below makes it answer a mismatch.
const fit = vi.hoisted(() => ({ gate: vi.fn() }))
vi.mock('@/lib/documents/bank-match/fit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/bank-match/fit')>()
  fit.gate.mockImplementation(actual.documentFitGate)
  return { ...actual, documentFitGate: fit.gate }
})

import { tools } from '../server'
import { findUnknownArgKeys, listArgKeys } from '../arg-guard'
import { toToolError } from '../tool-result'
import { ALL_OPERATIONS } from '@/lib/operations/registry'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const tool = tools.find((t) => t.name === 'gnubok_attach_document_to_transaction')!

const TX = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b'
const DOC = '4f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b'

const TX_ROW = {
  id: TX,
  document_id: null,
  journal_entry_id: null,
  description: 'KORTKÖP 0412',
  merchant_name: 'Clas Ohlson',
  amount: -499,
  currency: 'SEK',
  date: '2026-04-12',
}
const DOC_ROW = { id: DOC, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: null }

type Staged = {
  staged: boolean
  dry_run?: boolean
  message: string
  preview: Record<string, unknown>
  period_status?: Record<string, unknown>
  next?: Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

const READING = {
  data: {
    extracted_data: {
      supplier: { name: 'Clas Ohlson AB' },
      invoice: { currency: 'SEK', invoiceDate: '2026-04-12' },
      totals: { total: 499 },
    },
  },
}

type Chain = Array<{ method: string; args: unknown[] }>
/** The read that asks which other rows the document's inbox item is matched to. */
const asksMatchedElsewhere = (chain: Chain) =>
  chain.some((c) => c.method === 'select' && c.args[0] === 'matched_transaction_id')

/** invoice_inbox_items by what is asked: the rows the item is matched to (none unless given), else its reading. */
const inboxItems = (matchedElsewhere: string[] = []) => (chain: Chain) =>
  asksMatchedElsewhere(chain) ? { data: matchedElsewhere.map((id) => ({ matched_transaction_id: id })) } : READING

function db(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    transactions: [{ data: TX_ROW }, { data: [] }], // the transaction; then nobody else holds the document
    document_attachments: { data: DOC_ROW },
    invoice_inbox_items: inboxItems(),
    pending_operations: [{ data: [] }, { data: { id: 'op-attach-1' } }], // no waiting link proposal; then the insert
    ...(overrides as Record<string, never>),
  })
}

describe('gnubok_attach_document_to_transaction: registration', () => {
  it('stays in tools/list with the same input and an idempotent staged write', () => {
    expect(tool.catalogVisibility).toBe('default')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual([
      'document_id', 'dry_run', 'idempotency_key', 'mismatch_reason', 'reason', 'transaction_id',
    ])
    // Listed with the operation's own bound, never accepted unlisted: a
    // client that validates against this schema (additionalProperties:
    // false) could not follow DOC_ROW_MISMATCH's remediation (crm#1742).
    expect(schema.properties.mismatch_reason).toMatchObject({ type: 'string', maxLength: 300 })
    expect(tool.undeclaredArgs ?? []).not.toContain('mismatch_reason')
    expect([...(schema.required ?? [])].sort()).toEqual(['document_id', 'transaction_id'])
  })

  // crm#1742: the refusal's remediation says "call again with
  // mismatch_reason"; every tool that can refuse that way must list it.
  it('lists mismatch_reason on every tool that can refuse with DOC_ROW_MISMATCH', () => {
    const refusing = ALL_OPERATIONS.filter((op) => op.mcp && op.errorCodes?.includes('DOC_ROW_MISMATCH'))
    expect(refusing.map((op) => op.mcp!.name)).toContain('gnubok_attach_document_to_transaction')
    for (const op of refusing) {
      const listed = tools.find((t) => t.name === op.mcp!.name)!
      expect(listArgKeys(listed.inputSchema), op.mcp!.name).toContain('mismatch_reason')
      expect(
        findUnknownArgKeys(listed.inputSchema, { mismatch_reason: 'One invoice paid in two card charges' }),
        op.mcp!.name,
      ).toEqual([])
    }
  })
})

describe('gnubok_attach_document_to_transaction: staging', () => {
  it('previews both sides of the pairing in AttachDocumentPreview\'s shape', async () => {
    const { supabase, findCalls } = db()
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.dry_run).toBe(true)
    expect(result.preview).toEqual({
      transaction_description: 'Clas Ohlson',
      transaction_amount: -499,
      transaction_currency: 'SEK',
      transaction_date: '2026-04-12',
      document_file_name: 'kvitto.pdf',
      document_mime_type: 'application/pdf',
      document_vendor_name: 'Clas Ohlson AB',
      document_amount: 499,
      document_currency: 'SEK',
      document_invoice_date: '2026-04-12',
      will_overwrite_existing: false,
      adds_to_existing: false,
      adds_to_verifikat: false,
      existing_document_id: null,
      existing_document_file_name: null,
      existing_document_is_rakenskapsinformation: false,
    })
    // The period status is read for the transaction date.
    expect(findCalls('fiscal_periods', 'lte')).toContainEqual(['period_start', '2026-04-12'])
    expect(result.next).toMatchObject({ tool: 'gnubok_categorize_transaction', args: { transaction_id: TX } })
    // Nobody else holds the document: nothing is said about a move.
    expect(result.next?.description).toMatch(/^Once approved, the receipt is linked to the transaction\. /)
  })

  it('stages with the title the approver reads and the bare input as params', async () => {
    const { supabase, findCalls } = db()
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      operation_type: 'attach_document_to_transaction',
      title: 'Koppla bilaga: kvitto.pdf → Clas Ohlson',
      params: { transaction_id: TX, document_id: DOC },
    })
  })

  it('names the replaced document when the transaction already has another pinned', async () => {
    const { supabase } = db({
      transactions: [{ data: { ...TX_ROW, document_id: 'a0a0a0a0-0000-4000-8000-000000000001' } }, { data: [] }],
      document_attachments: [{ data: { journal_entry_id: null, file_name: 'gammalt.pdf' } }, { data: DOC_ROW }],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview).toMatchObject({
      will_overwrite_existing: true,
      adds_to_existing: false,
      existing_document_id: 'a0a0a0a0-0000-4000-8000-000000000001',
      existing_document_file_name: 'gammalt.pdf',
      existing_document_is_rakenskapsinformation: false,
    })
  })

  // crm#1479 follow-up: the pinned document came from the inbox and its item
  // is matched to the row, so the booking links it too. The preview said
  // "Ersätter" while both stayed; it now says the new one is added.
  it('says the document is added, not overwriting, when the pinned one stays underlag through its inbox item', async () => {
    const PREVIOUS = 'a0a0a0a0-0000-4000-8000-000000000001'
    const { supabase, findCalls } = db({
      transactions: [{ data: { ...TX_ROW, document_id: PREVIOUS } }, { data: [] }],
      document_attachments: [{ data: { journal_entry_id: null, file_name: 'faktura-1.pdf' } }, { data: DOC_ROW }],
      invoice_inbox_items: (chain: Chain) =>
        asksMatchedElsewhere(chain)
          ? { data: [] }
          : chain.some((c) => c.method === 'eq' && c.args[0] === 'matched_transaction_id')
            ? { data: [{ id: 'item-previous' }] }
            : { data: { extracted_data: { supplier: { name: 'Clas Ohlson AB' }, totals: { total: 499 } } } },
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview).toMatchObject({
      will_overwrite_existing: false,
      adds_to_existing: true,
      existing_document_id: PREVIOUS,
      existing_document_file_name: 'faktura-1.pdf',
    })
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['document_id', PREVIOUS])
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['matched_transaction_id', TX])
  })

  it('refuses at staging a document that is already underlag of another verifikat (the hand-written tool staged it)', async () => {
    const { supabase } = db({
      document_attachments: { data: { ...DOC_ROW, journal_entry_id: 'b0b0b0b0-0000-4000-8000-000000000002' } },
      transaction_voucher_links: { data: [] },
    })
    await expect(
      tool.execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      // An unbooked row has no verifikat to link a copy to yet: the ids, no call.
      details: {
        journal_entry_id: 'b0b0b0b0-0000-4000-8000-000000000002',
        document_id: DOC,
        transaction_journal_entry_id: null,
      },
    })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  // crm#1813: one statement covering two fees, each its own verifikat. The
  // refusal named only the verifikat that held the document, so the agent
  // could not follow the remedy (a link with copy: true on ITS verifikat)
  // and altered a byte of the file to get a second document instead.
  it('names the row\'s own verifikat and the copy link to it when the row is booked', async () => {
    const HELD_BY = 'b0b0b0b0-0000-4000-8000-000000000002'
    const ROW_ENTRY = 'c0c0c0c0-0000-4000-8000-000000000003'
    const { supabase } = db({
      transactions: [{ data: { ...TX_ROW, journal_entry_id: ROW_ENTRY } }, { data: [] }],
      document_attachments: { data: { ...DOC_ROW, journal_entry_id: HELD_BY } },
      transaction_voucher_links: { data: [] },
    })
    const refusal = await tool
      .execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never)
      .then(() => null, (e: unknown) => e)

    expect(refusal).toMatchObject({
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      details: {
        journal_entry_id: HELD_BY,
        document_id: DOC,
        transaction_journal_entry_id: ROW_ENTRY,
        next: {
          tool: 'gnubok_link_document_to_voucher',
          args: { document_id: DOC, journal_entry_id: ROW_ENTRY, copy: true },
        },
      },
    })
    // The envelope the agent reads carries the details, not only the code.
    const envelope = toToolError(refusal).error
    expect(envelope.details).toMatchObject({
      transaction_journal_entry_id: ROW_ENTRY,
      next: { args: { document_id: DOC, journal_entry_id: ROW_ENTRY, copy: true } },
    })
    expect(envelope.remediation?.description).toContain('details.next')
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('refuses at staging replacing a pinned document that is räkenskapsinformation of another verifikat than the row\'s', async () => {
    const { supabase } = db({
      transactions: { data: { ...TX_ROW, document_id: 'a0a0a0a0-0000-4000-8000-000000000001' } },
      document_attachments: { data: { journal_entry_id: 'b0b0b0b0-0000-4000-8000-000000000002', file_name: 'gammalt.pdf' } },
      transaction_voucher_links: { data: [] },
    })
    await expect(
      tool.execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DOC_ATTACH_REPLACES_POSTED' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  // #248: the attach was staged and approved, and only the approval refused.
  it('refuses at staging a booked row whose verifikat is in a locked year, with the document answer and its next step', async () => {
    const ENTRY = 'b0b0b0b0-0000-4000-8000-000000000002'
    const { supabase } = db({
      transactions: [{ data: { ...TX_ROW, journal_entry_id: ENTRY } }, { data: [] }],
      journal_entries: { data: [{ id: ENTRY, fiscal_period: { is_closed: true, locked_at: null } }] },
    })
    const refusal = await tool
      .execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never)
      .then(() => null, (e: unknown) => e)

    const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
    expect(refusal).toMatchObject({ code: 'PERIOD_LOCKED', message: answer.message_sv, details: { journal_entry_id: ENTRY } })
    expect(toToolError(refusal).error.remediation?.description).toBe(answer.remediation!.description)
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('stages a further document for a booked row as one more underlag of its verifikat, beside the pin', async () => {
    const PREVIOUS = 'a0a0a0a0-0000-4000-8000-000000000001'
    const ENTRY = 'b0b0b0b0-0000-4000-8000-000000000002'
    const { supabase, findCalls } = db({
      transactions: [{ data: { ...TX_ROW, document_id: PREVIOUS, journal_entry_id: ENTRY } }, { data: [] }],
      document_attachments: [{ data: { journal_entry_id: ENTRY, file_name: 'kvitto-1.pdf' } }, { data: DOC_ROW }],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      preview_data: expect.objectContaining({
        will_overwrite_existing: false,
        adds_to_existing: true,
        adds_to_verifikat: true,
        existing_document_id: PREVIOUS,
        existing_document_file_name: 'kvitto-1.pdf',
        existing_document_is_rakenskapsinformation: true,
      }),
    })
  })

  // crm#1479: a file of another seller, larger than the row, became underlag
  // on the row's verifikat. The staging dry run compares both sides.
  const MISMATCH = {
    document_vendor: 'Synthetic AI Ltd',
    document_amount: 90,
    document_currency: 'EUR',
    document_amount_sek: 1029.6,
    transaction_text: 'KORTKÖP 0412',
    transaction_amount: -499,
    transaction_currency: 'SEK',
  }

  it('refuses at staging a document that plainly belongs to another purchase, naming both sides', async () => {
    const check = vi.fn().mockResolvedValue({ code: 'DOC_ROW_MISMATCH', details: MISMATCH, messageSv: 'Underlaget verkar höra till ett annat köp' })
    fit.gate.mockReturnValueOnce(check)
    const { supabase } = db()
    await expect(
      tool.execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DOC_ROW_MISMATCH', details: MISMATCH })
    expect(fit.gate).toHaveBeenCalledWith(supabase, 'company-1', null, undefined)
    expect(check).toHaveBeenCalledWith(DOC, expect.objectContaining({ id: TX, amount: -499 }))
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('stages it when the agent states why it belongs, and shows the reason to the approver', async () => {
    const { supabase, findCalls } = db()
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, mismatch_reason: 'One invoice paid in two card charges' },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(fit.gate).toHaveBeenCalledWith(supabase, 'company-1', 'One invoice paid in two card charges', undefined)
    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      params: { transaction_id: TX, document_id: DOC, mismatch_reason: 'One invoice paid in two card charges' },
      preview_data: expect.objectContaining({ mismatch_reason: 'One invoice paid in two card charges' }),
    })
  })

  // crm#1950: the document sits on one bank row at a time. Attached to
  // another row it kept the first one too, whose booking then took it as
  // underlag; the warning invited approving both.
  it('says the document moves here when another unbooked transaction holds it, and names that transaction', async () => {
    const OTHER = 'c0c0c0c0-0000-4000-8000-000000000003'
    const { supabase, findCalls } = db({
      transactions: [{ data: TX_ROW }, { data: [{ id: OTHER, document_id: DOC }] }],
      invoice_inbox_items: inboxItems([OTHER]),
      bank_row_anchors: { data: [] }, // no verifikat books that transaction
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    const warning = result.preview.compliance_warning as string
    expect(warning).toMatch(/^Samma underlag är redan kopplat/)
    expect(warning).toContain('banktransaktion c0c0c0c0')
    expect(warning).toContain('flyttas underlaget hit')
    expect(warning).not.toMatch(/Godkänn båda/)
    // An invoice paid in parts gets a copy on the second verifikat instead.
    expect(warning).toContain('betalats i flera delar')
    expect(warning).toContain('exakt kopia')
    expect(result.message).toMatch(/WARNING: Samma underlag/)
    // The agent and the approver both read which transaction lets go.
    expect(result.preview.moves_from_transaction_ids).toEqual([OTHER])
    // tools/list is frozen, so the answer says it, not the listed description.
    expect(result.next?.description).toMatch(/^Once approved, the document moves here: the transactions in preview\.moves_from_transaction_ids /)
    expect(result.next).toMatchObject({ tool: 'gnubok_categorize_transaction', args: { transaction_id: TX } })
    expect(tool.description).not.toMatch(/moves/)
    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      preview_data: expect.objectContaining({ moves_from_transaction_ids: [OTHER] }),
    })
  })

  it('says the later approval gets the document when it is only proposed for another transaction', async () => {
    const { supabase } = db({
      pending_operations: [
        { data: [{ id: 'd0d0d0d0-0000-4000-8000-000000000004', params: { document_id: DOC, transaction_id: 'e0e0e0e0-0000-4000-8000-000000000005' } }] },
        { data: { id: 'op-attach-1' } },
      ],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    const warning = result.preview.compliance_warning as string
    expect(warning).toContain('förslag d0d0d0d0 (banktransaktion e0e0e0e0)')
    expect(warning).toContain('godkänns sist')
    expect(warning).not.toContain('flyttas underlaget hit')
    // Nothing holds it yet, so nothing is listed as leaving.
    expect(result.preview.moves_from_transaction_ids).toBeUndefined()
  })

  it('refuses at staging a document that a booked transaction holds, naming it and its verifikat', async () => {
    const OTHER = 'c0c0c0c0-0000-4000-8000-000000000003'
    const ITS_ENTRY = 'b0b0b0b0-0000-4000-8000-000000000002'
    const { supabase } = db({
      transactions: [{ data: TX_ROW }, { data: [{ id: OTHER }] }],
      bank_row_anchors: { data: [{ transaction_id: OTHER, journal_entry_id: ITS_ENTRY }] },
      transaction_voucher_links: { data: [] },
    })
    const refusal = await tool
      .execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never)
      .then(() => null, (e: unknown) => e)

    expect(refusal).toMatchObject({
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      details: { document_id: DOC, journal_entry_id: ITS_ENTRY, held_by_transaction_id: OTHER, transaction_journal_entry_id: null },
    })
    const envelope = toToolError(refusal).error
    expect(envelope.details).toMatchObject({ held_by_transaction_id: OTHER })
    expect(envelope.remediation?.description).toContain('details.held_by_transaction_id')
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('does not invite approving both when a waiting proposal links the document to a verifikat (crm#1158)', async () => {
    const { supabase } = db({
      pending_operations: [
        { data: [{ id: 'd0d0d0d0-0000-4000-8000-000000000004', params: { document_id: DOC, journal_entry_id: 'e0e0e0e0-0000-4000-8000-000000000005' } }] },
        { data: { id: 'op-attach-1' } },
      ],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    const warning = result.preview.compliance_warning as string
    expect(warning).toContain('förslag d0d0d0d0 (verifikat e0e0e0e0)')
    expect(warning).toContain('bara en av verifikationerna kan få det')
    expect(warning).toContain('egen kopia per verifikation')
    expect(warning).not.toContain('flera delar')
  })
})
