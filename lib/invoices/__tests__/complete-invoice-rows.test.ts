import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PROCESSING_EVENT_TYPES } from '@/lib/processing-history/append'
import {
  completeInvoiceRows,
  INVOICE_ROWS_COMPLETED_EVENT,
  type CompleteInvoiceRowsTrail,
} from '../complete-invoice-rows'

/**
 * The one call site for complete_invoice_rows and the one emitter of the
 * InvoiceRowsCompleted behandlingshistorik event (#2312). The append runs for
 * real against a spy client: what lands in processing_history is the row
 * shape and the PII guard of appendProcessingHistoryWithClient, not a mock's
 * idea of it. The RPC is a spy.
 */

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const COMPANY = '11111111-1111-4111-8111-111111111111'
const INVOICE = '22222222-2222-4222-8222-222222222222'
const CONSENT = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'

const ROWS = [
  { sort_order: 1, description: 'Konsulttid', quantity: 8, unit: 'h', unit_price: 100, line_total: 800, vat_rate: 25, vat_amount: 200, line_type: 'product' },
  { sort_order: 2, description: 'Resa', quantity: 1, unit: 'st', unit_price: 200, line_total: 200, vat_rate: 25, vat_amount: 50, line_type: 'product' },
]

const HEADER = {
  subtotal: 1000,
  subtotal_sek: 1000,
  vat_amount: 250,
  vat_amount_sek: 250,
  vat_rate: 25,
  vat_treatment: 'standard_25',
}

/** The pre-#1745 shape: 25 % label beside 0 kr VAT and subtotal = total. */
const BEFORE = { subtotal: 1250, vat_amount: 0, vat_rate: 25, vat_treatment: 'standard_25' }

const trail: CompleteInvoiceRowsTrail = {
  source: 'complete-invoice-lines',
  provider: 'fortnox',
  consentId: CONSENT,
  correlationId: RUN,
  actor: { type: 'cron', id: 'complete-invoice-lines' },
}

function rpcClient(reply: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: reply.data ?? null, error: reply.error ?? null })
  return { client: { rpc } as never, rpc }
}

function historyClient(error: { message: string } | null = null) {
  const insert = vi.fn().mockResolvedValue({ error })
  const from = vi.fn().mockReturnValue({ insert })
  return { client: { from } as never, from, insert }
}

const wrote = (rows: number, headerUpdated: boolean) => ({
  data: { ok: true, wrote: true, rows, header_updated: headerUpdated },
})

describe('completeInvoiceRows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('names an event type the catalog registers', () => {
    // The union already refuses an unregistered literal at compile time;
    // this pins the runtime list the pg test reads against the migration.
    expect(PROCESSING_EVENT_TYPES).toContain(INVOICE_ROWS_COMPLETED_EVENT)
  })

  it('writes through the RPC and appends one InvoiceRowsCompleted on the invoice, with the split before and after', async () => {
    const { client: supabase, rpc } = rpcClient(wrote(2, true))
    const history = historyClient()

    const result = await completeInvoiceRows(supabase, {
      companyId: COMPANY,
      invoiceId: INVOICE,
      rows: ROWS,
      header: HEADER,
      headerBefore: BEFORE,
      trail,
      historyClient: history.client,
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('complete_invoice_rows', {
      p_company_id: COMPANY,
      p_invoice_id: INVOICE,
      p_rows: ROWS,
      p_header: HEADER,
    })

    expect(history.from).toHaveBeenCalledWith('processing_history')
    expect(history.insert).toHaveBeenCalledTimes(1)
    const row = history.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row).toMatchObject({
      company_id: COMPANY,
      correlation_id: RUN,
      aggregate_type: 'Invoice',
      aggregate_id: INVOICE,
      event_type: 'InvoiceRowsCompleted',
      actor: { type: 'cron', id: 'complete-invoice-lines' },
      payload_schema_version: 1,
    })
    expect(row.payload).toEqual({
      source: 'complete-invoice-lines',
      provider: 'fortnox',
      consent_id: CONSENT,
      rows: 2,
      header_updated: true,
      header_before: { subtotal: 1250, vat_amount: 0, vat_rate: 25, vat_treatment: 'standard_25' },
      header_after: { subtotal: 1000, vat_amount: 250, vat_rate: 25, vat_treatment: 'standard_25' },
    })
    // The SEK twins are derived, not evidence: the trail leaves them out.
    expect(row.payload).not.toHaveProperty('header_after.subtotal_sek')

    expect(result).toEqual({ status: 'written', rows: 2, headerUpdated: true, eventId: row.event_id })
    expect(typeof result.status === 'string' && 'eventId' in result && result.eventId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('records no split when the header was left alone (the wizard path, or evidence already there)', async () => {
    const { client: supabase, rpc } = rpcClient(wrote(2, false))
    const history = historyClient()

    const result = await completeInvoiceRows(supabase, {
      companyId: COMPANY,
      invoiceId: INVOICE,
      rows: ROWS,
      trail: { ...trail, source: 'migration-wizard', actor: { type: 'user', id: '55555555-5555-4555-8555-555555555555' } },
      historyClient: history.client,
    })

    // No header means an explicit null to the RPC, never a dropped argument.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_header: null })
    const row = history.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row.payload).toEqual({
      source: 'migration-wizard',
      provider: 'fortnox',
      consent_id: CONSENT,
      rows: 2,
      header_updated: false,
      header_before: null,
      header_after: null,
    })
    expect(row.actor).toEqual({ type: 'user', id: '55555555-5555-4555-8555-555555555555' })
    expect(result).toMatchObject({ status: 'written', rows: 2, headerUpdated: false })
  })

  it('records nothing when another writer filled the invoice first', async () => {
    const { client: supabase } = rpcClient({ data: { ok: true, wrote: false, rows: 0, header_updated: false } })
    const history = historyClient()

    const result = await completeInvoiceRows(supabase, {
      companyId: COMPANY, invoiceId: INVOICE, rows: ROWS, header: HEADER, headerBefore: BEFORE, trail,
      historyClient: history.client,
    })

    expect(result).toEqual({ status: 'already_filled' })
    expect(history.insert).not.toHaveBeenCalled()
  })

  it('records nothing when the RPC errors or refuses', async () => {
    const history = historyClient()

    const errored = rpcClient({ data: null, error: { message: 'check violation' } })
    await expect(completeInvoiceRows(errored.client, {
      companyId: COMPANY, invoiceId: INVOICE, rows: ROWS, trail, historyClient: history.client,
    })).resolves.toEqual({ status: 'failed', reason: 'check violation' })

    const refused = rpcClient({ data: { ok: false, code: 'MISSING_REQUIRED', details: { column: 'vat_rate' } } })
    await expect(completeInvoiceRows(refused.client, {
      companyId: COMPANY, invoiceId: INVOICE, rows: ROWS, trail, historyClient: history.client,
    })).resolves.toEqual({ status: 'failed', reason: 'MISSING_REQUIRED' })

    const empty = rpcClient({ data: null })
    await expect(completeInvoiceRows(empty.client, {
      companyId: COMPANY, invoiceId: INVOICE, rows: ROWS, trail, historyClient: history.client,
    })).resolves.toEqual({ status: 'failed', reason: 'empty RPC response' })

    expect(history.insert).not.toHaveBeenCalled()
  })

  it('reports a write whose trail append failed as written, with no event id', async () => {
    // The rows are committed by then. Failing the invoice would make the
    // next run try again and find it full; the gap is logged instead.
    const { client: supabase } = rpcClient(wrote(2, true))
    const history = historyClient({ message: 'insert or update on table "processing_history" violates foreign key constraint' })

    const result = await completeInvoiceRows(supabase, {
      companyId: COMPANY, invoiceId: INVOICE, rows: ROWS, header: HEADER, headerBefore: BEFORE, trail,
      historyClient: history.client,
    })

    expect(history.insert).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'written', rows: 2, headerUpdated: true, eventId: null })
  })
})
