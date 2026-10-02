/**
 * The bank-match preview is the booking: for the same transaction and invoice,
 * GET /api/transactions/[id]/match-invoice/preview returns exactly the rows
 * POST /api/transactions/[id]/match-invoice books, texts, amounts and
 * dimension bags included. Both routes run for real on one fixture; only the
 * engine's writes and the side effects are mocked, and the rows the POST
 * hands createJournalEntry are compared with the rows the preview returned.
 * An edited dialog row starts from a preview row, so a drift here is a row
 * the user edits into a different booking than the one they saw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCustomer,
  makeInvoice,
  makeTransaction,
  parseJsonResponse,
} from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/invoices/invoice-payment-row', () => ({
  recordInvoicePaymentRow: vi.fn(async () => ({ ok: true, id: 'ip-1' })),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(async () => []),
}))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn() }))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return {
    ...actual,
    findFiscalPeriod: vi.fn(async () => 'fp-1'),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
    reverseEntry: vi.fn(),
  }
})

import { GET } from '../preview/route'
import { POST } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'

type PreviewRow = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
  dimensions?: Record<string, string>
}

function asPreviewRows(lines: CreateJournalEntryInput['lines']): PreviewRow[] {
  return lines.map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    description: l.line_description ?? '',
    ...(l.dimensions && Object.keys(l.dimensions).length > 0 ? { dimensions: l.dimensions } : {}),
  }))
}

async function preview(): Promise<{ status: number; lines: PreviewRow[]; documentDimensions: unknown }> {
  const response = await GET(
    createMockRequest('/api/transactions/tx-1/match-invoice/preview', {
      searchParams: { invoice_id: INVOICE_ID },
    }),
    createMockRouteParams({ id: 'tx-1' }),
  )
  const { status, body } = await parseJsonResponse<{
    lines: PreviewRow[]
    document_dimensions?: unknown
  }>(response)
  return { status, lines: body.lines, documentDimensions: body.document_dimensions }
}

async function book(): Promise<{ status: number; lines: PreviewRow[] }> {
  const response = await POST(
    createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: INVOICE_ID },
    }),
    createMockRouteParams({ id: 'tx-1' }),
  )
  const input = mockCreateJournalEntry.mock.calls[0]?.[3] as CreateJournalEntryInput | undefined
  return { status: response.status, lines: input ? asPreviewRows(input.lines) : [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
})

describe('bank-match preview and booking are identical', () => {
  it('kontantmetod: the cash rows, per-item bags merged over the invoice bag', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 5000, currency: 'SEK', date: '2026-05-18', invoice_id: null })
    const invoice = {
      ...makeInvoice({
        id: INVOICE_ID,
        status: 'sent',
        total: 5000,
        subtotal: 4000,
        vat_amount: 1000,
        remaining_amount: 5000,
        paid_amount: 0,
        journal_entry_id: null,
        default_dimensions: { '6': 'P1' },
      }),
      customer: makeCustomer({ name: 'Kund AB' }),
      credit_notes: [],
      items: [
        { description: 'Konsult', vat_rate: 25, line_total: 1000, vat_amount: 250, dimensions: { '1': 'KS1' } },
        { description: 'Material', vat_rate: 25, line_total: 3000, vat_amount: 750 },
      ],
    }
    const settings = { accounting_method: 'cash', entity_type: 'aktiebolag' }

    enqueue({ data: tx, error: null }) // preview: transaction
    enqueue({ data: invoice, error: null }) // preview: invoice
    enqueue({ data: settings, error: null }) // preview: settings
    enqueue({ data: [], error: null }) // preview: cash accounts -> 1930
    const shown = await preview()

    enqueue({ data: tx, error: null }) // POST: transaction
    enqueue({ data: invoice, error: null }) // POST: invoice
    enqueue({ data: [], error: null }) // POST: hard-duplicate check
    enqueue({ data: settings, error: null }) // POST: settings
    enqueue({ data: [], error: null }) // POST: cash accounts -> 1930
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // POST: invoice update
    enqueue({ data: null, error: null }) // POST: transaction link
    const booked = await book()

    expect(shown.status).toBe(200)
    expect(booked.status).toBe(200)
    expect(shown.lines).toEqual(booked.lines)
    // The bags travel: the item tagged KS1 keeps its own revenue row.
    expect(shown.lines.filter((l) => l.dimensions?.['1'] === 'KS1')).toHaveLength(1)
    for (const line of shown.lines) expect(line.dimensions?.['6']).toBe('P1')
    expect(shown.documentDimensions).toEqual({ '6': 'P1' })
  })

  it('kontantmetod: a whole-krona bank row books 1930 at the row and the öre on 3740', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1235, currency: 'SEK', date: '2026-05-18', invoice_id: null })
    const invoice = {
      ...makeInvoice({
        id: INVOICE_ID,
        status: 'sent',
        total: 1234.56,
        subtotal: 987.65,
        vat_amount: 246.91,
        remaining_amount: 1234.56,
        paid_amount: 0,
        journal_entry_id: null,
        default_dimensions: { '6': 'P1' },
      }),
      customer: makeCustomer({ name: 'Kund AB' }),
      credit_notes: [],
      items: [{ description: 'Konsult', vat_rate: 25, line_total: 987.65, vat_amount: 246.91 }],
    }
    const settings = { accounting_method: 'cash', entity_type: 'aktiebolag' }

    enqueue({ data: tx, error: null }) // preview: transaction
    enqueue({ data: invoice, error: null }) // preview: invoice
    enqueue({ data: settings, error: null }) // preview: settings
    enqueue({ data: [], error: null }) // preview: cash accounts -> 1930
    const shown = await preview()

    enqueue({ data: tx, error: null }) // POST: transaction
    enqueue({ data: invoice, error: null }) // POST: invoice
    enqueue({ data: [], error: null }) // POST: hard-duplicate check
    enqueue({ data: settings, error: null }) // POST: settings
    enqueue({ data: [], error: null }) // POST: cash accounts -> 1930
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // POST: invoice update
    enqueue({ data: null, error: null }) // POST: transaction link
    const booked = await book()

    expect(shown.status).toBe(200)
    expect(booked.status).toBe(200)
    expect(shown.lines).toEqual(booked.lines)
    expect(shown.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 1235, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0, 0.44],
    ])
    for (const line of shown.lines) expect(line.dimensions).toEqual({ '6': 'P1' })
  })

  it('faktureringsmetod: the clearing rows, the öre residual on 3740, every leg tagged', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, currency: 'SEK', date: '2026-05-18', invoice_id: null })
    const invoice = {
      ...makeInvoice({
        id: INVOICE_ID,
        status: 'sent',
        total: 12500.4,
        remaining_amount: 12500.4,
        paid_amount: 0,
        journal_entry_id: 'je-invoice',
        default_dimensions: { '6': 'P1', '1': 'KS1' },
      }),
      customer: makeCustomer({ name: 'Kund AB' }),
      credit_notes: [],
      items: [],
    }
    const settings = { accounting_method: 'accrual', entity_type: 'aktiebolag' }

    enqueue({ data: tx, error: null }) // preview: transaction
    enqueue({ data: invoice, error: null }) // preview: invoice
    enqueue({ data: settings, error: null }) // preview: settings
    enqueue({ data: [], error: null }) // preview: cash accounts -> 1930
    const shown = await preview()

    enqueue({ data: tx, error: null }) // POST: transaction
    enqueue({ data: invoice, error: null }) // POST: invoice
    enqueue({ data: [], error: null }) // POST: hard-duplicate check
    enqueue({ data: settings, error: null }) // POST: settings
    enqueue({ data: [], error: null }) // POST: cash accounts -> 1930
    enqueue({ data: null, error: null }) // POST: invoice PDF lookup for the payment verifikat
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // POST: invoice update
    enqueue({ data: null, error: null }) // POST: transaction link
    const booked = await book()

    expect(shown.status).toBe(200)
    expect(booked.status).toBe(200)
    expect(shown.lines).toEqual(booked.lines)
    expect(shown.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 12500, 0],
      ['1510', 0, 12500.4],
      ['3740', 0.4, 0],
    ])
    expect(shown.lines[0].description).toBe('Inbetalning kundfaktura F-2024001, Kund AB')
    for (const line of shown.lines) expect(line.dimensions).toEqual({ '6': 'P1', '1': 'KS1' })
    expect(shown.documentDimensions).toEqual({ '6': 'P1', '1': 'KS1' })
  })

  it('an untagged invoice previews and books untagged rows', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, currency: 'SEK', date: '2026-05-18', invoice_id: null })
    const invoice = {
      ...makeInvoice({ id: INVOICE_ID, status: 'sent', paid_amount: 0, journal_entry_id: 'je-invoice' }),
      customer: makeCustomer({ name: 'Kund AB' }),
      credit_notes: [],
      items: [],
    }
    const settings = { accounting_method: 'accrual', entity_type: 'aktiebolag' }

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: settings, error: null })
    enqueue({ data: [], error: null })
    const shown = await preview()

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: settings, error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: [{ id: INVOICE_ID }], error: null })
    enqueue({ data: null, error: null })
    const booked = await book()

    expect(shown.lines).toEqual(booked.lines)
    for (const line of shown.lines) expect('dimensions' in line).toBe(false)
    expect(shown.documentDimensions).toBeUndefined()
  })
})
