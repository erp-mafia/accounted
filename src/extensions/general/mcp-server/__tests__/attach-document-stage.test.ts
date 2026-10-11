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
    expect(Object.keys(schema.properties).sort()).toEqual(['document_id', 'dry_run', 'idempotency_key', 'transaction_id'])
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

  it('carries the shared-document warning when another transaction already holds the document', async () => {
    const { supabase } = db({
      transactions: [{ data: TX_ROW }, { data: [{ id: 'c0c0c0c0-0000-4000-8000-000000000003', document_id: DOC }] }],
    })
    const result = (await tool.execute(
      { transaction_id: TX, document_id: DOC, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview.compliance_warning).toMatch(/^Samma underlag är redan kopplat/)
    expect(result.message).toMatch(/WARNING: Samma underlag/)
  })
})
