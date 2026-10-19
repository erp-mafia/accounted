/**
 * GET /items: an invoice and its receipt from the same arrival are one
 * purchase (lib/inkorg/pairs.ts). Each row says which one it came with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  resolveBookedJournalEntryIds: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('@/lib/vendor-logos/read', () => ({ vendorLogoUrls: vi.fn().mockResolvedValue(new Map()) }))

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createTableMockSupabase, createMockRequest, makeInvoiceInboxItem, parseJsonResponse, testRoutes, type TableMockResolver } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const route = testRoutes(invoiceInboxExtension).find((r) => r.method === 'GET' && r.path === '/items')!

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const INVOICE_READ = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'X Corp.' },
  invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', dueDate: '2026-10-03', currency: 'SEK' },
  totals: { total: 83 },
}
const RECEIPT_READ = {
  documentKind: 'receipt',
  supplier: { name: 'X Corp.' },
  invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
  totals: { total: 83 },
  payment: { method: 'card', cardLast4: '3667' },
}

const invoice = (overrides: Record<string, unknown> = {}) =>
  makeInvoiceInboxItem({ id: 'invoice', source: 'email', resend_email_id: 'mail-x', document_id: 'doc-i', extracted_data: INVOICE_READ as never, ...overrides })
const receipt = (overrides: Record<string, unknown> = {}) =>
  makeInvoiceInboxItem({ id: 'receipt', source: 'email', resend_email_id: 'mail-x', document_id: 'doc-r', extracted_data: RECEIPT_READ as never, ...overrides })

function list(rows: unknown[], arrivals: TableMockResolver | { data: unknown; error?: unknown } = { data: [] }) {
  return createTableMockSupabase({
    invoice_inbox_items: (calls) => (calls.some((c) => c.method === 'range') ? { data: rows } : { data: [] }),
    arrival_outputs: arrivals,
  })
}

type Row = { id: string; pairing: unknown }

beforeEach(() => vi.clearAllMocks())

async function read(supabase: unknown): Promise<Record<string, Row>> {
  const { status, body } = await parseJsonResponse<{ data: { items: Row[] } }>(
    await route.handler(createMockRequest('/items', { method: 'GET' }), buildCtx(supabase)),
  )
  expect(status).toBe(200)
  return Object.fromEntries(body.data.items.map((i) => [i.id, i]))
}

describe('GET /items: invoice and receipt pairs', () => {
  it('pairs the invoice and the receipt of one mail', async () => {
    const { supabase, findCalls } = list([invoice(), receipt(), makeInvoiceInboxItem({ id: 'alone' })])
    const byId = await read(supabase)
    expect(byId.invoice.pairing).toEqual({ role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' })
    expect(byId.receipt.pairing).toEqual({ role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' })
    expect(byId.alone.pairing).toBeNull()
    // The arrivals of the open invoices and receipts only, in this company.
    expect(findCalls('arrival_outputs', 'in')).toEqual([['output_id', ['invoice', 'receipt']]])
    expect(findCalls('arrival_outputs', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('pairs through a shared arrival', async () => {
    const { supabase } = list(
      [invoice({ resend_email_id: null }), receipt({ resend_email_id: null })],
      { data: [{ arrival_id: 'arr-1', output_id: 'invoice' }, { arrival_id: 'arr-1', output_id: 'receipt' }] },
    )
    const byId = await read(supabase)
    expect(byId.receipt.pairing).toMatchObject({ role: 'receipt', invoice_item_id: 'invoice' })
  })

  it('does not pair a receipt from another mail, nor a booked invoice', async () => {
    expect((await read(list([invoice(), receipt({ resend_email_id: 'other' })]).supabase)).invoice.pairing).toBeNull()
    expect((await read(list([invoice({ created_supplier_invoice_id: 'si-1' }), receipt()]).supabase)).receipt.pairing).toBeNull()
  })

  it('answers the list without pairs when the arrivals cannot be read', async () => {
    const byId = await read(list([invoice(), receipt()], { data: null, error: { message: 'boom' } }).supabase)
    expect(byId.invoice.pairing).toBeNull()
    expect(byId.receipt.pairing).toBeNull()
  })
})
