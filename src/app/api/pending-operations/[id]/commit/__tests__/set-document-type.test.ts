/**
 * Approving a staged gnubok_set_document_type in the app. The type is written
 * to document_classifications, which only the service role writes: its RLS
 * has a SELECT policy and nothing else (migration 20260914190000). Dokument's
 * "Ändra typ" route and the MCP door write it with a service-role client. The
 * app's approval handed the operation the approver's own session instead, so
 * the retiring UPDATE matched no row and the INSERT was refused: every
 * in-app approval of the tool failed with a 500 and closed the proposal.
 *
 * The approval now writes through the service role, and only after it has
 * checked that the approver keeps the books of the company (a viewer is
 * refused even when a door let the approval through). The document is still
 * looked up in the approver's company only.
 *
 * The route, the dispatcher, the operation and the classification service run
 * for real; the two clients stand in for the database, the session one
 * refusing what RLS refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createRowsMockSupabase,
  createTableMockSupabase,
  parseJsonResponse,
  type TableMockResolver,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

// The approver's session: RLS applies.
const session = createTableMockSupabase()
// The service role: no RLS, so the company filter is the only fence.
const writes: { table: string; method: string; row: unknown }[] = []
let service = createRowsMockSupabase({})

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(session.supabase),
  createServiceClient: () => service.supabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
// The route's own write gate passes in every test here: the operation must
// hold its own check, whichever door ran it.
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/pending-operations/record-app-approval', () => ({
  recordAppApproval: vi.fn(async () => undefined),
}))

import { POST } from '../route'

type Envelope = {
  data?: Record<string, unknown>
  error?: { code: string; message: string; details?: Record<string, unknown> } | string
}

const routeParams = createMockRouteParams({ id: 'op-1' })

const STAGED = {
  id: 'op-1',
  user_id: 'user-1',
  company_id: 'company-1',
  operation_type: 'set_document_type',
  status: 'pending',
  risk_level: 'low',
  title: 'Ändra dokumenttyp: faktura-1042.pdf (Kundfaktura)',
  params: { document_id: DOC, doc_type: 'customer_invoice' },
  preview_data: {},
}

/** The operation for the route's read, the claim for the dispatcher's CAS, nothing for every later status write. */
const pendingOperations: TableMockResolver = (chain) => {
  const first = chain[0]
  if (first?.method === 'select') return { data: STAGED }
  const claim = first?.method === 'update' && (first.args[0] as { status?: string }).status === 'committing'
  return claim ? { data: { id: 'op-1', updated_at: '2026-11-22T18:13:56Z' } } : { data: null }
}

/** What RLS answers the session: no INSERT or UPDATE policy on document_classifications. */
const rlsRefusesClassificationWrites: TableMockResolver = (chain) => {
  if (chain.some(({ method }) => method === 'insert')) {
    return { error: { code: '42501', message: 'new row violates row-level security policy for table "document_classifications"' } }
  }
  // The retiring UPDATE silently matches no row.
  if (chain.some(({ method }) => method === 'update')) return { data: null }
  return { data: null }
}

function sessionAs(role: string) {
  session.reset()
  session.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  session.setTable('pending_operations', pendingOperations)
  session.setTable('company_members', (chain) => {
    const asked = Object.fromEntries(chain.filter(({ method }) => method === 'eq').map(({ args }) => args))
    return asked.company_id === 'company-1' && asked.user_id === 'user-1' ? { data: { role } } : { data: null }
  })
  session.setTable('document_attachments', { data: { id: DOC, company_id: 'company-1', doc_type: 'supplier_invoice', user_id: 'user-1', file_name: 'faktura-1042.pdf', page_count: 1, admission_state: 'admitted' } })
  session.setTable('document_classifications', rlsRefusesClassificationWrites)
}

function serviceHolding(documentCompanyId: string) {
  writes.length = 0
  service = createRowsMockSupabase(
    {
      document_attachments: [
        { id: DOC, company_id: documentCompanyId, doc_type: 'supplier_invoice', user_id: 'user-1', file_name: 'faktura-1042.pdf', page_count: 1, admission_state: 'admitted' },
      ],
      document_classifications: [
        { id: 'cls-1', company_id: documentCompanyId, document_id: DOC, doc_type: 'supplier_invoice', is_current: true, decided_by: 'model', summary: 'Faktura', language: 'sv', addressed_to: null, is_multi_document: false, signals: [], content_sha256: null },
      ],
      agreements: [],
      document_jobs: [],
    },
    writes,
  )
}

async function approve(): Promise<{ status: number; body: Envelope }> {
  const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
  return parseJsonResponse<Envelope>(await POST(request, routeParams))
}

const classificationWrites = () => writes.filter((w) => w.table === 'document_classifications')

describe('POST /api/pending-operations/:id/commit: set_document_type', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('sets the type through the service role for a member who keeps the books, and answers 200', async () => {
    sessionAs('member')
    serviceHolding('company-1')

    const { status, body } = await approve()

    expect(status).toBe(200)
    expect(body.data).toEqual({ document_id: DOC, doc_type: 'customer_invoice', previous_doc_type: 'supplier_invoice' })
    // The old classification retired and the person's one written, by the service role.
    expect(classificationWrites().map((w) => w.method)).toEqual(['update', 'insert'])
    expect(classificationWrites()[1].row).toMatchObject({
      company_id: 'company-1',
      document_id: DOC,
      doc_type: 'customer_invoice',
      decided_by: 'human',
      decided_by_user_id: 'user-1',
      is_current: true,
    })
    // Nothing went through the session the table refuses.
    expect(session.findCalls('document_classifications', 'insert')).toHaveLength(0)
    expect(session.payloads('pending_operations', 'update').at(-1)).toMatchObject({ status: 'committed' })
  })

  it('refuses a viewer with 403 and writes nothing, even when the door let the approval through', async () => {
    sessionAs('viewer')
    serviceHolding('company-1')

    const { status, body } = await approve()

    expect(status).toBe(403)
    expect((body.error as { code: string }).code).toBe('FORBIDDEN')
    // The service role is never reached: no table, no function.
    expect(service.supabase.from).not.toHaveBeenCalled()
    expect(service.supabase.rpc).not.toHaveBeenCalled()
    // An authorization refusal keeps the proposal for someone who may approve it.
    expect(session.payloads('pending_operations', 'update').at(-1)).toEqual({ status: 'pending' })
  })

  it('refuses an approver with no membership in the company, writing nothing', async () => {
    sessionAs('member')
    session.setTable('company_members', { data: null })
    serviceHolding('company-1')

    const { status } = await approve()

    expect(status).toBe(403)
    expect(service.supabase.from).not.toHaveBeenCalled()
    expect(service.supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers 404 for a document of another company, writing nothing through the service role', async () => {
    sessionAs('member')
    serviceHolding('company-2')

    const { status, body } = await approve()

    expect(status).toBe(404)
    expect((body.error as { code: string }).code).toBe('DOC_NOT_FOUND')
    // The service role read the document in the approver's company and stopped there.
    expect(service.tables()).toEqual(['document_attachments'])
    expect(service.findCalls('document_attachments', 'eq')).toEqual(
      expect.arrayContaining([['id', DOC], ['company_id', 'company-1']]),
    )
    expect(service.supabase.rpc).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})
