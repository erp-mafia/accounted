/**
 * The session routes of BankID document signing: GET and POST
 * /api/signing-requests (the company's requests, and send a document for
 * signing), GET /api/signing-requests/:id (one request, sealed again when the
 * seal never landed), POST /:id/cancel and POST /:id/signers/:signerId/remind.
 * The rules live in lib/signing/requests.ts and are tested there; here the
 * doors: a session, the body, the not-found answer and what reaches the
 * service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const service = vi.hoisted(() => ({
  createSigningRequest: vi.fn(),
  listSigningRequests: vi.fn(),
  getSigningRequest: vi.fn(),
  cancelSigningRequest: vi.fn(),
  remindSigner: vi.fn(),
}))
vi.mock('@/lib/signing/requests', () => service)
const sealing = vi.hoisted(() => ({ ensureSealed: vi.fn() }))
vi.mock('@/lib/signing/seal', () => sealing)

import { requireWritePermission } from '@/lib/auth/require-write'
import { GET as listRequests, POST as createRequest } from '../route'
import { GET as getRequest } from '../[id]/route'
import { POST as cancelRequest } from '../[id]/cancel/route'
import { POST as remind } from '../[id]/signers/[signerId]/remind/route'

const DOC = '11111111-1111-4111-8111-111111111111'
const REQ = '22222222-2222-4222-8222-222222222222'
const SIGNER = '33333333-3333-4333-8333-333333333333'
const MEMBER = '44444444-4444-4444-8444-444444444444'
const noParams = { params: Promise.resolve({}) }
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })
const signerParams = (id: string, signerId: string) => ({ params: Promise.resolve({ id, signerId }) })
const post = (url: string, body?: unknown) => createMockRequest(url, { method: 'POST', ...(body === undefined ? {} : { body }) })

type ErrorBody = { error: { code: string } }

const validBody = {
  document_id: DOC,
  title: 'Hyresavtal',
  message: 'Hej',
  expires_in_days: 30,
  send_email: true,
  signers: [
    { name: 'Anna Andersson', email: 'anna@example.se', role_label: 'VD', personal_number: '199001011239' },
    { name: 'Erik Eriksson', user_id: MEMBER },
  ],
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    signing_request_id: REQ,
    title: 'Hyresavtal',
    state: 'open',
    completed_at: null,
    signed_document_id: null,
    evidence_document_id: null,
    signers: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  service.createSigningRequest.mockResolvedValue({
    ok: true,
    created: true,
    data: { signing_request_id: REQ, status: 'open', title: 'Hyresavtal', document_id: DOC, document_sha256: 'ab'.repeat(32), expires_at: '2026-11-08T10:00:00.000Z', signers: [] },
  })
  service.listSigningRequests.mockResolvedValue([view()])
  service.getSigningRequest.mockResolvedValue({ ok: true, data: view() })
  service.cancelSigningRequest.mockResolvedValue({ ok: true, data: { signing_request_id: REQ, cancelled: true } })
  service.remindSigner.mockResolvedValue({ ok: true, data: { signing_request_id: REQ, signer_id: SIGNER, email_sent: true, url: null } })
  sealing.ensureSealed.mockResolvedValue(undefined)
})

describe('signing request routes without a session', () => {
  it.each([
    ['GET /api/signing-requests', () => listRequests(createMockRequest('/api/signing-requests'), noParams)],
    ['POST /api/signing-requests', () => createRequest(post('/api/signing-requests', validBody), noParams)],
    ['GET /api/signing-requests/:id', () => getRequest(createMockRequest(`/api/signing-requests/${REQ}`), idParams(REQ))],
    ['POST /api/signing-requests/:id/cancel', () => cancelRequest(post(`/api/signing-requests/${REQ}/cancel`), idParams(REQ))],
    ['POST /api/signing-requests/:id/signers/:signerId/remind', () => remind(post(`/api/signing-requests/${REQ}/signers/${SIGNER}/remind`), signerParams(REQ, SIGNER))],
  ])('%s answers 401', async (_name, call) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await call()).status).toBe(401)
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('POST /api/signing-requests', () => {
  it('validates the document, the title, the expiry and every signer', async () => {
    const bodies: unknown[] = [
      {},
      { ...validBody, document_id: 'not-a-uuid' },
      { ...validBody, title: '   ' },
      { ...validBody, title: 'x'.repeat(201) },
      { ...validBody, message: 'x'.repeat(1001) },
      { ...validBody, expires_in_days: 0 },
      { ...validBody, expires_in_days: 91 },
      { ...validBody, expires_in_days: 1.5 },
      { ...validBody, signers: [] },
      { ...validBody, signers: Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i}` })) },
      { ...validBody, signers: [{ name: '' }] },
      { ...validBody, signers: [{ name: 'Anna', email: 'not-an-email' }] },
      { ...validBody, signers: [{ name: 'Anna', user_id: 'not-a-uuid' }] },
      { ...validBody, signers: [{ name: 'Anna', personal_number: '1'.repeat(21) }] },
      { ...validBody, signers: [{ name: 'Anna', annual_report_signature_id: DOC }] },
      { ...validBody, annual_report_version_id: DOC },
      { ...validBody, created_via: 'mcp' },
    ]
    for (const body of bodies) {
      expect((await createRequest(post('/api/signing-requests', body), noParams)).status, JSON.stringify(body).slice(0, 120)).toBe(400)
    }
    expect(service.createSigningRequest).not.toHaveBeenCalled()
  })

  it('sends the document for signing as the person signed in, for the active company, through the app door', async () => {
    const { status, body } = await parseJsonResponse<{ data: { signing_request_id: string } }>(await createRequest(post('/api/signing-requests', validBody), noParams))
    expect(status).toBe(201)
    expect(body.data.signing_request_id).toBe(REQ)
    expect(service.createSigningRequest).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), {
      documentId: DOC,
      title: 'Hyresavtal',
      message: 'Hej',
      expiresInDays: 30,
      sendEmail: true,
      createdVia: 'app',
      signers: [
        { name: 'Anna Andersson', email: 'anna@example.se', roleLabel: 'VD', userId: undefined, personalNumber: '199001011239' },
        { name: 'Erik Eriksson', email: undefined, roleLabel: undefined, userId: MEMBER, personalNumber: undefined },
      ],
    })
  })

  it('needs write access to the company', async () => {
    vi.mocked(requireWritePermission).mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'Läsbehörighet' }, { status: 403 }) } as never)
    expect((await createRequest(post('/api/signing-requests', validBody), noParams)).status).toBe(403)
    expect(service.createSigningRequest).not.toHaveBeenCalled()
  })

  it('answers a refusal of the rules in its envelope', async () => {
    for (const [code, http] of [['SIGNING_UNAVAILABLE', 403], ['SIGNING_SIGNERS_INVALID', 400], ['SIGNING_DOCUMENT_UNSUPPORTED', 422], ['SIGNING_DOCUMENT_CHANGED', 409]] as const) {
      service.createSigningRequest.mockResolvedValue({ ok: false, code })
      const { status, body } = await parseJsonResponse<ErrorBody>(await createRequest(post('/api/signing-requests', validBody), noParams))
      expect([status, body.error.code]).toEqual([http, code])
    }
  })
})

describe('GET /api/signing-requests', () => {
  it('lists the active company\'s requests, by document and status when asked', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listRequests(createMockRequest('/api/signing-requests', { searchParams: { document_id: DOC, status: 'completed' } }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(service.listSigningRequests).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), { documentId: DOC, status: 'completed' })
  })

  it('lists the board\'s requests on one årsredovisning version', async () => {
    const VERSION = '55555555-5555-4555-8555-555555555555'
    await listRequests(createMockRequest('/api/signing-requests', { searchParams: { annual_report_version_id: VERSION } }), noParams)
    expect(service.listSigningRequests).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), { documentId: undefined, status: undefined, annualReportVersionId: VERSION })
  })

  it('ignores a filter that does not parse instead of failing', async () => {
    expect((await listRequests(createMockRequest('/api/signing-requests', { searchParams: { document_id: 'x', status: 'whatever' } }), noParams)).status).toBe(200)
    expect(service.listSigningRequests).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), { documentId: undefined, status: undefined })
  })
})

describe('GET /api/signing-requests/:id', () => {
  it('answers 404 for a malformed id without asking the service, and for an unknown request', async () => {
    const malformed = await parseJsonResponse<ErrorBody>(await getRequest(createMockRequest('/api/signing-requests/x'), idParams('x')))
    expect([malformed.status, malformed.body.error.code]).toEqual([404, 'SIGNING_REQUEST_NOT_FOUND'])
    expect(service.getSigningRequest).not.toHaveBeenCalled()
    service.getSigningRequest.mockResolvedValue({ ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' })
    expect((await getRequest(createMockRequest(`/api/signing-requests/${REQ}`), idParams(REQ))).status).toBe(404)
  })

  it('answers the request of the active company', async () => {
    const { status, body } = await parseJsonResponse<{ data: { signing_request_id: string } }>(await getRequest(createMockRequest(`/api/signing-requests/${REQ}`), idParams(REQ)))
    expect(status).toBe(200)
    expect(body.data.signing_request_id).toBe(REQ)
    expect(service.getSigningRequest).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), REQ)
    expect(sealing.ensureSealed).not.toHaveBeenCalled()
  })

  it('seals again a completed request without its copies, and answers it read again', async () => {
    service.getSigningRequest
      .mockResolvedValueOnce({ ok: true, data: view({ state: 'completed', completed_at: '2026-10-25T09:00:00.000Z' }) })
      .mockResolvedValueOnce({ ok: true, data: view({ state: 'completed', completed_at: '2026-10-25T09:00:00.000Z', signed_document_id: 'signed', evidence_document_id: 'evidence' }) })
    const { status, body } = await parseJsonResponse<{ data: { signed_document_id: string } }>(await getRequest(createMockRequest(`/api/signing-requests/${REQ}`), idParams(REQ)))
    expect(status).toBe(200)
    expect(body.data.signed_document_id).toBe('signed')
    expect(sealing.ensureSealed).toHaveBeenCalledWith(
      mockSupabase,
      { id: REQ, status: 'completed', completed_at: '2026-10-25T09:00:00.000Z', signed_document_id: null, evidence_document_id: null },
      expect.anything(),
    )
    expect(service.getSigningRequest).toHaveBeenCalledTimes(2)
  })
})

describe('POST /api/signing-requests/:id/cancel', () => {
  it('answers 404 for a malformed id without asking the service, and for an unknown request', async () => {
    const malformed = await parseJsonResponse<ErrorBody>(await cancelRequest(post('/api/signing-requests/x/cancel'), idParams('x')))
    expect([malformed.status, malformed.body.error.code]).toEqual([404, 'SIGNING_REQUEST_NOT_FOUND'])
    expect(service.cancelSigningRequest).not.toHaveBeenCalled()
    service.cancelSigningRequest.mockResolvedValue({ ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' })
    expect((await cancelRequest(post(`/api/signing-requests/${REQ}/cancel`), idParams(REQ))).status).toBe(404)
  })

  it('cancels as the person signed in', async () => {
    const { status, body } = await parseJsonResponse<{ data: { cancelled: boolean } }>(await cancelRequest(post(`/api/signing-requests/${REQ}/cancel`), idParams(REQ)))
    expect(status).toBe(200)
    expect(body.data.cancelled).toBe(true)
    expect(service.cancelSigningRequest).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), { signingRequestId: REQ })
  })

  it('answers the refusals in their envelope', async () => {
    service.cancelSigningRequest.mockResolvedValue({ ok: false, code: 'FORBIDDEN', messageSv: 'Bara den som skickade signeringen ...' })
    expect((await cancelRequest(post(`/api/signing-requests/${REQ}/cancel`), idParams(REQ))).status).toBe(403)
    service.cancelSigningRequest.mockResolvedValue({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect((await cancelRequest(post(`/api/signing-requests/${REQ}/cancel`), idParams(REQ))).status).toBe(409)
  })
})

describe('POST /api/signing-requests/:id/signers/:signerId/remind', () => {
  it('answers 404 for a malformed request or signer id without asking the service', async () => {
    for (const [id, signerId] of [['x', SIGNER], [REQ, 'x']]) {
      const res = await parseJsonResponse<ErrorBody>(await remind(post(`/api/signing-requests/${id}/signers/${signerId}/remind`), signerParams(id!, signerId!)))
      expect([res.status, res.body.error.code]).toEqual([404, 'SIGNING_SIGNER_NOT_FOUND'])
    }
    expect(service.remindSigner).not.toHaveBeenCalled()
    service.remindSigner.mockResolvedValue({ ok: false, code: 'SIGNING_SIGNER_NOT_FOUND' })
    expect((await remind(post(`/api/signing-requests/${REQ}/signers/${SIGNER}/remind`), signerParams(REQ, SIGNER))).status).toBe(404)
  })

  it('reminds as the person signed in', async () => {
    const { status, body } = await parseJsonResponse<{ data: { email_sent: boolean } }>(await remind(post(`/api/signing-requests/${REQ}/signers/${SIGNER}/remind`), signerParams(REQ, SIGNER)))
    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(true)
    expect(service.remindSigner).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), { signingRequestId: REQ, signerId: SIGNER })
  })

  it('answers once a day with 429 and a signing in progress with 409', async () => {
    service.remindSigner.mockResolvedValue({ ok: false, code: 'SIGNING_REMIND_TOO_SOON' })
    expect((await remind(post(`/api/signing-requests/${REQ}/signers/${SIGNER}/remind`), signerParams(REQ, SIGNER))).status).toBe(429)
    service.remindSigner.mockResolvedValue({ ok: false, code: 'SIGNING_SESSION_ACTIVE' })
    expect((await remind(post(`/api/signing-requests/${REQ}/signers/${SIGNER}/remind`), signerParams(REQ, SIGNER))).status).toBe(409)
  })
})
