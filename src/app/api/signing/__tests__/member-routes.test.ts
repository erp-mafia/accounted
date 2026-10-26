/**
 * The member door of the signer's side, /api/signing/me/[signerId]: a
 * logged-in member signs a request addressed to them without the mailed link.
 * A session is required (401 without), the signer id must be a uuid (404),
 * the signer must be this member (403 SIGNING_NOT_SIGNER), and the signer row,
 * not the active company, names the company. The ceremony is the one the
 * token door uses (lib/signing/ceremony.ts, tested there).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const db = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => db.supabase }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.supabase, createClient: () => Promise.resolve(db.supabase) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('active-company'),
  getActiveCompanyId: vi.fn().mockResolvedValue('active-company'),
}))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
const ceremony = vi.hoisted(() => ({ startSignature: vi.fn() }))
vi.mock('@/lib/signing/ceremony', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/signing/ceremony')>()),
  ...ceremony,
}))

import { GET as describeRoute } from '../me/[signerId]/route'
import { POST as startRoute } from '../me/[signerId]/start/route'

const COMPANY = '33333333-3333-4333-8333-333333333333'
const MEMBER = '55555555-5555-4555-8555-555555555555'
const REQ = '77777777-7777-4777-8777-777777777777'
const SIGNER = '88888888-8888-4888-8888-888888888888'
const params = (signerId: string) => ({ params: Promise.resolve({ signerId }) })

type ErrorBody = { error: { code: string } }

let signer: Record<string, unknown> | null

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  db.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: MEMBER, email: 'erik@example.se' } }, error: null })
  signer = {
    id: SIGNER,
    company_id: COMPANY,
    signing_request_id: REQ,
    position: 1,
    name: 'Erik Eriksson',
    email: null,
    role_label: 'Styrelseledamot',
    user_id: MEMBER,
    lock_kind: 'member',
    status: 'pending',
    bankid_session_id: null,
    bankid_session_started_at: null,
    signed_at: null,
    bankid_given_name: null,
    bankid_surname: null,
    last_error_code: null,
  }
  db.setTable('signing_request_signers', (calls) =>
    calls.some((c) => c.method === 'order') ? { data: [{ position: 1, name: 'Erik Eriksson', role_label: 'Styrelseledamot', status: 'pending' }] } : { data: signer },
  )
  db.setTable('signing_requests', {
    data: {
      id: REQ,
      company_id: COMPANY,
      created_by: 'sender',
      document_id: 'doc',
      document_sha256: 'ab'.repeat(32),
      title: 'Årsredovisning 2025',
      message: null,
      status: 'open',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  })
  db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null, archived_at: null } })
  db.setTable('profiles', { data: { full_name: 'Karin Byråsson' } })
  db.setTable('document_attachments', { data: { file_name: 'arsredovisning.pdf' } })
  ceremony.startSignature.mockResolvedValue({ ok: true, data: { auto_start_token: 'auto', qr_start_token: 'qr', qr_start_secret: 'secret', expires_at: 'x' } })
})

describe('the member door of the signer\'s side', () => {
  it('answers 401 without a session, before reading a signer', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await describeRoute(createMockRequest(`/api/signing/me/${SIGNER}`), params(SIGNER))).status).toBe(401)
    expect(db.tables()).not.toContain('signing_request_signers')
  })

  it('answers 404 for a malformed signer id and for an unknown signer', async () => {
    const malformed = await parseJsonResponse<ErrorBody>(await describeRoute(createMockRequest('/api/signing/me/x'), params('x')))
    expect([malformed.status, malformed.body.error.code]).toEqual([404, 'NOT_FOUND'])
    expect(db.tables()).not.toContain('signing_request_signers')
    signer = null
    expect((await describeRoute(createMockRequest(`/api/signing/me/${SIGNER}`), params(SIGNER))).status).toBe(404)
  })

  it('answers 403 SIGNING_NOT_SIGNER for a signer addressed to someone else', async () => {
    signer = { ...signer!, user_id: 'someone-else' }
    const { status, body } = await parseJsonResponse<ErrorBody>(await startRoute(createMockRequest(`/api/signing/me/${SIGNER}/start`, { method: 'POST' }), params(SIGNER)))
    expect([status, body.error.code]).toEqual([403, 'SIGNING_NOT_SIGNER'])
    expect(ceremony.startSignature).not.toHaveBeenCalled()
  })

  it('shows the member their own signing, whatever company is active', async () => {
    const { status, body } = await parseJsonResponse<{ data: { request: { title: string; company_name: string }; signer: { locked: boolean } } }>(
      await describeRoute(createMockRequest(`/api/signing/me/${SIGNER}`), params(SIGNER)),
    )
    expect(status).toBe(200)
    expect(body.data.request).toMatchObject({ title: 'Årsredovisning 2025', company_name: 'Bolaget AB' })
    expect(body.data.signer.locked).toBe(true)
    expect(db.findCall('signing_request_signers', 'eq')).toEqual(['id', SIGNER])
    expect(db.findCalls('companies', 'eq')).toEqual(expect.arrayContaining([['id', COMPANY]]))
  })

  it('starts the member\'s own signing', async () => {
    const res = await startRoute(createMockRequest(`/api/signing/me/${SIGNER}/start`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' } }), params(SIGNER))
    expect(res.status).toBe(200)
    expect(ceremony.startSignature.mock.calls[0]![0]).toMatchObject({ signer: { id: SIGNER, user_id: MEMBER }, request: { id: REQ } })
    expect(ceremony.startSignature.mock.calls[0]![1]).toMatchObject({ endUserIp: '198.51.100.7' })
  })
})
