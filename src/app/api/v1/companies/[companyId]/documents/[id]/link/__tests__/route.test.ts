/**
 * POST /api/v1/companies/:companyId/documents/:id/link runs the shared link
 * rules (lib/documents/link-document.ts), the ones the dashboard and the MCP
 * tools run. The route used to keep its own: it refused only a POSTED holder
 * (a draft or reversed holder passed the dry run and then failed live at the
 * trigger with another code), never checked the period lock up front, and
 * stamped whatever inbox item inbox_item_id named, even one that does not
 * carry the document.
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
// The real rules run; a test can answer one call itself (the copy, which
// would read and archive file bytes).
vi.mock('@/lib/documents/link-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/link-document')>()
  return { ...actual, linkDocumentToVoucher: vi.fn(actual.linkDocumentToVoucher) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { linkDocumentToVoucher } from '@/lib/documents/link-document'
import { POST as link } from '../route'
import { toHandle } from '@/lib/handles'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type TableAnswers = Parameters<typeof createTableMockSupabase>[0]

/** The shared table mock, with its recorded calls on the client the route gets. */
function makeClient(byTable: TableAnswers) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const HOLDER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LINE_ID = '11111111-1111-4111-8111-111111111111'
const INBOX_ID = '33333333-3333-4333-8333-333333333333'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/documents`

const DOC = { id: DOC_ID, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: null, journal_entry_line_id: null }
const ENTRY = { id: JE_ID, entry_date: '2026-09-15', description: 'Kontorsmaterial', voucher_series: 'A', voucher_number: 12, status: 'posted', fiscal_period_id: 'fp-1' }
const OPEN = { id: 'fp-1', period_start: '2026-01-01', is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null }

function post(body: unknown, { query = '', id = DOC_ID } = {}) {
  return link(
    new Request(`${BASE}/${id}/link${query}`, {
      method: 'POST',
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

const documentWrites = (client: ReturnType<typeof makeClient>) =>
  client.calls.filter((c) => ['document_attachments', 'invoice_inbox_items'].includes(c.table) && c.method === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:read', 'documents:write'],
    mode: 'live',
  })
})

describe('POST /documents/:id/link', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ journal_entry_id: JE_ID })).status).toBe(401)
  })

  it('400 for a malformed body or a non-UUID document id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post({ journal_entry_id: 'not-a-uuid' })).status).toBe(400)
    expect((await post({ journal_entry_id: JE_ID }, { id: 'doc-1' })).status).toBe(400)
  })

  it('404 for a document or a verifikat outside the company, and for a line that is not on the verifikat', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, document_attachments: { data: null }, journal_entries: { data: ENTRY } }))
    const missingDoc = await post({ journal_entry_id: JE_ID })
    expect(missingDoc.status).toBe(404)
    expect((await missingDoc.json()).error.details).toMatchObject({ resource: 'document' })

    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, document_attachments: { data: DOC }, journal_entries: { data: null } }))
    const missingEntry = await post({ journal_entry_id: JE_ID })
    expect(missingEntry.status).toBe(404)
    expect((await missingEntry.json()).error.details).toMatchObject({ resource: 'journal_entry' })

    const client = makeClient({
      company_members: MEMBER,
      document_attachments: { data: DOC },
      journal_entries: { data: ENTRY },
      journal_entry_lines: { data: null },
    })
    mockServiceClient.mockReturnValue(client)
    const wrongLine = await post({ journal_entry_id: JE_ID, journal_entry_line_id: LINE_ID })
    expect(wrongLine.status).toBe(404)
    expect((await wrongLine.json()).error.details).toMatchObject({ resource: 'journal_entry_line' })
    expect(documentWrites(client)).toEqual([])
  })

  it.each(['draft', 'reversed', 'posted'])(
    'a dry run refuses a document held by a %s verifikat with 409 DOC_LINK_ALREADY_LINKED, as the commit does',
    async (status) => {
      const client = makeClient({
        company_members: MEMBER,
        document_attachments: { data: { ...DOC, journal_entry_id: HOLDER_ID } },
        journal_entries: [{ data: ENTRY }, { data: { status, voucher_series: 'A', voucher_number: 7 } }],
      })
      mockServiceClient.mockReturnValue(client)

      const res = await post({ journal_entry_id: JE_ID }, { query: '?dry_run=true' })

      expect(res.status).toBe(409)
      const { error } = await res.json()
      expect(error.code).toBe('DOC_LINK_ALREADY_LINKED')
      expect(error.details).toMatchObject({ current_journal_entry_id: HOLDER_ID, current_journal_entry_status: status })
      expect(documentWrites(client)).toEqual([])
    },
  )

  // v1 keeps the PERIOD_LOCKED it documents for this endpoint; the sentences
  // and the next step are the one answer every document door gives.
  const LOCKED_ANSWER = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!

  it('a dry run refuses a verifikat in a locked period with PERIOD_LOCKED and the way forward', async () => {
    const client = makeClient({
      company_members: MEMBER,
      document_attachments: { data: DOC },
      journal_entries: { data: ENTRY },
      fiscal_periods: { data: { ...OPEN, locked_at: '2026-10-01T00:00:00Z' } },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await post({ journal_entry_id: JE_ID }, { query: '?dry_run=true' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'PERIOD_LOCKED',
      details: { fiscal_period_id: 'fp-1', status: 'locked' },
      message: LOCKED_ANSWER.message_sv,
      message_en: LOCKED_ANSWER.message_en,
      recovery_hint: LOCKED_ANSWER.remediation!.description,
    })
    expect(documentWrites(client)).toEqual([])
  })

  it('answers a year locked between the check and the write as the check does, not with a 500', async () => {
    const client = makeClient({
      company_members: MEMBER,
      document_attachments: [
        { data: DOC },
        { data: null, error: { code: 'P0001', message: 'Cannot attach documents to entries in a locked/closed fiscal period' } },
      ],
      journal_entries: { data: ENTRY },
      fiscal_periods: { data: OPEN },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await post({ journal_entry_id: JE_ID })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: LOCKED_ANSWER.message_sv,
      recovery_hint: LOCKED_ANSWER.remediation!.description,
    })
  })

  it('a dry run previews the link and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      document_attachments: { data: DOC },
      journal_entries: { data: ENTRY },
      fiscal_periods: { data: OPEN },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await post({ journal_entry_id: JE_ID }, { query: '?dry_run=true' })

    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ id: DOC_ID, journal_entry_id: JE_ID, file_name: 'kvitto.pdf' })
    expect(documentWrites(client)).toEqual([])
  })

  it('links the document and stamps the inbox item that carries it, never the one inbox_item_id names', async () => {
    const client = makeClient({
      company_members: MEMBER,
      document_attachments: [{ data: DOC }, { data: { ...DOC, journal_entry_id: JE_ID } }],
      journal_entries: { data: ENTRY },
      fiscal_periods: { data: OPEN },
      invoice_inbox_items: { data: [{ id: 'item-carrying-the-document' }] },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await post({ journal_entry_id: JE_ID, inbox_item_id: INBOX_ID })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      id: DOC_ID, handle: toHandle('document', DOC_ID), journal_entry_id: JE_ID, journal_entry_line_id: null, file_name: 'kvitto.pdf', copy_of_document_id: null,
    })
    expect(client.calls).toContainEqual(
      expect.objectContaining({
        table: 'document_attachments',
        method: 'update',
        // An API key named the pair and the write committed directly.
        args: [{ journal_entry_id: JE_ID, journal_entry_line_id: null, link_basis: 'client_asserted', link_evidence: null }],
      }),
    )
    const inboxEq = client.calls.filter((c) => c.table === 'invoice_inbox_items' && c.method === 'eq').map((c) => c.args)
    expect(inboxEq).toContainEqual(['document_id', DOC_ID])
    expect(inboxEq).not.toContainEqual(['id', INBOX_ID])
  })

  describe('copy: true, one underlag on several verifikat (crm#1171 item 9)', () => {
    const COPY_ID = '44444444-4444-4444-8444-444444444444'

    it('the 409 for a document held elsewhere names copy: true as the way to share it', async () => {
      mockServiceClient.mockReturnValue(makeClient({
        company_members: MEMBER,
        document_attachments: { data: { ...DOC, journal_entry_id: HOLDER_ID } },
        journal_entries: [{ data: ENTRY }, { data: { status: 'posted', voucher_series: 'A', voucher_number: 22 } }],
      }))

      const { error } = await (await post({ journal_entry_id: JE_ID })).json()

      expect(error.code).toBe('DOC_LINK_ALREADY_LINKED')
      expect(error.details.message).toContain('send copy: true')
    })

    it('a dry run with copy previews a copy of a document another verifikat holds and writes nothing', async () => {
      const client = makeClient({
        company_members: MEMBER,
        document_attachments: { data: { ...DOC, journal_entry_id: HOLDER_ID } },
        // The plain check reads the verifikat and the holder; the copy check the verifikat again.
        journal_entries: [{ data: ENTRY }, { data: { status: 'posted', voucher_series: 'A', voucher_number: 22 } }, { data: ENTRY }],
        fiscal_periods: { data: OPEN },
      })
      mockServiceClient.mockReturnValue(client)

      const res = await post({ journal_entry_id: JE_ID, copy: true }, { query: '?dry_run=true' })

      expect(res.status).toBe(200)
      expect((await res.json()).data.preview).toMatchObject({ id: DOC_ID, journal_entry_id: JE_ID, copy_of_document_id: DOC_ID })
      expect(documentWrites(client)).toEqual([])
      expect(client.calls.some((c) => c.table === 'document_attachments' && c.method === 'insert')).toBe(false)
    })

    it('passes copy and the acting user to the shared rules and answers with the copy and its source', async () => {
      mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
      vi.mocked(linkDocumentToVoucher).mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        target: { document: { ...DOC, journal_entry_id: HOLDER_ID }, entry: ENTRY },
        document: { id: COPY_ID, file_name: 'kvitto.pdf', journal_entry_id: JE_ID, journal_entry_line_id: null } as never,
        copy_of_document_id: DOC_ID,
      })

      const res = await post({ journal_entry_id: JE_ID, copy: true })

      expect(res.status).toBe(200)
      expect((await res.json()).data).toEqual({
        id: COPY_ID, handle: toHandle('document', COPY_ID), journal_entry_id: JE_ID, journal_entry_line_id: null, file_name: 'kvitto.pdf', copy_of_document_id: DOC_ID,
      })
      expect(vi.mocked(linkDocumentToVoucher)).toHaveBeenCalledWith(
        expect.anything(),
        COMPANY_ID,
        expect.objectContaining({ document_id: DOC_ID, journal_entry_id: JE_ID, copy: true }),
        expect.objectContaining({ userId: 'user-1' }),
      )
    })

    it('400 for a copy that is not a boolean', async () => {
      mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
      expect((await post({ journal_entry_id: JE_ID, copy: 'yes' })).status).toBe(400)
    })
  })
})
