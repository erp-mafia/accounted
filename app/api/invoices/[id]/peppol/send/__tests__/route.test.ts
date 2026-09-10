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

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const serviceTables = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const serviceRpcMock = vi.fn()
const issueAndBookMock = vi.fn()

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
  issueAndBookInvoice: (...args: unknown[]) => issueAndBookMock(...args),
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

/** The service-role RPC echoes the event's status back as the projection. */
function serviceRpcEcho() {
  serviceRpcMock.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({
    data: {
      ...stagedDelivery,
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
    process.env.QVALIA_PARTNER_REG_NO = 'SE5560000000'
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
    issueAndBookMock.mockResolvedValue({ ok: true, journalEntryId: 'je-1', partialFailures: [] })
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    delete process.env.QVALIA_PARTNER_REG_NO
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
    expect((await response.json()).error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
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

  it('answers 422 with the same code when the lookup failure is not retryable', async () => {
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

    expect(response.status).toBe(422)
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
      expect((call[1] as Record<string, unknown>).p_provider_tenant_id).toBe('SE5560000000')
    }
    expect(issueAndBookMock).not.toHaveBeenCalled()
    expect(logMock.info).not.toHaveBeenCalledWith('peppol send refused', expect.anything())
  })

  it('issues and books a draft only after the network accepted it', async () => {
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
    expect(issueAndBookMock).toHaveBeenCalledTimes(1)
    const submitOrder = (transport.submit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const issueOrder = issueAndBookMock.mock.invocationCallOrder[0]
    expect(submitOrder).toBeLessThan(issueOrder)
  })

  it('reports a failed issuance without pretending the network send did not happen', async () => {
    unregister = registerPeppolTransport(makeTransport())
    realCompany()
    grantAccess()
    issueAndBookMock.mockResolvedValue({ ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' })
    stageInvoice({ status: 'draft' })

    const response = await send()
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data).toMatchObject({
      network_submitted: true,
      invoice_status: 'draft',
      issuance: { ok: false, error_code: 'INVOICE_MARK_SENT_RACE' },
    })
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
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED')
    expect(body.error.details.reason).toContain('BR-CO-10')
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_rejected',
      p_normalized_status: 'failed',
      p_is_terminal: true,
    })
    expect(issueAndBookMock).not.toHaveBeenCalled()
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
    expect(body.error.code).toBe('PEPPOL_SUBMISSION_REJECTED')
    expect(body.error.details).toEqual({
      reason: 'BR-CO-10 Sum of invoice line net amount',
      code: 'CONNECTOR_UPSTREAM_ERROR',
    })
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_rejected',
      p_normalized_status: 'failed',
      p_is_terminal: true,
    })
  })

  it('records a retryable failure and answers 502 when the access point is unreachable', async () => {
    const transport = makeTransport({
      submit: vi.fn().mockRejectedValue(
        new PeppolTransportError('Could not reach Qvalia', { retryable: true }),
      ),
    })
    unregister = registerPeppolTransport(transport)
    realCompany()
    grantAccess()
    stageInvoice()

    const response = await send()

    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('PEPPOL_SUBMISSION_FAILED')
    const last = serviceRpcMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last).toMatchObject({
      p_provider_event_code: 'submit_failed',
      p_normalized_status: 'retryable_failure',
      p_is_terminal: false,
    })
  })

  describe('hosted precondition answers never become a verdict on the document', () => {
    const preconditionCodes = [
      'CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED',
      'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
      'CONNECTOR_QUOTA_EXCEEDED',
      'CONNECTOR_RATE_LIMITED',
      'CONNECTOR_SCOPE_MISSING',
      'CONNECTOR_UPSTREAM_UNCONFIGURED',
      'CONNECTOR_LEDGER_FAILED',
      'CONNECTOR_UNREACHABLE',
      'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
      'HTTP_502',
    ]

    it.each(preconditionCodes)('%s stays resendable: 409, retryable_failure, and the same XML is submitted again', async (code) => {
      // Non-retryable on the wire on purpose: the code decides, not the flag.
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
      expect(body.error.details).toEqual({ reason: 'hosted detail', code })
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

    it('composes the hosted text onto the prefix when the registry knows the code', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('CONNECTOR_QUOTA_EXCEEDED', false)),
      }))
      realCompany()
      grantAccess()
      stageInvoice()

      const body = await (await send()).json()

      expect(body.error.message).toBe(
        'Fakturan kunde inte skickas via Peppol ännu: Kontots Peppol-platser är förbrukade. Hör av dig till support så öppnar vi fler.',
      )
      expect(body.error.message_en).toBe(
        'The invoice could not be sent via Peppol yet: The account has used its Peppol slots. Contact support and we will open more.',
      )
    })

    it('falls back to the settings pointer for a code the registry does not know', async () => {
      unregister = registerPeppolTransport(makeTransport({
        submit: vi.fn().mockRejectedValue(connectorFailure('HTTP_502', false)),
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

  it('refuses to resend an exact document the access point already rejected', async () => {
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
})
