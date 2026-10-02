/**
 * The agent path for a supplier's credit note in the inbox (issue #2980):
 * gnubok_create_supplier_invoice_from_inbox stages nothing for a credit note
 * and hands over to gnubok_credit_supplier_invoice with the inbox item, which
 * refuses at staging what the commit would refuse (a partial credit note).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreditTargetResolution, CreditTargetCandidate } from '@/lib/supplier-invoices/credit-target'

const resolveTargetMock = vi.fn()
vi.mock('@/lib/supplier-invoices/credit-target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supplier-invoices/credit-target')>()
  return { ...actual, resolveInboxCreditTarget: (...args: unknown[]) => resolveTargetMock(...args) }
})

const creditMock = vi.fn()
vi.mock('@/lib/supplier-invoices/credit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supplier-invoices/credit')>()
  return { ...actual, creditSupplierInvoice: (...args: unknown[]) => creditMock(...args) }
})

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { creditNoteHandoff } from '../inbox-credit-note'

const INBOX_ITEM_ID = '77777777-7777-4777-8777-777777777777'
const INVOICE_ID = '88888888-8888-4888-8888-888888888888'

const candidate: CreditTargetCandidate = {
  supplier_invoice_id: INVOICE_ID,
  supplier_invoice_number: '10234',
  arrival_number: 12,
  supplier_id: 'sup-1',
  supplier_name: 'Programvara AB',
  invoice_date: '2026-09-01',
  status: 'approved',
  currency: 'SEK',
  total: 10000,
}

const resolution = (overrides: Partial<CreditTargetResolution>): CreditTargetResolution => ({
  status: 'matched',
  matched_on: 'invoice_number',
  invoice: candidate,
  candidates: [candidate],
  credit_total: 10000,
  ...overrides,
})

/** A client that answers every read with `row` and records inserts. */
function client(row: Record<string, unknown> | null, inserts: Array<{ table: string; payload: unknown }> = []) {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: row, error: null })
          if (prop === 'single' || prop === 'maybeSingle') {
            return () => Promise.resolve(table === 'pending_operations' ? { data: { id: 'op-1' }, error: null } : { data: row, error: null })
          }
          return (...args: unknown[]) => {
            if (prop === 'insert') inserts.push({ table, payload: args[0] })
            return chain(table)
          }
        },
      },
    )
  return { from: vi.fn((table: string) => chain(table)), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('creditNoteHandoff', () => {
  it('points a matched credit note at gnubok_credit_supplier_invoice with the inbox item', () => {
    const handoff = creditNoteHandoff(INBOX_ITEM_ID, resolution({}))
    expect(handoff.next).toMatchObject({
      tool: 'gnubok_credit_supplier_invoice',
      args: { supplier_invoice_id: INVOICE_ID, inbox_item_id: INBOX_ITEM_ID },
    })
    expect(handoff.preview).toMatchObject({ document_kind: 'credit_note' })
  })

  it('never hands a partial credit note to the full credit', () => {
    const handoff = creditNoteHandoff(INBOX_ITEM_ID, resolution({ status: 'partial', credit_total: 2500 }))
    expect(handoff.next).toBeUndefined()
    expect(handoff.message).toMatch(/only part/)
  })

  it('asks for a choice when several invoices fit, without naming one', () => {
    const handoff = creditNoteHandoff(
      INBOX_ITEM_ID,
      resolution({ status: 'ambiguous', invoice: null, matched_on: null, candidates: [candidate, { ...candidate, supplier_invoice_id: 'x' }] }),
    )
    expect(handoff.next?.args).toEqual({ inbox_item_id: INBOX_ITEM_ID })
    expect(handoff.message).toMatch(/Ask the user/)
  })

  it('says an already credited invoice is done, and sends a misread amount back to the reading', () => {
    expect(creditNoteHandoff(INBOX_ITEM_ID, resolution({ status: 'already_credited' })).next).toBeUndefined()
    expect(creditNoteHandoff(INBOX_ITEM_ID, resolution({ status: 'amount_differs' })).next?.tool).toBe('gnubok_set_inbox_extracted_data')
    expect(
      creditNoteHandoff(INBOX_ITEM_ID, resolution({ status: 'none', invoice: null, matched_on: null, candidates: [] })).next,
    ).toBeUndefined()
  })
})

describe('gnubok_create_supplier_invoice_from_inbox with a credit note', () => {
  const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

  it('stages nothing and hands over to crediting the invoice it references', async () => {
    resolveTargetMock.mockResolvedValue(resolution({}))
    const inserts: Array<{ table: string; payload: unknown }> = []
    const inbox = {
      id: INBOX_ITEM_ID,
      status: 'received',
      kind_hint: null,
      matched_supplier_id: 'sup-1',
      created_supplier_invoice_id: null,
      document_id: 'doc-1',
      extracted_data: {
        documentKind: 'credit_note',
        supplier: { name: 'Programvara AB' },
        invoice: { invoiceNumber: 'K-778', invoiceDate: '2026-09-18', currency: 'SEK', creditedInvoiceNumber: '10234' },
        totals: { subtotal: -8000, vatAmount: -2000, total: -10000 },
        lineItems: [],
      },
    }

    const result = (await tool.execute({ inbox_item_id: INBOX_ITEM_ID }, 'company-1', 'user-1', client(inbox, inserts))) as {
      staged: boolean
      next?: { tool?: string; args?: Record<string, unknown> }
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(false)
    expect(result.next).toMatchObject({
      tool: 'gnubok_credit_supplier_invoice',
      args: { supplier_invoice_id: INVOICE_ID, inbox_item_id: INBOX_ITEM_ID },
    })
    expect(resolveTargetMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ id: INBOX_ITEM_ID }), { supplierId: 'sup-1' })
    expect(inserts.filter((i) => i.table === 'pending_operations')).toEqual([])
  })

  it('treats a supplier invoice read with negative amounts as a credit note', async () => {
    resolveTargetMock.mockResolvedValue(resolution({ status: 'partial', credit_total: 2500 }))
    const inbox = {
      id: INBOX_ITEM_ID,
      status: 'received',
      kind_hint: 'supplier_invoice',
      matched_supplier_id: 'sup-1',
      created_supplier_invoice_id: null,
      document_id: 'doc-1',
      extracted_data: {
        documentKind: 'supplier_invoice',
        invoice: { invoiceNumber: 'K-1', invoiceDate: '2026-09-18', currency: 'SEK' },
        totals: { subtotal: -2000, vatAmount: -500, total: 2500 },
        lineItems: [],
      },
    }
    const result = (await tool.execute({ inbox_item_id: INBOX_ITEM_ID }, 'company-1', 'user-1', client(inbox))) as {
      staged: boolean
      next?: unknown
    }
    expect(result.staged).toBe(false)
    expect(result.next).toBeUndefined()
  })
})

describe('gnubok_credit_supplier_invoice', () => {
  const tool = tools.find((t) => t.name === 'gnubok_credit_supplier_invoice')!

  it('declares inbox_item_id beside supplier_invoice_id', () => {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['supplier_invoice_id', 'inbox_item_id']))
    expect(schema.required).toEqual(['supplier_invoice_id'])
  })

  it('stages the credit with the inbox item and the credit note\'s own date', async () => {
    creditMock.mockResolvedValue({
      ok: true,
      dryRun: true,
      preview: {
        credit_note: { supplier_invoice_number: 'K-778', total: 10000, currency: 'SEK' },
        original_supplier_invoice_number: '10234',
        supplier_name: 'Programvara AB',
        credit_date: '2026-09-18',
        date_source: 'document',
        would_create_reversal_journal_entry: true,
      },
    })
    const inserts: Array<{ table: string; payload: unknown }> = []

    const result = (await tool.execute(
      { supplier_invoice_id: INVOICE_ID, inbox_item_id: INBOX_ITEM_ID },
      'company-1',
      'user-1',
      client({ id: 'fp-1', is_closed: false, locked_at: null }, inserts),
    )) as { staged: boolean }

    expect(creditMock).toHaveBeenCalledWith(expect.anything(), INVOICE_ID, { inbox_item_id: INBOX_ITEM_ID }, { dryRun: true })
    const staged = inserts.find((i) => i.table === 'pending_operations')?.payload as {
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(staged.params).toEqual({ supplier_invoice_id: INVOICE_ID, inbox_item_id: INBOX_ITEM_ID })
    expect(staged.preview_data).toMatchObject({ credit_note_number: 'K-778', credit_date: '2026-09-18', credit_date_source: 'document' })
    expect(result.staged).toBe(true)
  })

  it('refuses a partial credit note at staging with SI_CREDIT_PARTIAL', async () => {
    creditMock.mockResolvedValue({ ok: false, code: 'SI_CREDIT_PARTIAL', details: { credit_total: 2500, invoice_total: 10000 } })
    let thrown: unknown
    try {
      await tool.execute({ supplier_invoice_id: INVOICE_ID, inbox_item_id: INBOX_ITEM_ID }, 'company-1', 'user-1', client(null))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    const envelope = toToolError(thrown) as { structuredContent?: { error?: { code?: string } } }
    expect(JSON.stringify(envelope)).toContain('SI_CREDIT_PARTIAL')
  })
})
