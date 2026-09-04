import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PeppolTransportError } from '@/lib/invoices/peppol-transport'

let currentKey = {
  id: 'key-1',
  orgNumber: '5561234567',
  instanceUrl: 'https://bokforing.example.se',
  scopes: ['peppol'],
  status: 'active' as const,
  currentPeriodEnd: null as string | null,
  limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, peppol_connections_per_company: 1, sync_min_interval_s: 0 },
}

const h = vi.hoisted(() => ({
  budget: vi.fn(),
  ledger: {
    countHeldConnections: vi.fn(),
    deletePendingConnectionById: vi.fn(),
    createPendingConnection: vi.fn(),
    activateByPendingState: vi.fn(),
    findByAccountUid: vi.fn(),
    revokeByHandle: vi.fn(),
    touchConnection: vi.fn(),
  },
  peppolLedger: {
    countConnectorPeppolRegistrations: vi.fn(),
    findOwnedPeppolSubmission: vi.fn(),
    getPeppolAllowedIdentifiers: vi.fn(),
    isHostedPeppolParticipantLive: vi.fn(),
    isPeppolParticipantHeld: vi.fn(),
    listActivePeppolParticipants: vi.fn(),
    recordPeppolSubmission: vi.fn(),
  },
  registration: { countLivePeppolRegistrations: vi.fn(), getPeppolReceivingCap: vi.fn() },
  transport: {
    provider: 'qvalia',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    pollDeliveryStatus: vi.fn(),
    registerRecipient: vi.fn(),
    unregisterRecipient: vi.fn(),
    listInboundDocuments: vi.fn(),
    fetchInboundDocumentXml: vi.fn(),
  },
  qvaliaConfigured: { value: true },
  archive: { rows: [] as unknown[], single: null as unknown, ins: [] as Array<[string, unknown]> },
}))

vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_op: string, handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request) =>
    handler(req, {
      requestId: 'conn_test',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supabase: {
        from: (table: string) => {
          if (table !== 'peppol_inbound_documents') throw new Error(`unexpected table ${table}`)
          const chain: Record<string, unknown> = {}
          const self = () => chain
          for (const m of ['select', 'eq', 'order']) chain[m] = self
          chain.in = (col: string, vals: unknown) => { h.archive.ins.push([col, vals]); return chain }
          chain.limit = () => Promise.resolve({ data: h.archive.rows, error: null })
          chain.maybeSingle = () => Promise.resolve({ data: h.archive.single, error: null })
          return chain
        },
      },
      key: currentKey,
    }),
}))
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => h.budget(...a) }))
vi.mock('@/lib/connect/hosted/ledger', () => ({ ...h.ledger, hashHandle: (s: string) => `h:${s}` }))
vi.mock('@/lib/connect/hosted/peppol-ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connect/hosted/peppol-ledger')>('@/lib/connect/hosted/peppol-ledger')
  return {
    ...h.peppolLedger,
    peppolHandle: actual.peppolHandle,
    parsePeppolHandle: actual.parsePeppolHandle,
    describePeppolUpstreamFailure: actual.describePeppolUpstreamFailure,
  }
})
vi.mock('@/lib/invoices/peppol-registration', () => h.registration)
vi.mock('@/lib/invoices/transports/qvalia', () => ({
  QVALIA_PROVIDER: 'qvalia',
  readQvaliaConfigFromEnv: () => (h.qvaliaConfigured.value ? { apiKey: 'k' } : null),
  createQvaliaTransport: () => h.transport,
}))

import { POST, PUT, DELETE } from '../route'

const participant = { scheme: '0007', identifier: '5561234567' }
const businessCard = { companyName: 'Testbolaget AB', countryCode: 'SE', orgNumber: '5561234567' }
const documentTypes = [{ processId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0', documentTypeId: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice' }]

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.gnubok.se/api/connect/peppol${path}`, {
    method,
    headers: { 'x-connector-company': 'company-1', 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  currentKey = { ...currentKey, scopes: ['peppol'], limits: { ...currentKey.limits, peppol_connections_per_company: 1 } }
  h.budget.mockResolvedValue({ ok: true })
  h.qvaliaConfigured.value = true
  h.archive.rows = []
  h.archive.single = null
  h.archive.ins = []
  h.ledger.findByAccountUid.mockResolvedValue(null)
  h.ledger.countHeldConnections.mockResolvedValue(0)
  h.ledger.createPendingConnection.mockResolvedValue('pending-1')
  h.ledger.activateByPendingState.mockResolvedValue({ id: 'row-1' })
  h.peppolLedger.isPeppolParticipantHeld.mockResolvedValue(false)
  h.peppolLedger.isHostedPeppolParticipantLive.mockResolvedValue(false)
  h.peppolLedger.countConnectorPeppolRegistrations.mockResolvedValue(0)
  h.peppolLedger.getPeppolAllowedIdentifiers.mockResolvedValue(new Set(['5561234567']))
  h.peppolLedger.listActivePeppolParticipants.mockResolvedValue([participant])
  h.registration.getPeppolReceivingCap.mockReturnValue(null)
  h.registration.countLivePeppolRegistrations.mockResolvedValue(0)
})

describe('scope, configuration and path allowlist', () => {
  it('403s when the key lacks the peppol scope', async () => {
    currentKey = { ...currentKey, scopes: ['bank_sync'] }
    const res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_SCOPE_MISSING')
  })

  it('503s when the hosted access point is not configured', async () => {
    h.qvaliaConfigured.value = false
    const res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('CONNECTOR_UPSTREAM_UNCONFIGURED')
  })

  it('refuses unknown operations', async () => {
    const res = await POST(req('POST', '/partner/123/anything', {}))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_PATH_NOT_ALLOWED')
  })

  it('400s on a malformed body', async () => {
    const res = await POST(req('POST', '/lookup', { participant: { scheme: 'abc', identifier: '' } }))
    expect(res.status).toBe(400)
    expect(h.transport.lookupRecipient).not.toHaveBeenCalled()
  })
})

describe('lookup and submit', () => {
  it('forwards a lookup after reserving budget', async () => {
    h.transport.lookupRecipient.mockResolvedValue({ reachable: true, participant, capabilities: [], checkedAt: 'now' })
    const res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(200)
    expect((await res.json()).reachable).toBe(true)
    expect(h.budget).toHaveBeenCalledWith(expect.anything(), 'peppol')
  })

  it('429s with Retry-After when the global budget is exhausted', async () => {
    h.budget.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 17 })
    const res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('17')
    expect(h.transport.lookupRecipient).not.toHaveBeenCalled()
  })

  const submissionBody = () => ({
    idempotencyKey: 'idem-1',
    tenantReference: 'company-OTHER',
    sender: participant,
    recipient: { scheme: '0007', identifier: '5569876543' },
    documentTypeId: documentTypes[0].documentTypeId,
    processId: documentTypes[0].processId,
    filename: 'inv.xml',
    contentType: 'application/xml',
    document: '<Invoice/>',
    documentSha256: 'a'.repeat(64),
  })

  it('refuses to send as a participant this key has not registered, or registered for another company', async () => {
    h.ledger.findByAccountUid.mockResolvedValue(null)
    let res = await POST(req('POST', '/submit', submissionBody()))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED')
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-other', company_ref: 'company-2' })
    res = await POST(req('POST', '/submit', submissionBody()))
    expect(res.status).toBe(403)
    expect(h.transport.submit).not.toHaveBeenCalled()
  })

  it('submits under the header company and records ownership of the provider submission id', async () => {
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-sender', company_ref: 'company-1' })
    h.transport.submit.mockResolvedValue({ provider: 'qvalia', providerSubmissionId: 'int-9', idempotencyKey: 'idem-1', tenantReference: 'company-1', acceptedAt: 'now' })
    const submission = {
      idempotencyKey: 'idem-1',
      tenantReference: 'company-OTHER',
      sender: participant,
      recipient: { scheme: '0007', identifier: '5569876543' },
      documentTypeId: documentTypes[0].documentTypeId,
      processId: documentTypes[0].processId,
      filename: 'inv.xml',
      contentType: 'application/xml',
      document: '<Invoice/>',
      documentSha256: 'a'.repeat(64),
    }
    const res = await POST(req('POST', '/submit', submission))
    expect(res.status).toBe(200)
    expect(h.transport.submit).toHaveBeenCalledWith(expect.objectContaining({ tenantReference: 'company-1' }))
    expect(h.peppolLedger.recordPeppolSubmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      keyId: 'key-1', companyRef: 'company-1', providerSubmissionId: 'int-9', idempotencyKey: 'idem-1',
    }))
  })

  it('requires the company header for submit', async () => {
    const res = await POST(new Request('https://app.gnubok.se/api/connect/peppol/submit', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONNECTOR_COMPANY_MISSING')
  })

  it('maps a non-retryable provider rejection to 422 and a retryable one to 502', async () => {
    h.transport.lookupRecipient.mockRejectedValueOnce(new PeppolTransportError('rejected', { retryable: false, detail: 'bad id' }))
    let res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'CONNECTOR_UPSTREAM_ERROR', retryable: false, detail: 'bad id' })
    h.transport.lookupRecipient.mockRejectedValueOnce(new PeppolTransportError('down', { retryable: true }))
    res = await POST(req('POST', '/lookup', { participant }))
    expect(res.status).toBe(502)
    expect((await res.json()).retryable).toBe(true)
  })
})

describe('status and evidence are ownership-gated', () => {
  it('404s for a submission this key did not make, and looks it up under the header company', async () => {
    h.peppolLedger.findOwnedPeppolSubmission.mockResolvedValue(null)
    const res = await POST(req('POST', '/status', { providerSubmissionId: 'int-foreign' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('CONNECTOR_NOT_OWNED')
    expect(h.peppolLedger.findOwnedPeppolSubmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keyId: 'key-1', companyRef: 'company-1', providerSubmissionId: 'int-foreign' }))
    expect(h.transport.pollDeliveryStatus).not.toHaveBeenCalled()
    const noCompany = await POST(new Request('https://app.gnubok.se/api/connect/peppol/status', { method: 'POST', body: JSON.stringify({ providerSubmissionId: 'int-9' }) }))
    expect(noCompany.status).toBe(400)
  })

  it('polls and retrieves evidence for an owned submission', async () => {
    h.peppolLedger.findOwnedPeppolSubmission.mockResolvedValue({ id: 's1', company_ref: 'company-1' })
    h.transport.pollDeliveryStatus.mockResolvedValue([{ eventCode: 'status_poll' }])
    h.transport.retrieveEvidence.mockResolvedValue([{ evidenceType: 'qvalia_message_record' }])
    const status = await POST(req('POST', '/status', { providerSubmissionId: 'int-9' }))
    expect(await status.json()).toEqual([{ eventCode: 'status_poll' }])
    const evidence = await POST(req('POST', '/evidence', { providerSubmissionId: 'int-9' }))
    expect(await evidence.json()).toEqual([{ evidenceType: 'qvalia_message_record' }])
  })
})

describe('receiving registration', () => {
  const body = { participant, businessCard, documentTypes }

  it('registers a new participant: reserves quota, calls the access point, activates the ledger row', async () => {
    h.transport.registerRecipient.mockResolvedValue({ status: 'registered', participant, providerAccountReference: '5560000000', raw: { secret: 'x' } })
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ status: 'registered', participant, providerAccountReference: 'accounted-connector', raw: {} })
    expect(h.ledger.createPendingConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ service: 'peppol', companyRef: 'company-1', provider: 'qvalia' }))
    expect(h.ledger.activateByPendingState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ handle: '0007:5561234567', accountUids: ['0007:5561234567'] }))
    expect(h.transport.registerRecipient).toHaveBeenCalledWith(expect.objectContaining({ participant }))
  })

  it('refuses a participant another key already holds, before touching the access point', async () => {
    h.peppolLedger.isPeppolParticipantHeld.mockResolvedValue(true)
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('CONNECTOR_PEPPOL_PARTICIPANT_TAKEN')
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('refuses a participant a hosted company holds', async () => {
    h.peppolLedger.isHostedPeppolParticipantLive.mockResolvedValue(true)
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(409)
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('enforces the per-company quota with a reservation re-count', async () => {
    h.ledger.countHeldConnections.mockResolvedValueOnce(0).mockResolvedValueOnce(2)
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_QUOTA_EXCEEDED')
    expect(h.ledger.deletePendingConnectionById).toHaveBeenCalledWith(expect.anything(), 'pending-1')
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('shares the provider-account cap between hosted companies and connector instances', async () => {
    h.registration.getPeppolReceivingCap.mockReturnValue(10)
    h.registration.countLivePeppolRegistrations.mockResolvedValue(7)
    h.peppolLedger.countConnectorPeppolRegistrations.mockResolvedValue(3)
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PEPPOL_REGISTRATION_CAP_REACHED')
    expect(h.ledger.createPendingConnection).not.toHaveBeenCalled()
  })

  it('re-checks the cap after its own reservation and rolls back when a concurrent registration won', async () => {
    h.registration.getPeppolReceivingCap.mockReturnValue(10)
    h.registration.countLivePeppolRegistrations.mockResolvedValue(7)
    h.peppolLedger.countConnectorPeppolRegistrations.mockResolvedValueOnce(2).mockResolvedValueOnce(4)
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PEPPOL_REGISTRATION_CAP_REACHED')
    expect(h.ledger.deletePendingConnectionById).toHaveBeenCalledWith(expect.anything(), 'pending-1')
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('refuses a participant identifier the key is not authorized to publish', async () => {
    h.peppolLedger.getPeppolAllowedIdentifiers.mockResolvedValue(new Set(['5560000001']))
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED')
    expect(h.peppolLedger.isPeppolParticipantHeld).not.toHaveBeenCalled()
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('refuses to register through an access point that cannot deregister', async () => {
    const original = h.transport.unregisterRecipient
    ;(h.transport as { unregisterRecipient?: unknown }).unregisterRecipient = undefined
    try {
      const res = await PUT(req('PUT', '/recipient', body))
      expect(res.status).toBe(422)
      expect((await res.json()).code).toBe('PEPPOL_RECEIVING_UNSUPPORTED')
      const del = await DELETE(req('DELETE', '/recipient?scheme=0007&identifier=5561234567'))
      expect(del.status).toBe(404)
      h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-1', company_ref: 'company-1' })
      const del2 = await DELETE(req('DELETE', '/recipient?scheme=0007&identifier=5561234567'))
      expect(del2.status).toBe(422)
      expect(h.ledger.revokeByHandle).not.toHaveBeenCalled()
    } finally {
      h.transport.unregisterRecipient = original
    }
  })

  it('rolls the reservation back when the access point rejects', async () => {
    h.transport.registerRecipient.mockRejectedValue(new PeppolTransportError('nope', { retryable: false }))
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(422)
    expect(h.ledger.deletePendingConnectionById).toHaveBeenCalledWith(expect.anything(), 'pending-1')
  })

  it('unregisters upstream and answers 409 when activation loses the participant race', async () => {
    h.transport.registerRecipient.mockResolvedValue({ status: 'registered', participant, providerAccountReference: 'x', raw: {} })
    h.ledger.activateByPendingState.mockRejectedValue(new Error('duplicate key value violates unique constraint "idx_connector_connections_handle"'))
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(409)
    expect(h.transport.unregisterRecipient).toHaveBeenCalledWith(participant)
    expect(h.ledger.deletePendingConnectionById).toHaveBeenCalledWith(expect.anything(), 'pending-1')
  })

  it('refuses to touch a participant this key holds for another company', async () => {
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-2', company_ref: 'company-2' })
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(409)
    expect(h.transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('re-registers an owned participant without consuming quota', async () => {
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-1', company_ref: 'company-1' })
    h.transport.registerRecipient.mockResolvedValue({ status: 'updated', participant, providerAccountReference: 'x', raw: {} })
    const res = await PUT(req('PUT', '/recipient', body))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('updated')
    expect(h.ledger.createPendingConnection).not.toHaveBeenCalled()
    expect(h.ledger.touchConnection).toHaveBeenCalledWith(expect.anything(), 'row-1')
  })

  it('DELETE unregisters only an owned participant of the header company and revokes the ledger row', async () => {
    let res = await DELETE(req('DELETE', '/recipient?scheme=0007&identifier=5561234567'))
    expect(res.status).toBe(404)
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-2', company_ref: 'company-2' })
    res = await DELETE(req('DELETE', '/recipient?scheme=0007&identifier=5561234567'))
    expect(res.status).toBe(404)
    expect(h.transport.unregisterRecipient).not.toHaveBeenCalled()
    h.ledger.findByAccountUid.mockResolvedValue({ id: 'row-1', company_ref: 'company-1' })
    res = await DELETE(req('DELETE', '/recipient?scheme=0007&identifier=5561234567'))
    expect(res.status).toBe(204)
    expect(h.transport.unregisterRecipient).toHaveBeenCalledWith(participant)
    expect(h.ledger.revokeByHandle).toHaveBeenCalledWith(expect.anything(), { keyId: 'key-1', service: 'peppol', handle: '0007:5561234567' })
  })
})

describe('inbound documents come from the hosted archive, scoped to owned participants', () => {
  it('lists only documents addressed to a participant this key holds', async () => {
    h.archive.rows = [
      { provider_document_id: 'doc-1', document_type: 'Invoice', ubl_json: { a: 1 }, received_at: 't1', recipient_scheme: '0007', recipient_identifier: '5561234567' },
      { provider_document_id: 'doc-2', document_type: 'Invoice', ubl_json: { b: 2 }, received_at: 't2', recipient_scheme: '0088', recipient_identifier: '5561234567' },
    ]
    const res = await POST(req('POST', '/inbound/list', { documentType: 'Invoice', limit: 10 }))
    expect(res.status).toBe(200)
    const items = await res.json()
    expect(items).toEqual([{ provider: 'qvalia', providerDocumentId: 'doc-1', documentType: 'Invoice', payload: { a: 1 }, receivedAt: 't1' }])
    // One query per scheme with that scheme's identifiers: exact pairs, so
    // neither foreign nor cross-pair rows can consume the limit.
    expect(h.archive.ins).toEqual([['recipient_identifier', ['5561234567']]])
    expect(h.transport.listInboundDocuments).not.toHaveBeenCalled()
  })

  it('answers an empty list without touching the archive when the key holds no participant', async () => {
    h.peppolLedger.listActivePeppolParticipants.mockResolvedValue([])
    const res = await POST(req('POST', '/inbound/list', { documentType: 'Invoice' }))
    expect(await res.json()).toEqual([])
  })

  it('serves the archived XML for an owned document and 404s otherwise', async () => {
    h.archive.single = { xml_payload: '<Invoice/>', recipient_scheme: '0007', recipient_identifier: '5561234567' }
    let res = await POST(req('POST', '/inbound/xml', { providerDocumentId: 'doc-1', documentType: 'Invoice' }))
    expect(await res.json()).toEqual({ xml: '<Invoice/>' })
    h.archive.single = { xml_payload: '<Invoice/>', recipient_scheme: '0007', recipient_identifier: '5569999999' }
    res = await POST(req('POST', '/inbound/xml', { providerDocumentId: 'doc-1', documentType: 'Invoice' }))
    expect(res.status).toBe(404)
  })

  it('fetches the XML live when the archive only holds JSON', async () => {
    h.archive.single = { xml_payload: null, recipient_scheme: '0007', recipient_identifier: '5561234567' }
    h.transport.fetchInboundDocumentXml.mockResolvedValue('<CreditNote/>')
    const res = await POST(req('POST', '/inbound/xml', { providerDocumentId: 'doc-1', documentType: 'CreditNote' }))
    expect(await res.json()).toEqual({ xml: '<CreditNote/>' })
    expect(h.transport.fetchInboundDocumentXml).toHaveBeenCalledWith('doc-1', 'CreditNote')
  })
})
