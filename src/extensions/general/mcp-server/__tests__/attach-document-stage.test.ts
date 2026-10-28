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

function db(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    transactions: [{ data: TX_ROW }, { data: [] }], // the transaction; then nobody else holds the document
    document_attachments: { data: DOC_ROW },
    invoice_inbox_items: {
      data: {
        extracted_data: {
          supplier: { name: 'Clas Ohlson AB' },
          invoice: { currency: 'SEK', invoiceDate: '2026-04-12' },
          totals: { total: 499 },
        },
      },
    },
    pending_operations: [{ data: [] }, { data: { id: 'op-attach-1' } }], // no waiting link proposal; then the insert
    ...(overrides as Record<string, never>),
  })
}

describe('gnubok_attach_document_to_transaction: registration', () => {
  it('stays in tools/list with the same input and an idempotent staged write', () => {
    expect(tool.catalogVisibility).toBe('default')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['document_id', 'dry_run', 'idempotency_key', 'reason', 'transaction_id'])
    // Accepted, not listed: only a DOC_ROW_MISMATCH refusal asks for it, and says how (crm#1479).
    expect(tool.undeclaredArgs).toContain('mismatch_reason')
    expect([...(schema.required ?? [])].sort()).toEqual(['document_id', 'transaction_id'])
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
      existing_document_id: null,
      existing_document_file_name: null,
      existing_document_is_rakenskapsinformation: false,
    })
    // The period status is read for the transaction date.
    expect(findCalls('fiscal_periods', 'lte')).toContainEqual(['period_start', '2026-04-12'])
    expect(result.next).toMatchObject({ tool: 'gnubok_categorize_transaction', args: { transaction_id: TX } })
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
      existing_document_id: 'a0a0a0a0-0000-4000-8000-000000000001',
      existing_document_file_name: 'gammalt.pdf',
      existing_document_is_rakenskapsinformation: false,
    })
  })

  it('refuses at staging a document that is already underlag of another verifikat (the hand-written tool staged it)', async () => {
    const { supabase } = db({
      document_attachments: { data: { ...DOC_ROW, journal_entry_id: 'b0b0b0b0-0000-4000-8000-000000000002' } },
      transaction_voucher_links: { data: [] },
    })
    await expect(
      tool.execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DOC_ATTACH_OTHER_VERIFIKAT' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('refuses at staging replacing a pinned document that is räkenskapsinformation (the hand-written tool staged it)', async () => {
    const { supabase } = db({
      transactions: { data: { ...TX_ROW, document_id: 'a0a0a0a0-0000-4000-8000-000000000001' } },
      document_attachments: { data: { journal_entry_id: 'b0b0b0b0-0000-4000-8000-000000000002', file_name: 'gammalt.pdf' } },
    })
    await expect(
      tool.execute({ transaction_id: TX, document_id: DOC }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DOC_ATTACH_REPLACES_POSTED' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
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

  it('carries the shared-document warning when another transaction already holds the document', async () => {
    const { supabase } = db({
      transactions: [{ data: TX_ROW }, { data: [{ id: 'c0c0c0c0-0000-4000-8000-000000000003', document_id: DOC }] }],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview.compliance_warning).toMatch(/^Samma underlag är redan kopplat/)
    // Two bank rows may share an invoice paid in parts: both attaches commit.
    expect(result.preview.compliance_warning).toContain('betalats i flera delar')
    expect(result.message).toMatch(/WARNING: Samma underlag/)
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
