/**
 * PUT /api/v1/companies/:companyId/documents/:id/type: Dokument's "Ändra typ"
 * through the v1 door of documents.set-type (src/lib/operations/documents.ts
 * via lib/operations/v1.ts), the same operation the staged
 * gnubok_set_document_type runs on approval.
 *
 * The rules under test are the door's and the operation's: a key needs
 * documents:write, the type is one of the taxonomy's, a document of another
 * company is not found, a dry run reads and writes nothing, the write goes
 * through the classification service as the key's person, and ?stage=true
 * proposes the type as a pending operation instead of setting it. The
 * classification service itself is tested in
 * lib/documents/classify/__tests__/set-type.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
// The operation writes the type through the service role (document_classifications has no write policy).
const serviceRole = vi.hoisted(() => ({ client: { role: 'service' } }))
vi.mock('@/lib/supabase/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase/server')>('@/lib/supabase/server')
  return { ...actual, createServiceClient: vi.fn(() => serviceRole.client) }
})
vi.mock('@/lib/documents/classify/set-type', () => ({ setDocumentTypeByPerson: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { setDocumentTypeByPerson } from '@/lib/documents/classify/set-type'
import { createTableMockSupabase } from '@/tests/helpers'
import { PUT as setType } from '../[id]/type/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockSetType = setDocumentTypeByPerson as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/documents/${DOC_ID}/type`

/** One request's database: the key's user is a member, the document is as given. */
function db(document: Record<string, unknown> | null = { id: DOC_ID, file_name: 'protokoll.pdf', doc_type: null }) {
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'member' } },
    document_attachments: { data: document },
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      return {
        data: insert
          ? { id: '33333333-3333-4333-8333-333333333333', status: 'pending', created_at: '2026-11-27T10:00:00.000Z', ...(insert.args[0] as object) }
          : null,
      }
    },
  })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function put(body: unknown = { doc_type: 'minutes.board' }, query = '', id = DOC_ID) {
  return setType(
    new Request(`${BASE.replace(DOC_ID, id)}${query}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID, id }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Portal',
    scopes: ['documents:read', 'documents:write'],
    mode: 'live',
  })
  mockSetType.mockResolvedValue({ status: 'set', documentId: DOC_ID, docType: 'minutes.board', previousDocType: null, withdrawnAgreementId: null })
})

describe('PUT /api/v1/companies/:companyId/documents/:id/type', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    db()
    expect((await put()).status).toBe(401)
    expect(mockSetType).not.toHaveBeenCalled()
  })

  it('403 without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    db()
    expect((await put()).status).toBe(403)
    expect(mockSetType).not.toHaveBeenCalled()
  })

  it('400 on a type outside the taxonomy and on a path id that is not a uuid', async () => {
    db()
    const unknown = await put({ doc_type: 'invoice' })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await put({ doc_type: 'minutes.board' }, '', 'nope')).status).toBe(400)
    expect(mockSetType).not.toHaveBeenCalled()
  })

  it('404 DOC_NOT_FOUND for a document the company does not hold', async () => {
    db()
    mockSetType.mockResolvedValue({ status: 'not_found' })
    const res = await put()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DOC_NOT_FOUND')

    // The dry run reads the company's own archive only.
    const mock = db(null)
    const dry = await put({ doc_type: 'minutes.board' }, '?dry_run=true')
    expect(dry.status).toBe(404)
    expect(mock.calls).toContainEqual({ table: 'document_attachments', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('the dry run previews the change in Dokument\'s words and writes nothing', async () => {
    const mock = db()
    const res = await put({ doc_type: 'minutes.board' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      document_id: DOC_ID,
      file_name: 'protokoll.pdf',
      doc_type_before: null,
      doc_type: 'minutes.board',
      new_type: 'Styrelseprotokoll',
    })
    expect(mockSetType).not.toHaveBeenCalled()
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('previews the type a booked document shows when its period lock kept the type on the classification', async () => {
    const mock = db({ id: DOC_ID, file_name: 'kvitto.pdf', doc_type: null, journal_entry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', journal_entry_line_id: null })
    mock.setTable('document_classifications', { data: [{ document_id: DOC_ID, doc_type: 'receipt' }] })
    const res = await put({ doc_type: 'supplier_invoice' }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ doc_type_before: 'receipt', current_type: 'Kvitto', doc_type: 'supplier_invoice' })
  })

  it('sets the type as the key\'s person, through the service role, in the key\'s company', async () => {
    db({ id: DOC_ID, file_name: 'protokoll.pdf', doc_type: 'other' })
    mockSetType.mockResolvedValue({ status: 'set', documentId: DOC_ID, docType: 'minutes.board', previousDocType: 'other', withdrawnAgreementId: null })
    const res = await put()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ document_id: DOC_ID, doc_type: 'minutes.board', previous_doc_type: 'other' })
    expect(mockSetType).toHaveBeenCalledWith(serviceRole.client, {
      companyId: COMPANY_ID,
      documentId: DOC_ID,
      userId: 'user-1',
      docType: 'minutes.board',
    })
  })

  it('a viewer\'s key sets nothing, whatever the door let through', async () => {
    const mock = db()
    mock.setTable('company_members', { data: { company_id: COMPANY_ID, role: 'viewer' } })
    const res = await put()
    expect(res.status).toBe(403)
    expect(mockSetType).not.toHaveBeenCalled()
  })

  it('?stage=true proposes the type for a person to approve: 202 with the pending operation, nothing set', async () => {
    const mock = db()
    const res = await put({ doc_type: 'minutes.board' }, '?stage=true')
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data).toMatchObject({ pending_operation_id: '33333333-3333-4333-8333-333333333333', status: 'pending' })
    const [staged] = mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(staged).toMatchObject({
      company_id: COMPANY_ID,
      operation_type: 'set_document_type',
      params: { document_id: DOC_ID, doc_type: 'minutes.board' },
    })
    expect(String(staged.title)).toContain('protokoll.pdf')
    expect(mockSetType).not.toHaveBeenCalled()
  })
})
