/**
 * The token routes of the signer's link under /api/signera/[token]: the link
 * is the authentication (every bad token is the same 404, never a 401), the
 * token is looked up by its hash, the limiter bounds a leaked link with its
 * own budget for the poll, and each route hands the resolved signer to the
 * ceremony (lib/signing/ceremony.ts, tested there). The describe route runs
 * for real against a table mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { hashSigningToken } from '@/lib/signing/tokens'

const db = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => db.supabase }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.supabase, createClient: () => Promise.resolve(db.supabase) }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))

const ceremony = vi.hoisted(() => ({
  startSignature: vi.fn(),
  pollSignature: vi.fn(),
  cancelSignatureSession: vi.fn(),
  declineSignature: vi.fn(),
}))
vi.mock('@/lib/signing/ceremony', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/signing/ceremony')>()),
  ...ceremony,
}))

import { GET as describeRoute } from '../[token]/route'
import { GET as documentRoute } from '../[token]/document/route'
import { POST as startRoute } from '../[token]/start/route'
import { POST as pollRoute } from '../[token]/poll/route'
import { POST as cancelRoute } from '../[token]/cancel/route'
import { POST as declineRoute } from '../[token]/decline/route'

const COMPANY = '33333333-3333-4333-8333-333333333333'
const SENDER = '44444444-4444-4444-8444-444444444444'
const DOC = '66666666-6666-4666-8666-666666666666'
const REQ = '77777777-7777-4777-8777-777777777777'
const SIGNER = '88888888-8888-4888-8888-888888888888'
const DAY = 24 * 60 * 60 * 1000
const EXPIRES = new Date(Date.now() + 14 * DAY).toISOString()

let tokenCounter = 0
function freshToken(): string {
  tokenCounter += 1
  return `${String(tokenCounter).padStart(6, '0')}${'s'.repeat(37)}`
}

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQ,
    company_id: COMPANY,
    created_by: SENDER,
    created_via: 'app',
    document_id: DOC,
    document_sha256: 'ab'.repeat(32),
    title: 'Hyresavtal',
    message: 'Hej, skriv under',
    annual_report_version_id: null,
    status: 'open',
    expires_at: EXPIRES,
    completed_at: null,
    declined_at: null,
    cancelled_at: null,
    signed_document_id: null,
    evidence_document_id: null,
    created_at: new Date(Date.now() - DAY).toISOString(),
    ...overrides,
  }
}

function signerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SIGNER,
    company_id: COMPANY,
    signing_request_id: REQ,
    position: 1,
    name: 'Anna Andersson',
    email: 'anna@example.se',
    role_label: 'VD',
    user_id: null,
    lock_kind: 'personnummer',
    annual_report_signature_id: null,
    link_sent_at: null,
    last_reminded_at: null,
    status: 'pending',
    bankid_session_id: null,
    bankid_session_started_at: null,
    signed_at: null,
    bankid_given_name: null,
    bankid_surname: null,
    declined_at: null,
    decline_reason: null,
    last_error_code: null,
    created_at: new Date(Date.now() - DAY).toISOString(),
    ...overrides,
  }
}

const params = (token: string) => ({ params: Promise.resolve({ token }) })
const get = (path: string) => createMockRequest(path)
const post = (path: string, body?: unknown) =>
  createMockRequest(path, { method: 'POST', ...(body === undefined ? {} : { body }), headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Browser/1.0' } })

type ErrorBody = { error: { code: string } }

let signer: Record<string, unknown> | null
let downloaded: { data: Blob | null; error: unknown }

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  signer = signerRow()
  db.setTable('signing_request_signers', (calls) =>
    calls.some((c) => c.method === 'order')
      ? { data: [{ position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending' }, { position: 2, name: 'Erik Eriksson', role_label: null, status: 'signed' }] }
      : { data: signer },
  )
  db.setTable('signing_requests', { data: requestRow() })
  db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null, archived_at: null } })
  db.setTable('profiles', { data: { full_name: 'Karin Byråsson' } })
  db.setTable('document_attachments', { data: { file_name: 'hyresavtal.pdf', storage_path: `documents/${COMPANY}/${DOC}.pdf` } })
  downloaded = { data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }
  Object.assign(db.supabase, { storage: { from: vi.fn(() => ({ download: vi.fn(async () => downloaded) })) } })
  ceremony.startSignature.mockResolvedValue({ ok: true, data: { auto_start_token: 'auto', qr_start_token: 'qr', qr_start_secret: 'secret', expires_at: '2026-10-25T10:03:00.000Z' } })
  ceremony.pollSignature.mockResolvedValue({ ok: true, data: { state: 'pending', hint_code: null, qr_start_token: 'qr', qr_start_secret: 'secret' } })
  ceremony.cancelSignatureSession.mockResolvedValue({ ok: true, data: { cancelled: true } })
  ceremony.declineSignature.mockResolvedValue({ ok: true, data: { declined: true } })
})

describe('the signing token routes refuse what is not a live link', () => {
  it('answers 404 NOT_FOUND for a malformed token without reading the database', async () => {
    for (const call of [() => describeRoute(get('/api/signera/short'), params('short')), () => startRoute(post('/api/signera/short/start'), params('short'))]) {
      const { status, body } = await parseJsonResponse<ErrorBody>(await call())
      expect([status, body.error.code]).toEqual([404, 'NOT_FOUND'])
    }
    expect(db.supabase.from).not.toHaveBeenCalled()
    expect(ceremony.startSignature).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown token, looked up by its hash', async () => {
    const token = freshToken()
    signer = null
    const { status, body } = await parseJsonResponse<ErrorBody>(await startRoute(post(`/api/signera/${token}/start`), params(token)))
    expect([status, body.error.code]).toEqual([404, 'NOT_FOUND'])
    expect(db.findCall('signing_request_signers', 'eq')).toEqual(['token_hash', hashSigningToken(token)])
    expect(JSON.stringify(db.calls)).not.toContain(token)
    expect(ceremony.startSignature).not.toHaveBeenCalled()
  })

  it('answers 404 for a link of an archived company', async () => {
    const token = freshToken()
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null, archived_at: new Date().toISOString() } })
    expect((await describeRoute(get(`/api/signera/${token}`), params(token))).status).toBe(404)
  })

  it('answers 429 RATE_LIMITED past 60 requests per token in ten minutes; the poll has its own budget', async () => {
    const token = freshToken()
    for (let i = 0; i < 60; i += 1) expect((await describeRoute(get(`/api/signera/${token}`), params(token))).status).toBe(200)
    const { status, body } = await parseJsonResponse<ErrorBody>(await describeRoute(get(`/api/signera/${token}`), params(token)))
    expect([status, body.error.code]).toEqual([429, 'RATE_LIMITED'])
    expect((await pollRoute(post(`/api/signera/${token}/poll`), params(token))).status).toBe(200)
  })
})

describe('GET /api/signera/:token', () => {
  it('shows the signer\'s page: the document, who asks, everyone asked, without an address or a personnummer', async () => {
    const token = freshToken()
    const res = await describeRoute(get(`/api/signera/${token}`), params(token))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      request: {
        title: 'Hyresavtal',
        message: 'Hej, skriv under',
        company_name: 'Bolaget AB',
        requester: 'Karin Byråsson',
        file_name: 'hyresavtal.pdf',
        sha256: 'ab'.repeat(32),
        state: 'open',
        expires_at: EXPIRES,
        signed_copy: false,
      },
      signer: { position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending', signed_at: null, bankid_name: null, locked: true, last_error_code: null },
      signers: [
        { position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending' },
        { position: 2, name: 'Erik Eriksson', role_label: null, status: 'signed' },
      ],
    })
    expect(JSON.stringify(body)).not.toContain('anna@example.se')
  })

  it('says expired for an open request past its expiry, still with a 200 so the page can tell the signer', async () => {
    const token = freshToken()
    db.setTable('signing_requests', { data: requestRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) })
    const { status, body } = await parseJsonResponse<{ data: { request: { state: string } } }>(await describeRoute(get(`/api/signera/${token}`), params(token)))
    expect([status, body.data.request.state]).toEqual([200, 'expired'])
  })
})

describe('GET /api/signera/:token/document', () => {
  it('answers the request\'s own PDF inline, never cached or sniffed', async () => {
    const token = freshToken()
    const res = await documentRoute(get(`/api/signera/${token}/document`), params(token))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('inline')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    expect(db.findCalls('document_attachments', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY], ['id', DOC]]))
  })

  it('answers the signed copy as a download with ?copy=signed once everyone has signed and it is sealed', async () => {
    const token = freshToken()
    db.setTable('signing_requests', { data: requestRow({ status: 'completed', completed_at: new Date().toISOString(), signed_document_id: 'signed-doc', evidence_document_id: 'evidence-doc' }) })
    const res = await documentRoute(get(`/api/signera/${token}/document?copy=signed`), params(token))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(db.findCalls('document_attachments', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY], ['id', 'signed-doc']]))
    expect(db.findCalls('document_attachments', 'eq')).not.toEqual(expect.arrayContaining([['id', 'evidence-doc']]))
  })

  it('answers 404 for ?copy=signed before the request is completed and sealed, without reading the archive', async () => {
    const token = freshToken()
    expect((await documentRoute(get(`/api/signera/${token}/document?copy=signed`), params(token))).status).toBe(404)
    db.setTable('signing_requests', { data: requestRow({ status: 'completed', completed_at: new Date().toISOString() }) })
    expect((await documentRoute(get(`/api/signera/${token}/document?copy=signed`), params(token))).status).toBe(404)
    expect(db.findCalls('document_attachments', 'eq')).toEqual([])
  })

  it('answers 404 when the document or its file is gone', async () => {
    const token = freshToken()
    downloaded = { data: null, error: { message: 'Object not found' } }
    expect((await documentRoute(get(`/api/signera/${token}/document`), params(token))).status).toBe(404)
    db.setTable('document_attachments', { data: null })
    expect((await documentRoute(get(`/api/signera/${token}/document`), params(token))).status).toBe(404)
  })
})

describe('the ceremony routes hand the resolved signer to the ceremony', () => {
  it('starts with the forwarded client IP and user agent, and answers the start tokens', async () => {
    const token = freshToken()
    const { status, body } = await parseJsonResponse<{ data: { qr_start_token: string } }>(await startRoute(post(`/api/signera/${token}/start`), params(token)))
    expect([status, body.data.qr_start_token]).toEqual([200, 'qr'])
    const [scope, input] = ceremony.startSignature.mock.calls[0]!
    expect(scope).toMatchObject({ request: { id: REQ }, signer: { id: SIGNER } })
    expect(input).toEqual({ endUserIp: '203.0.113.9', userAgent: 'Browser/1.0' })
  })

  it('answers the ceremony\'s refusals in their envelope', async () => {
    const token = freshToken()
    for (const [code, http] of [['SIGNING_REQUEST_CLOSED', 409], ['SIGNING_RATE_LIMITED', 429], ['SIGNING_SIGNER_MISMATCH', 403], ['SIGNING_UNAVAILABLE', 403]] as const) {
      ceremony.startSignature.mockResolvedValue({ ok: false, code })
      const { status, body } = await parseJsonResponse<ErrorBody>(await startRoute(post(`/api/signera/${token}/start`), params(token)))
      expect([status, body.error.code]).toEqual([http, code])
    }
    ceremony.pollSignature.mockResolvedValue({ ok: false, code: 'SIGNING_SIGNATURE_UNBOUND' })
    expect((await pollRoute(post(`/api/signera/${token}/poll`), params(token))).status).toBe(502)
  })

  it('polls and stops the signer\'s session', async () => {
    const token = freshToken()
    const polled = await parseJsonResponse<{ data: { state: string } }>(await pollRoute(post(`/api/signera/${token}/poll`), params(token)))
    expect([polled.status, polled.body.data.state]).toEqual([200, 'pending'])
    expect(ceremony.pollSignature.mock.calls[0]![0]).toMatchObject({ signer: { id: SIGNER } })
    const cancelled = await parseJsonResponse<{ data: { cancelled: boolean } }>(await cancelRoute(post(`/api/signera/${token}/cancel`), params(token)))
    expect([cancelled.status, cancelled.body.data.cancelled]).toEqual([200, true])
  })

  it('validates the decline and passes its reason on', async () => {
    const token = freshToken()
    for (const body of [{ reason: 'x'.repeat(501) }, { reason: 12 }, { reason: 'ok', extra: true }]) {
      expect((await declineRoute(post(`/api/signera/${token}/decline`, body), params(token))).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(ceremony.declineSignature).not.toHaveBeenCalled()
    const { status, body } = await parseJsonResponse<{ data: { declined: boolean } }>(await declineRoute(post(`/api/signera/${token}/decline`, { reason: 'Fel belopp' }), params(token)))
    expect([status, body.data.declined]).toEqual([200, true])
    expect(ceremony.declineSignature.mock.calls[0]![1]).toEqual({ reason: 'Fel belopp' })
  })
})
