import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
  makeInvoice,
} from '@/tests/helpers'
import type { InvoiceItem } from '@/types'
import {
  PeppolTransportError,
  registerPeppolTransport,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import { createConnectorPeppolTransport } from '@/lib/invoices/transports/connector'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const serviceTables = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const serviceRpcMock = vi.fn()
const markSentMock = vi.fn()
const restoreDraftMock = vi.fn()
const finishIssuedMock = vi.fn()

/** One shared logger for the route and its wrapper, so refusal lines can be asserted. */
const logMock = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockImplementation(() => log)
  return log
})

vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logMock,
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (...args: unknown[]) => serviceTables.supabase.from(...(args as [string])),
    rpc: (...args: unknown[]) => serviceRpcMock(...args),
  }),
}))

vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({
  markInvoiceSentAndBook: (...args: unknown[]) => markSentMock(...args),
  restoreUnbookedDraft: (...args: unknown[]) => restoreDraftMock(...args),
  finishIssuedInvoice: (...args: unknown[]) => finishIssuedMock(...args),
}))

import { POST } from '../route'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333'
const user = { id: 'user-1', email: 'owner@example.test' }
const customer = makeCustomer({
  name: 'Kund AB',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
})
const company = makeCompanySettings({
  company_name: 'Säljare AB',
  entity_type: 'aktiebolag',
  org_number: '556016-0680',
  vat_number: 'SE556016068001',
  bankgiro: '991-2346',
})
const item: InvoiceItem = {
  id: 'item-1',
  invoice_id: INVOICE_ID,
  sort_order: 0,
  line_type: 'product',
  description: 'Rådgivning',
  quantity: 1,
  unit: 'tim',
  unit_price: 100,
  line_total: 100,
  vat_rate: 25,
  vat_amount: 25,
  created_at: '2026-08-13T00:00:00.000Z',
}
function invoiceRow(overrides: Partial<ReturnType<typeof makeInvoice>> = {}) {
  return makeInvoice({
    id: INVOICE_ID,
    invoice_number: 'F-2026-42',
    invoice_date: '2026-08-13',
    due_date: '2026-09-12',
    status: 'sent',
    subtotal: 100,
    vat_amount: 25,
    total: 125,
    remaining_amount: 125,
    vat_treatment: 'standard_25',
    your_reference: 'KST-100',
    customer,
    items: [item],
    ...overrides,
  })
}

const stagedDelivery = {
  id: '22222222-2222-4222-8222-222222222222',
  invoice_id: INVOICE_ID,
  idempotency_key: IDEMPOTENCY_KEY,
  recipient_scheme: '0007',
  recipient_identifier: '5566778899',
  xml_sha256: 'a'.repeat(64),
  provider: null,
  provider_submission_id: null,
  status: 'staged',
  status_at: '2026-08-21T10:00:00.000Z',
  status_detail: null,
  submitted_at: null,
  terminal_at: null,
  evidence_retrieved_at: null,
  filename: 'peppol-invoice-F-2026-42.xml',
  created_at: '2026-08-21T10:00:00.000Z',
}

const acceptedReceipt = {
  provider: 'qvalia',
  providerSubmissionId: 'int-1',
  idempotencyKey: IDEMPOTENCY_KEY,
  tenantReference: 'company-1',
  acceptedAt: '2026-08-21T10:00:02.000Z',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    tenantId: 'SE5560000000',
    lookupRecipient: vi.fn().mockResolvedValue({
      reachable: true,
      participant: { scheme: '0007', identifier: '5566778899' },
      capabilities: [],
      checkedAt: '2026-08-21T10:00:01.000Z',
    }),
    submit: vi.fn().mockResolvedValue(acceptedReceipt),
    verifyWebhook: vi.fn().mockResolvedValue([]),
    retrieveEvidence: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

const accessRow = {
  company_id: 'company-1',
  status: 'enabled',
  max_sends: 50,
  receive_enabled: false,
  requested_at: null, requested_by: null, request_note: null,
  enabled_at: '2026-08-21T16:00:00.000Z', enabled_by: 'jakob', disabled_at: null, note: null,
  created_at: '2026-08-21T16:00:00.000Z', updated_at: '2026-08-21T16:00:00.000Z',
}
/** The sandbox gate reads company_settings.is_sandbox through the user client before anything else. */
function realCompany(isSandbox = false) {
  enqueue({ data: { is_sandbox: isSandbox }, error: null })
}
/** Peppol access is per company: grant it (service reads access row, then the send count). */
function grantAccess(maxSends: number | null = 50, sent = 0) {
  serviceTables.enqueue({ data: { ...accessRow, max_sends: maxSends }, error: null })
  serviceTables.enqueue({ data: null, error: null, count: sent })
}
/** The user-client reads a send makes once it is past the gates: invoice, company settings, stage RPC. */
function stageInvoice(overrides: Partial<ReturnType<typeof makeInvoice>> = {}, delivery: Record<string, unknown> = stagedDelivery) {
  enqueue({ data: invoiceRow(overrides), error: null })
  enqueue({ data: company, error: null })
  enqueue({ data: delivery, error: null })
}

/** The service-role RPC echoes the event's status back as the projection of its delivery. */
function serviceRpcEcho() {
  serviceRpcMock.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({
    data: {
      ...stagedDelivery,
      idempotency_key: args.p_idempotency_key,
      provider: args.p_provider,
      provider_submission_id: args.p_provider_submission_id ?? null,
      status: args.p_normalized_status,
      status_at: args.p_occurred_at,
      status_detail: args.p_detail ?? null,
      terminal_at: args.p_is_terminal ? args.p_occurred_at : null,
    },
    error: null,
  }))
}

function connectorFailure(code: string, retryable: boolean, detail: string | null = null) {
  return new PeppolTransportError('Connector: hosted refusal', { retryable, code, detail })
}

describe('POST /api/invoices/[id]/peppol/send', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    serviceTables.reset()
    serviceRpcEcho()
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
    markSentMock.mockResolvedValue({ ok: true, journalEntryId: 'je-1', partialFailures: [] })
    restoreDraftMock.mockResolvedValue(true)
    finishIssuedMock.mockResolvedValue([])
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    delete process.env.QVALIA_ACCOUNT_REG_NO
  })

  function send() {
    return POST(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol/send`, { method: 'POST' }),
      createMockRouteParams({ id: INVOICE_ID }),
    )
  }

  function expectRefusalLogged(code: string) {
    expect(logMock.info).toHaveBeenCalledWith('peppol send refused', { invoiceId: INVOICE_ID, code })
  }

  it('returns 401 when the caller is not authenticated', async () => {
    unregister = registerPeppolTransport(makeTransport())
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await send()
    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid invoice id', async () => {
    unregister = registerPeppolTransport(makeTransport())
    const response = await POST(
      createMockRequest('/api/invoices/nope/peppol/send', { method: 'POST' }),
      createMockRouteParams({ id: 'nope' }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('refuses truthfully when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    const response = await send()
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_TRANSPORT_UNAVAILABLE')
    expect(body.error.details.reason).toBe('provider_selection_required')
    expectRefusalLogged('PEPPOL_TRANSPORT_UNAVAILABLE')
  })

  it('refuses the demo company before it can reach the access point', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany(true)
    const response = await send()
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
    expect(body.error.message).toBe(
      'Peppol-sändning är inte tillgänglig i demobolaget. Skapa ett riktigt konto för att skicka e-fakturor.',
    )
    expect(body.error.message_en).toBe(
      'Peppol sending is not available in the demo company. Create a real account to send e-invoices.',
    )
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
    expectRefusalLogged('PEPPOL_SANDBOX_NOT_ALLOWED')
  })

  it('refuses a company without a Peppol grant before touching the invoice', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    serviceTables.enqueue({ data: null, error: null })              // no access row
    const response = await send()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('PEPPOL_ACCESS_REQUIRED')
    expect(transport.submit).not.toHaveBeenCalled()
    expectRefusalLogged('PEPPOL_ACCESS_REQUIRED')
  })

  it('refuses once the company has used its sending cap', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess(5, 5)
    const response = await send()
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_SEND_LIMIT_REACHED')
    expect(body.error.details).toMatchObject({ max_sends: 5, sent_count: 5 })
    expect(transport.submit).not.toHaveBeenCalled()
    expectRefusalLogged('PEPPOL_SEND_LIMIT_REACHED')
  })

  it('returns 404 when the invoice is not in the active company', async () => {
    unregister = registerPeppolTransport(makeTransport())
    realCompany()
    grantAccess()
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await send()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('INVOICE_NOT_FOUND')
    expectRefusalLogged('INVOICE_NOT_FOUND')
  })

  it('rejects cancelled and proforma invoices with a state conflict', async () => {
    unregister = registerPeppolTransport(makeTransport())
    realCompany()
    grantAccess()
    enqueue({ data: invoiceRow({ status: 'cancelled' }), error: null })
    enqueue({ data: company, error: null })
    const response = await send()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('PEPPOL_SEND_INVALID_STATUS')
    expectRefusalLogged('PEPPOL_SEND_INVALID_STATUS')
  })

  it('logs which BIS preflight rule stopped the send', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    enqueue({ data: invoiceRow({ your_reference: null }), error: null })
    enqueue({ data: company, error: null })

    const response = await send()

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(logMock.info).toHaveBeenCalledWith('peppol send refused', {
      invoiceId: INVOICE_ID,
      code: 'VALIDATION_ERROR',
      issues: ['BUYER_REFERENCE_REQUIRED'],
    })
  })

  it('names the missing fiscal year when the stage RPC has no retention basis for the invoice date', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: null,
      error: { code: 'P0002', message: 'Peppol delivery requires a fiscal period retention basis' },
    })

    const response = await send()

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_FISCAL_PERIOD_MISSING')
    expect(body.error.details).toMatchObject({ invoice_date: '2026-08-13' })
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(serviceRpcMock).not.toHaveBeenCalled()
    expectRefusalLogged('PEPPOL_FISCAL_PERIOD_MISSING')
  })

  it('keeps the generic mapping for the stage RPC\'s other P0002', async () => {
    unregister = registerPeppolTransport(makeTransport())
    realCompany()
    grantAccess()
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: null,
      error: { code: 'P0002', message: 'invoice not found or not eligible for Peppol staging' },
    })

    const response = await send()

    expect((await response.json()).error.code).not.toBe('PEPPOL_FISCAL_PERIOD_MISSING')
    expect(logMock.info).not.toHaveBeenCalledWith('peppol send refused', expect.anything())
  })

  it('stops before the network when the recipient has no Peppol registration', async () => {
    const transport = makeTransport({
      lookupRecipient: vi.fn().mockResolvedValue({
        reachable: false,
        participant: { scheme: '0007', identifier: '5566778899' },
        reasonCode: 'participant_not_registered',
        checkedAt: '2026-08-21T10:00:01.000Z',
      }),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_RECIPIENT_NOT_REACHABLE')
    expect(body.error.details).toMatchObject({ identifier: '5566778899', reason: 'participant_not_registered' })
    expect(transport.submit).not.toHaveBeenCalled()
    expect(serviceRpcMock).not.toHaveBeenCalled()
  })

  it('answers 502 and records nothing terminal when the lookup itself fails transiently', async () => {
    const transport = makeTransport({
      lookupRecipient: vi.fn().mockRejectedValue(
        connectorFailure('CONNECTOR_UNREACHABLE', true, 'ECONNRESET'),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_LOOKUP_FAILED')
    expect(body.error.details).toEqual({ reason: 'ECONNRESET', code: 'CONNECTOR_UNREACHABLE' })
    expect(transport.submit).not.toHaveBeenCalled()
    expect(serviceRpcMock).not.toHaveBeenCalled()
  })

  it('answers 502 too when the lookup failure is not retryable: a lookup is never a document verdict', async () => {
    const transport = makeTransport({
      lookupRecipient: vi.fn().mockRejectedValue(
        connectorFailure('CONNECTOR_PROTOCOL_ERROR', false, 'participant: Required'),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_LOOKUP_FAILED')
    expect(body.error.details.code).toBe('CONNECTOR_PROTOCOL_ERROR')
    expect(serviceRpcMock).not.toHaveBeenCalled()
  })

  it('keeps the generic handling when the lookup throws something that is not a transport error', async () => {
    const transport = makeTransport({
      lookupRecipient: vi.fn().mockRejectedValue(new Error('boom')),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(500)
    expect((await response.json()).error.code).not.toBe('PEPPOL_LOOKUP_FAILED')
  })

  it('looks up, submits the staged XML and records the lifecycle for an already issued invoice', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data).toMatchObject({
      network_submitted: true,
      already_submitted: false,
      recipient: { scheme: '0007', identifier: '5566778899' },
      invoice_status: 'sent',
      issuance: null,
      delivery: { status: 'submission_accepted', provider: 'qvalia', provider_submission_id: 'int-1' },
    })

    expect(transport.lookupRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5566778899' })
    const submission = (transport.submit as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(submission).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      tenantReference: 'company-1',
      sender: { scheme: '0007', identifier: '5560160680' },
      recipient: { scheme: '0007', identifier: '5566778899' },
      contentType: 'application/xml',
      filename: 'peppol-invoice-F-2026-42.xml',
    })
    expect(submission.document).toContain('<cbc:ID>F-2026-42</cbc:ID>')

    const statuses = serviceRpcMock.mock.calls.map((call) => (call[1] as Record<string, unknown>).p_normalized_status)
    expect(statuses).toEqual(['recipient_verified', 'submitting', 'submission_accepted'])
    for (const call of serviceRpcMock.mock.calls) {
      expect(call[0]).toBe('record_peppol_delivery_event')
      // The transport's own label, the one its later events carry.
      expect((call[1] as Record<string, unknown>).p_provider_tenant_id).toBe(transport.tenantId)
    }
    expect(markSentMock).not.toHaveBeenCalled()
    expect(logMock.info).not.toHaveBeenCalledWith('peppol send refused', expect.anything())
  })

  it('records a send through the connector under the connector label, whatever account number the environment holds', async () => {
    // Hosted in connector mode: no Qvalia keys, so the connector is the only
    // transport. A leftover account number must not become the row's label:
    // the status polls carry 'connector' and the lifecycle RPC would refuse them.
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    process.env.QVALIA_ACCOUNT_REG_NO = 'SE5595386219'
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        reachable: true,
        participant: { scheme: '0007', identifier: '5566778899' },
        capabilities: [],
        checkedAt: '2026-09-29T10:00:01.000Z',
      }))
      .mockResolvedValueOnce(json({ ...acceptedReceipt, acceptedAt: '2026-09-29T10:00:02.000Z' }))
    unregister = registerPeppolTransport(createConnectorPeppolTransport(
      { baseUrl: 'https://connect.example.test/api/connect/peppol', key: 'gnubok_ck_test' },
      { fetch: fetchMock as unknown as typeof fetch },
    ))
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(201)
    expect((await response.json()).data.delivery).toMatchObject({
      provider: 'connector',
      provider_submission_id: 'int-1',
      status: 'submission_accepted',
    })
    const events = serviceRpcMock.mock.calls.map((call) => call[1] as Record<string, unknown>)
    expect(events.map((event) => event.p_normalized_status)).toEqual(['recipient_verified', 'submitting', 'submission_accepted'])
    for (const event of events) {
      expect(event).toMatchObject({ p_provider: 'connector', p_provider_tenant_id: 'connector' })
    }
  })

  it('issues and books a draft before the network gets it, then finishes it once accepted', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice({ status: 'draft' })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data).toMatchObject({
      invoice_status: 'sent',
      journal_entry_id: 'je-1',
      issuance: { ok: true, partial_failures: [] },
    })
    expect(markSentMock).toHaveBeenCalledTimes(1)
    const submitOrder = (transport.submit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(markSentMock.mock.invocationCallOrder[0]).toBeLessThan(submitOrder)
    // The mark-sent tail (underlag, delivery record, invoice.sent) after acceptance.
    expect(finishIssuedMock).toHaveBeenCalledWith(
      expect.objectContaining({ journalEntryId: 'je-1', recordDelivery: true }),
    )
    expect(finishIssuedMock.mock.invocationCallOrder[0]).toBeGreaterThan(submitOrder)
  })

  it('a refused verifikat transmits nothing: the engine error comes back and the draft stays', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    const { MandatoryDimensionMissingError } = await import('@/lib/bookkeeping/dimension-errors')
    markSentMock.mockResolvedValue({
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED',
      reason: 'Konto 3001 kräver Projekt',
      bookingError: new MandatoryDimensionMissingError([
        { account_number: '3001', sie_dim_no: '6', dimension_name: 'Projekt' },
      ]),
    })
    stageInvoice({ status: 'draft' })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('MANDATORY_DIMENSION_MISSING')
    expect(transport.submit).not.toHaveBeenCalled()
    expect(finishIssuedMock).not.toHaveBeenCalled()
  })

  it('replays idempotently when the exact XML was already handed to the network', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice({}, {
      ...stagedDelivery,
      provider: 'qvalia',
      provider_submission_id: 'int-1',
      status: 'submission_accepted',
    })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ already_submitted: true, network_submitted: true })
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
  })

  it('records a terminal failure and answers 422 when the access point rejects the document', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        new PeppolTransportError('Qvalia rejected the document (422)', {
          retryable: false,
          detail: 'BR-CO-10 Sum of invoice line net amount',
        }),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice({ status: 'draft' })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(422)
    // The draft was issued and booked before the submit, and a posted
    // verifikat is never undone: it stays issued (finished without a delivery
    // record) and the failure says so, with the access point's own reason.
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE')
    expect(body.error.message).toBe(
      'Fakturan är utfärdad och bokförd, men Peppol-operatören tog inte emot den: BR-CO-10 Sum of invoice line net amount. Rätta och skicka igen, eller skicka PDF:en via e-post.',
    )
    expect(body.error.message_en).toBe(
      'The invoice is issued and booked, but the Peppol access point did not accept it: BR-CO-10 Sum of invoice line net amount. Correct it and send again, or send the PDF by email.',
    )
    expect(body.error.details).toEqual({
      reason: 'BR-CO-10 Sum of invoice line net amount',
      code: null,
      invoice_status: 'sent',
      journal_entry_id: 'je-1',
    })
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_rejected',
      p_normalized_status: 'failed',
      p_is_terminal: true,
      // status_detail is the provider's reason alone; the adapter's own
      // message stays in the event's raw payload.
      p_detail: 'BR-CO-10 Sum of invoice line net amount',
      p_raw_payload: expect.objectContaining({ error: 'Qvalia rejected the document (422)', code: null }),
    })
    expect(restoreDraftMock).not.toHaveBeenCalled()
    expect(finishIssuedMock).toHaveBeenCalledWith(
      expect.objectContaining({ journalEntryId: 'je-1', recordDelivery: false }),
    )
  })

  it('a draft with nothing booked goes back to draft when the access point rejects it', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        new PeppolTransportError('Qvalia rejected the document (422)', {
          retryable: false,
          detail: 'BR-CO-10 Sum of invoice line net amount',
        }),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    markSentMock.mockResolvedValue({ ok: true, journalEntryId: null, partialFailures: [] })
    stageInvoice({ status: 'draft' })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(422)
    // Nothing was issued: the old code, which says the invoice was not sent.
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED')
    expect(body.error.message).toBe('Peppol-operatören avvisade fakturan vid valideringen. Fakturan har inte skickats.')
    expect(restoreDraftMock).toHaveBeenCalledWith(expect.anything(), 'company-1', INVOICE_ID, expect.anything())
    expect(body.error.details).not.toHaveProperty('invoice_status')
    expect(finishIssuedMock).not.toHaveBeenCalled()
  })

  it('still records a terminal rejection for a non-retryable CONNECTOR_UPSTREAM_ERROR (the access point refused the document)', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        connectorFailure('CONNECTOR_UPSTREAM_ERROR', false, 'BR-CO-10 Sum of invoice line net amount'),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(422)
    // Issued before this send and still issued; no verifikat on the row, so
    // the sentence does not claim one.
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE')
    expect(body.error.message).toBe(
      'Fakturan är utfärdad, men Peppol-operatören tog inte emot den: BR-CO-10 Sum of invoice line net amount. Rätta och skicka igen, eller skicka PDF:en via e-post.',
    )
    expect(body.error.details).toEqual({
      reason: 'BR-CO-10 Sum of invoice line net amount',
      code: 'CONNECTOR_UPSTREAM_ERROR',
      invoice_status: 'sent',
      journal_entry_id: null,
    })
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_rejected',
      p_normalized_status: 'failed',
      p_is_terminal: true,
    })
  })

  it('records a retryable failure and answers 502 when the hosted service is unreachable', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        connectorFailure('CONNECTOR_UNREACHABLE', true),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE')
    expect(body.error.message).toBe(
      'Fakturan är utfärdad, men kunde inte skickas via Peppol just nu. Försök igen om en stund, eller skicka PDF:en via e-post.',
    )
    expect(body.error.details).toEqual({
      reason: null,
      code: 'CONNECTOR_UNREACHABLE',
      invoice_status: 'sent',
      journal_entry_id: null,
    })
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_failed',
      p_normalized_status: 'retryable_failure',
      p_is_terminal: false,
    })
  })

  describe('a retryable hosted answer is a plain failure, whatever its code', () => {
    const transientCodes = [
      'CONNECTOR_UNREACHABLE',
      'CONNECTOR_RATE_LIMITED',
      'CONNECTOR_LEDGER_FAILED',
      'CONNECTOR_UPSTREAM_UNCONFIGURED',
      'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
      'CONNECTOR_UPSTREAM_ERROR',
      'HTTP_429',
      'HTTP_502',
    ]

    it.each(transientCodes)('%s retryable: 502, retryable_failure, not terminal', async (code) => {
      const transport = makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure(code, true, 'busy')),
      })
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccess()
      stageInvoice()

      const response = await send()
      const body = await response.json()

      expect(response.status).toBe(502)
      expect(body.error.code).toBe('PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE')
      expect(body.error.details).toEqual({ reason: 'busy', code, invoice_status: 'sent', journal_entry_id: null })
      const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
      expect(last).toMatchObject({
        p_provider_event_code: 'submit_failed',
        p_normalized_status: 'retryable_failure',
        p_is_terminal: false,
      })
    })
  })

  describe('a coded non-retryable hosted answer is a precondition, never a verdict on the document', () => {
    const preconditionCodes = [
      'CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED',
      'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
      'CONNECTOR_QUOTA_EXCEEDED',
      'CONNECTOR_SCOPE_MISSING',
      'CONNECTOR_KEY_INVALID',
      'CONNECTOR_KEY_SUSPENDED',
      'CONNECTOR_KEY_MISSING',
      'CONNECTOR_COMPANY_MISSING',
      'CONNECTOR_PATH_NOT_ALLOWED',
      'CONNECTOR_NOT_OWNED',
      'BAD_REQUEST',
      'CONNECTOR_PROTOCOL_ERROR',
      'HTTP_403',
      'HTTP_404',
    ]

    it.each(preconditionCodes)('%s stays resendable: 409, retryable_failure, and the same XML is submitted again', async (code) => {
      const transport = makeTransport({
        submit: vi.fn()
          .mockRejectedValueOnce(connectorFailure(code, false, 'hosted detail'))
          .mockResolvedValueOnce(acceptedReceipt),
      })
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccess()
      stageInvoice()

      const first = await send()
      const body = await first.json()

      expect(first.status).toBe(409)
      expect(body.error.code).toBe('PEPPOL_SEND_PRECONDITION_FAILED')
      expect(body.error.details).toEqual({ reason: 'hosted detail', code, invoice_status: 'sent', journal_entry_id: null })
      expect(body.error.message).toMatch(/^Fakturan kunde inte skickas via Peppol ännu: /)
      const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
      expect(last).toMatchObject({
        p_provider_event_code: 'submit_failed',
        p_normalized_status: 'retryable_failure',
        p_is_terminal: false,
      })
      expect(serviceRpcMock.mock.calls.map((call) => (call[1] as Record<string, unknown>).p_provider_event_code))
        .not.toContain('submit_rejected')

      // Same XML again: the stage RPC hands back the non-terminal row and
      // the route goes to the network a second time instead of refusing.
      realCompany()
      grantAccess()
      stageInvoice({}, { ...stagedDelivery, status: 'retryable_failure', status_detail: 'hosted detail' })

      const second = await send()

      expect(second.status).toBe(201)
      expect(transport.submit).toHaveBeenCalledTimes(2)
      expect((await second.json()).data.delivery.status).toBe('submission_accepted')
    })

    it.each([
      [
        'CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED',
        'Fakturan kunde inte skickas via Peppol ännu: Bolagets Peppol-id är inte registrerat hos operatören. Slå på mottagning under Inställningar > Fakturering > E-faktura via Peppol, eller kontakta support.',
        "The invoice could not be sent via Peppol yet: The company's Peppol id is not registered with the access point. Switch on receiving under Settings > Invoicing > E-invoicing via Peppol, or contact support.",
      ],
      [
        'CONNECTOR_SCOPE_MISSING',
        'Fakturan kunde inte skickas via Peppol ännu: Kopplingsnyckeln saknar Peppol-behörighet. Kontakta support.',
        'The invoice could not be sent via Peppol yet: The connector key lacks Peppol permission. Contact support.',
      ],
      [
        'CONNECTOR_QUOTA_EXCEEDED',
        'Fakturan kunde inte skickas via Peppol ännu: Kontots Peppol-platser är förbrukade. Hör av dig till support så öppnar vi fler.',
        'The invoice could not be sent via Peppol yet: The account has used its Peppol slots. Contact support and we will open more.',
      ],
    ])('composes the hosted text onto the prefix when the registry knows %s', async (code, sv, en) => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure(code, false)),
      }))
      realCompany()
      grantAccess()
      stageInvoice()

      const body = await (await send()).json()

      expect(body.error.message).toBe(sv)
      expect(body.error.message_en).toBe(en)
    })

    it('falls back to the settings pointer for a code the registry does not know', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('HTTP_403', false)),
      }))
      realCompany()
      grantAccess()
      stageInvoice()

      const body = await (await send()).json()

      expect(body.error.message).toBe(
        'Fakturan kunde inte skickas via Peppol ännu: kontrollera Peppol-inställningarna och försök igen.',
      )
      expect(body.error.message_en).toBe(
        'The invoice could not be sent via Peppol yet: check the Peppol settings and try again.',
      )
    })
  })

  it('never sends over a failed delivery the stage RPC hands back (a database before the resend migration)', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice({}, {
      ...stagedDelivery,
      provider: 'qvalia',
      status: 'failed',
      status_detail: 'BR-CO-10',
      terminal_at: '2026-08-21T09:00:00.000Z',
    })

    const response = await send()

    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_SUBMISSION_REJECTED')
    expect(transport.submit).not.toHaveBeenCalled()
  })

  describe('a resend after a failed delivery', () => {
    /** The stage RPC's answer to a resend: a new delivery of the same document. */
    const resendDelivery = {
      ...stagedDelivery,
      id: '44444444-4444-4444-8444-444444444444',
      idempotency_key: '55555555-5555-4555-8555-555555555555',
    }
    /** The access grant, then the invoice's latest submission to this recipient. */
    function grantAccessWithLatestSubmission(latest: Record<string, unknown> | null) {
      grantAccess()
      serviceTables.enqueue({ data: latest, error: null })
    }
    const submission = (transport: PeppolTransport) =>
      (transport.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>

    it('replaces the failed submission at the access point and succeeds as a new delivery', async () => {
      const transport = makeTransport({
        submit: vi.fn().mockResolvedValue({ ...acceptedReceipt, providerSubmissionId: 'int-2' }),
      })
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccessWithLatestSubmission({ provider_submission_id: 'int-1', status: 'failed' })
      stageInvoice({}, resendDelivery)

      const response = await send()

      expect(response.status).toBe(201)
      expect((await response.json()).data).toMatchObject({
        already_submitted: false,
        delivery: { status: 'submission_accepted', provider_submission_id: 'int-2' },
      })
      expect(submission(transport)).toMatchObject({
        idempotencyKey: resendDelivery.idempotency_key,
        replacesSubmissionId: 'int-1',
      })
      // Every lifecycle event lands on the new delivery, never on the failed one.
      for (const call of serviceRpcMock.mock.calls) {
        expect((call[1] as Record<string, unknown>).p_idempotency_key).toBe(resendDelivery.idempotency_key)
      }
      // The latest submission of this invoice, to this recipient, through this provider.
      const filters = serviceTables.findCalls('peppol_deliveries', 'eq')
      for (const filter of [
        ['company_id', 'company-1'],
        ['invoice_id', INVOICE_ID],
        ['provider', 'qvalia'],
        ['recipient_scheme', '0007'],
        ['recipient_identifier', '5566778899'],
      ]) {
        expect(filters).toContainEqual(filter)
      }
      expect(serviceTables.findCalls('peppol_deliveries', 'not')).toContainEqual(['provider_submission_id', 'is', null])
      expect(serviceTables.findCall('peppol_deliveries', 'order')).toEqual(['submitted_at', { ascending: false, nullsFirst: false }])
      // The attempt records which submission it replaced.
      const attempt = serviceRpcMock.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .find((event) => event.p_provider_event_code === 'submit_attempt')
      expect(attempt?.p_raw_payload).toMatchObject({ replaces_submission_id: 'int-1' })
    })

    it('passes no replacement when the invoice now goes to another recipient', async () => {
      const transport = makeTransport()
      unregister = registerPeppolTransport(transport)
      realCompany()
      // The failed delivery went to 0007:5566778899; no submission to the new
      // recipient exists, so the scoped read answers nothing.
      grantAccessWithLatestSubmission(null)
      stageInvoice({
        customer: makeCustomer({ name: 'Ny Kund AB', org_number: '556999-9997', vat_number: 'SE556999999701' }),
      }, { ...resendDelivery, recipient_identifier: '5569999997' })

      const response = await send()

      expect(response.status).toBe(201)
      expect(submission(transport).recipient).toEqual({ scheme: '0007', identifier: '5569999997' })
      expect(submission(transport)).not.toHaveProperty('replacesSubmissionId')
      expect(serviceTables.findCalls('peppol_deliveries', 'eq')).toContainEqual(['recipient_identifier', '5569999997'])
    })

    it('never replaces a submission the network is still delivering', async () => {
      const transport = makeTransport()
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccessWithLatestSubmission({ provider_submission_id: 'int-1', status: 'transport_succeeded' })
      stageInvoice({}, resendDelivery)

      await send()

      expect(submission(transport)).not.toHaveProperty('replacesSubmissionId')
    })

    it('refuses an invoice the buyer rejected via Peppol, before any network call', async () => {
      const transport = makeTransport()
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccess()
      stageInvoice({}, {
        ...stagedDelivery,
        provider: 'qvalia',
        provider_submission_id: 'int-1',
        status: 'business_rejected',
        status_detail: 'Fel referens',
        terminal_at: '2026-09-29T09:00:00.000Z',
      })

      const response = await send()

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error.code).toBe('PEPPOL_BUSINESS_REJECTED')
      expect(body.error.message).toBe('Mottagaren har avvisat fakturan via Peppol. Kreditera den och skapa en ny faktura.')
      expect(body.error.details).toEqual({ status: 'business_rejected', detail: 'Fel referens' })
      expect(transport.lookupRecipient).not.toHaveBeenCalled()
      expect(transport.submit).not.toHaveBeenCalled()
      expect(serviceRpcMock).not.toHaveBeenCalled()
    })

    it('answers an invoice the buyer accepted as already delivered', async () => {
      const transport = makeTransport()
      unregister = registerPeppolTransport(transport)
      realCompany()
      grantAccess()
      stageInvoice({}, {
        ...stagedDelivery,
        provider: 'qvalia',
        provider_submission_id: 'int-1',
        status: 'business_accepted',
        terminal_at: '2026-09-29T09:00:00.000Z',
      })

      const response = await send()

      expect(response.status).toBe(200)
      expect((await response.json()).data).toMatchObject({ already_submitted: true })
      expect(transport.submit).not.toHaveBeenCalled()
    })
  })

  it('ends the delivery on a duplicate invoice number and answers its own code', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        connectorFailure('PEPPOL_DUPLICATE_INVOICE_NUMBER', false, 'Duplicate Invoice, F-2026-42 request rejected!'),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.message).toBe(
      'Mottagaren har redan en faktura med det här numret via Peppol. Behöver den rättas, kreditera den och skapa en ny faktura.',
    )
    expect(body.error.details).toMatchObject({
      reason: 'Duplicate Invoice, F-2026-42 request rejected!',
      code: 'PEPPOL_DUPLICATE_INVOICE_NUMBER',
    })
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_rejected',
      p_normalized_status: 'failed',
      p_is_terminal: true,
      p_detail: 'Duplicate Invoice, F-2026-42 request rejected!',
      p_raw_payload: expect.objectContaining({ error: 'Connector: hosted refusal', code: 'PEPPOL_DUPLICATE_INVOICE_NUMBER' }),
    })
  })

  it('answers the connector refusal of a resend with its own code, not the settings advice', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        connectorFailure('CONNECTOR_PEPPOL_RESEND_NOT_FAILED', false, 'Access point status: processed'),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('CONNECTOR_PEPPOL_RESEND_NOT_FAILED')
    expect(body.error.message).toBe(
      'Peppol-operatören har inte rapporterat den tidigare leveransen som misslyckad, så fakturan skickas inte igen. Vänta på leveransstatusen eller kontakta support.',
    )
    expect(body.error.details).toMatchObject({
      reason: 'Access point status: processed',
      code: 'CONNECTOR_PEPPOL_RESEND_NOT_FAILED',
    })
  })

  describe('says what happened to the invoice when the network does not take it', () => {
    it('a draft that stays issued and booked: PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('CONNECTOR_UNREACHABLE', true)),
      }))
      realCompany()
      grantAccess()
      stageInvoice({ status: 'draft' })

      const response = await send()
      const body = await response.json()

      expect(response.status).toBe(502)
      expect(body.error.code).toBe('PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE')
      expect(body.error.message).toBe(
        'Fakturan är utfärdad och bokförd, men kunde inte skickas via Peppol just nu. Försök igen om en stund, eller skicka PDF:en via e-post.',
      )
      expect(body.error.message_en).toBe(
        'The invoice is issued and booked, but could not be sent via Peppol right now. Try again shortly, or send the PDF by email.',
      )
      expect(body.error.details).toMatchObject({ invoice_status: 'sent', journal_entry_id: 'je-1' })
    })

    it('a draft put back with nothing booked keeps PEPPOL_SUBMISSION_FAILED', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('CONNECTOR_UNREACHABLE', true)),
      }))
      realCompany()
      grantAccess()
      markSentMock.mockResolvedValue({ ok: true, journalEntryId: null, partialFailures: [] })
      stageInvoice({ status: 'draft' })

      const body = await (await send()).json()

      expect(body.error.code).toBe('PEPPOL_SUBMISSION_FAILED')
      expect(body.error.message).toBe(
        'Peppol-operatören kunde inte nås just nu. Fakturan har inte skickats; försök igen om en stund.',
      )
      expect(body.error.details).toEqual({ reason: null, code: 'CONNECTOR_UNREACHABLE' })
    })

    it('an invoice issued and booked before the send says so from its own verifikat', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('CONNECTOR_UPSTREAM_ERROR', false, 'BR-CO-10')),
      }))
      realCompany()
      grantAccess()
      stageInvoice({ status: 'overdue', journal_entry_id: 'je-0' })

      const body = await (await send()).json()

      expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE')
      expect(body.error.message).toBe(
        'Fakturan är utfärdad och bokförd, men Peppol-operatören tog inte emot den: BR-CO-10. Rätta och skicka igen, eller skicka PDF:en via e-post.',
      )
      expect(body.error.details).toMatchObject({ invoice_status: 'overdue', journal_entry_id: 'je-0' })
      expect(markSentMock).not.toHaveBeenCalled()
      expect(restoreDraftMock).not.toHaveBeenCalled()
    })
  })
})
