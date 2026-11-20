import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

/**
 * The batched attest link's door (/api/attest/lista/:token, crm#1569): the
 * link is the authentication. Every way a token fails reads the same 404;
 * the answers run the attest service invoice by invoice as the attester the
 * link names, from 'email_link', into one decision collector that is
 * flushed once, so the registrant gets one mail for the whole answer.
 */

const service = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => service.supabase,
}))

const approveSupplierInvoice = vi.fn()
const rejectSupplierInvoice = vi.fn()
const loadAttestMembers = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supplier-invoices/attest-service')>()),
  approveSupplierInvoice: (...args: unknown[]) => approveSupplierInvoice(...args),
  rejectSupplierInvoice: (...args: unknown[]) => rejectSupplierInvoice(...args),
  loadAttestMembers: (...args: unknown[]) => loadAttestMembers(...args),
  loadAttestPeople: async (_s: unknown, ids: string[]) => new Map(ids.map((id) => [id, { user_id: id, name: id === 'alex' ? 'Alex' : 'Kim', email: null }])),
}))
const collector = { add: vi.fn(), flush: vi.fn(), size: 0 }
vi.mock('@/lib/supplier-invoices/attest-decision-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supplier-invoices/attest-decision-notify')>()),
  createAttestDecisionBatch: () => collector,
}))

import { GET as readBatch } from '../lista/[token]/route'
import { POST as decide, maxDuration } from '../lista/[token]/decisions/route'
import { GET as readDocument } from '../lista/[token]/document/[invoiceId]/route'

// 32 bytes base64url = 43 characters: the format the door accepts.
const TOKEN = 'B'.repeat(43)
const ATTESTER = 'kim'
const MF1 = '11111111-1111-4111-8111-111111111111'
const MF2 = '22222222-2222-4222-8222-222222222222'
const KB = '33333333-3333-4333-8333-333333333333'
const ELSEWHERE = '99999999-9999-4999-8999-999999999999'

const batch = (overrides: Record<string, unknown> = {}) => ({
  id: 'batch-1',
  company_id: 'c1',
  attester_user_id: ATTESTER,
  kind: 'request',
  invoice_ids: [MF1, MF2, KB],
  expires_at: '2999-01-01T00:00:00Z',
  mail_sent_at: '2026-10-31T12:00:00Z',
  consumed_at: null,
  round_started_at: '2026-10-31T12:00:00Z',
  created_at: '2026-10-31T12:00:00Z',
  ...overrides,
})

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user_id: 'alex',
  status: 'registered',
  approved_at: null,
  is_credit_note: false,
  currency: 'SEK',
  total: 29625,
  total_sek: null,
  exchange_rate: null,
  supplier_invoice_number: `F-${id.slice(0, 4)}`,
  arrival_number: 7,
  invoice_date: '2026-08-16',
  due_date: '2999-12-31',
  remaining_amount: 29625,
  document_id: 'doc-1',
  supplier: { name: 'Möbelfirman AB' },
  ...overrides,
})

type Call = { method: string; args: unknown[] }

/**
 * supplier_invoice_attestations as the door reads it: the trail (paged, read
 * once before and once after the answer; the last answer repeats) and the
 * check right before each decision for a rejection since the mail.
 */
function attestationsTable(options: { trails?: unknown[][]; rejectedSince?: string[] } = {}) {
  const trails = options.trails ?? [[]]
  let read = 0
  return (calls: Call[]) => {
    if (calls.some((c) => c.method === 'eq' && c.args[0] === 'decision' && c.args[1] === 'rejected')) {
      const invoiceId = calls.find((c) => c.method === 'eq' && c.args[0] === 'supplier_invoice_id')?.args[1] as string
      return { data: (options.rejectedSince ?? []).includes(invoiceId) ? [{ id: 'rej-1' }] : [] }
    }
    const trail = trails[Math.min(read, trails.length - 1)]
    read++
    return { data: trail }
  }
}

const params = (token = TOKEN) => createMockRouteParams({ token })
// The door's one live-membership read (attesterCanStillDecide): a writing member of a live company.
const writingMember = { data: { company_id: 'c1', role: 'member', companies: { archived_at: null, name: 'Kundbolaget AB' } } }

function seed(tables: Record<string, unknown> = {}) {
  service.reset()
  const all: Record<string, unknown> = {
    supplier_invoice_attest_batches: { data: batch() },
    company_attest_policies: { data: { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: [ATTESTER], preparer_may_attest: false, updated_by: null, updated_at: null } },
    company_attest_limits: { data: [] },
    company_settings: { data: { accounting_method: 'accrual' } },
    companies: { data: { name: 'Kundbolaget AB' } },
    company_members: writingMember,
    supplier_invoices: { data: [invoice(MF1, { due_date: '2026-09-15', status: 'overdue' }), invoice(MF2), invoice(KB, { supplier: { name: 'Konsultbolaget AB' }, total: 11250 })] },
    supplier_invoice_attestations: attestationsTable(),
    ...tables,
  }
  for (const [key, value] of Object.entries(all)) service.setTable(key, value as never)
}

const answer = (decisions: unknown[]) => decide(createMockRequest('/api/attest/lista/t/decisions', { method: 'POST', body: { decisions } }), params())
const approvedOk = { ok: true, data: { approved: true, invoice: { approved_at: '2026-10-31T13:00:00Z' }, attest: { remaining: [] }, attestation_id: 'a-1' } }

describe('the batched attest link door', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadAttestMembers.mockResolvedValue({ attesters: new Set([ATTESTER, 'alex']), writers: new Set([ATTESTER, 'alex']) })
    collector.flush.mockResolvedValue(undefined)
  })

  it('answers 404 for a malformed, unknown, used or expired token, and for an attester who left', async () => {
    seed()
    expect((await readBatch(createMockRequest('/api/attest/lista/x'), params('not-a-token'))).status).toBe(404)

    seed({ supplier_invoice_attest_batches: { data: null } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(404)

    seed({ supplier_invoice_attest_batches: { data: batch({ consumed_at: '2026-10-31T13:00:00Z' }) } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(404)

    seed({ supplier_invoice_attest_batches: { data: batch({ expires_at: '2000-01-01T00:00:00Z' }) } })
    expect((await answer([{ invoice_id: MF1, decision: 'approve' }])).status).toBe(404)

    // A database the migration has not reached reads as unknown.
    seed({ supplier_invoice_attest_batches: { error: { code: 'PGRST205', message: 'Could not find the table' } } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(404)

    seed({ company_members: { data: null } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(404)
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('opens for a viewer the policy names, whose answer the attest service rules on (crm#1569), and answers 404 to an invoicer', async () => {
    approveSupplierInvoice.mockResolvedValue(approvedOk)
    seed({ company_members: { data: { ...writingMember.data, role: 'viewer' } } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(200)
    expect((await answer([{ invoice_id: MF1, decision: 'approve' }])).status).toBe(200)
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(1)

    approveSupplierInvoice.mockClear()
    seed({ company_members: { data: { ...writingMember.data, role: 'invoicer' } } })
    expect((await readBatch(createMockRequest('/api/attest/lista/t'), params())).status).toBe(404)
    expect((await answer([{ invoice_id: MF1, decision: 'approve' }])).status).toBe(404)
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it("asks through the single link's live-membership read, so an archived company takes no decision", async () => {
    seed({ company_members: { data: null } }) // the archived filter leaves no row
    expect((await answer([{ invoice_id: MF1, decision: 'approve' }])).status).toBe(404)
    expect(service.findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])
    expect(service.findCalls('company_members', 'eq')).toEqual(
      expect.arrayContaining([
        ['user_id', ATTESTER],
        ['company_id', 'c1'],
      ]),
    )
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('looks the token up by its sha256 hash, never in clear', async () => {
    seed({ supplier_invoice_attest_batches: { data: null } })
    await readBatch(createMockRequest('/api/attest/lista/t'), params())
    const eqCalls = service.findCalls('supplier_invoice_attest_batches', 'eq')
    expect(eqCalls).toContainEqual(['token_hash', expect.stringMatching(/^[0-9a-f]{64}$/)])
    expect(JSON.stringify(eqCalls)).not.toContain(TOKEN)
  })

  it('shows every listed invoice in the mail order, with what the attester may do and which are overdue', async () => {
    seed()
    const { status, body } = await parseJsonResponse<{ data: { company_name: string; invoices: Array<Record<string, unknown>> } }>(
      await readBatch(createMockRequest('/api/attest/lista/t'), params()),
    )
    expect(status).toBe(200)
    expect(body.data.company_name).toBe('Kundbolaget AB')
    expect(body.data.invoices.map((i) => i.id)).toEqual([MF1, MF2, KB])
    expect(body.data.invoices[0]).toMatchObject({ state: 'open', may_approve: true, may_reject: true, overdue: true, registered_by: 'Alex', has_document: true })
    expect(body.data.invoices[2]).toMatchObject({ supplier_name: 'Konsultbolaget AB', overdue: false })
    // The trail is read paged and oldest first: past 1000 rows the latest rejection still counts.
    expect(service.findCalls('supplier_invoice_attestations', 'order')).toContainEqual(['decided_at', { ascending: true }])
    expect(service.findCalls('supplier_invoice_attestations', 'range')).toContainEqual([0, 999])
  })

  it('closes an invoice for the link once someone rejected it after the mail went out', async () => {
    seed({
      supplier_invoice_attestations: attestationsTable({ trails: [[{ id: 'r-1', supplier_invoice_id: MF2, user_id: 'robin', decision: 'rejected', decided_at: '2026-10-31T13:00:00Z' }]] }),
    })
    const { body } = await parseJsonResponse<{ data: { invoices: Array<Record<string, unknown>> } }>(await readBatch(createMockRequest('/api/attest/lista/t'), params()))
    expect(body.data.invoices[1]).toMatchObject({ id: MF2, state: 'closed', may_approve: false, may_reject: false })

    const { body: answered } = await parseJsonResponse<{ data: { results: unknown[] } }>(await answer([{ invoice_id: MF2, decision: 'approve' }]))
    expect(answered.data.results).toEqual([{ invoice_id: MF2, ok: false, code: 'ATTEST_NOT_PENDING' }])
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('counts "rejected since the mail" from when the mail went out, not from when its link was first stored', async () => {
    // A link stored at 12:00 and tried again at 14:00 (its row keeps created_at); a rejection at 13:00 came before this mail.
    seed({
      supplier_invoice_attest_batches: { data: batch({ created_at: '2026-10-31T12:00:00Z', mail_sent_at: '2026-10-31T14:00:00Z' }) },
      supplier_invoice_attestations: attestationsTable({ trails: [[{ id: 'r-1', supplier_invoice_id: MF2, user_id: 'robin', decision: 'rejected', decided_at: '2026-10-31T13:00:00Z' }]] }),
    })
    const { body } = await parseJsonResponse<{ data: { invoices: Array<Record<string, unknown>> } }>(await readBatch(createMockRequest('/api/attest/lista/t'), params()))
    expect(body.data.invoices[1]).not.toMatchObject({ state: 'closed' })
    approveSupplierInvoice.mockResolvedValue(approvedOk)
    await answer([{ invoice_id: MF1, decision: 'approve' }])
    expect(service.findCalls('supplier_invoice_attestations', 'gt')).toContainEqual(['decided_at', '2026-10-31T14:00:00Z'])
  })

  it('checks again right before each decision: a rejection by another attester while the list is approved closes that invoice', async () => {
    seed({ supplier_invoice_attestations: attestationsTable({ rejectedSince: [MF2] }) })
    approveSupplierInvoice.mockResolvedValue(approvedOk)
    const { body } = await parseJsonResponse<{ data: { results: unknown[] } }>(
      await answer([
        { invoice_id: MF1, decision: 'approve' },
        { invoice_id: MF2, decision: 'approve' },
        { invoice_id: KB, decision: 'approve' },
      ]),
    )
    expect(body.data.results).toEqual([
      { invoice_id: MF1, ok: true, decision: 'approved', attested: true },
      { invoice_id: MF2, ok: false, code: 'ATTEST_NOT_PENDING' },
      { invoice_id: KB, ok: true, decision: 'approved', attested: true },
    ])
    expect(approveSupplierInvoice.mock.calls.map(([, input]) => (input as { invoiceId: string }).invoiceId)).toEqual([MF1, KB])
    // The check asks for a rejection after the mail went out.
    expect(service.findCalls('supplier_invoice_attestations', 'gt')).toContainEqual(['decided_at', '2026-10-31T12:00:00Z'])
  })

  it('records each answer through the attest service into one collector, reports a refusal per invoice, and flushes once', async () => {
    seed({
      supplier_invoices: [
        { data: [invoice(MF1), invoice(MF2), invoice(KB)] },
        { data: [invoice(MF1, { approved_at: '2026-10-31T13:00:00Z', status: 'approved' }), invoice(MF2), invoice(KB)] },
      ],
      supplier_invoice_attestations: attestationsTable({
        trails: [[], [{ id: 'r-2', supplier_invoice_id: KB, user_id: ATTESTER, decision: 'rejected', decided_at: '2026-10-31T13:00:00Z' }]],
      }),
    })
    approveSupplierInvoice.mockImplementation(async (_op: unknown, input: { invoiceId: string }) =>
      input.invoiceId === MF1 ? approvedOk : { ok: false, code: 'ATTEST_LIMIT_EXCEEDED', details: { reason: 'limit' } },
    )
    rejectSupplierInvoice.mockResolvedValue({ ok: true, data: { supplier_invoice_id: KB, attestation_id: 'a-2', status: 'registered' } })

    const res = await answer([
      { invoice_id: MF1, decision: 'approve' },
      { invoice_id: MF2, decision: 'approve' },
      { invoice_id: KB, decision: 'reject', comment: '  Fel belopp  ' },
      { invoice_id: ELSEWHERE, decision: 'approve' },
    ])
    const { status, body } = await parseJsonResponse<{ data: { results: unknown[]; page: { invoices: Array<{ id: string; state: string }> } } }>(res)
    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { invoice_id: MF1, ok: true, decision: 'approved', attested: true },
      { invoice_id: MF2, ok: false, code: 'ATTEST_LIMIT_EXCEEDED' },
      { invoice_id: KB, ok: true, decision: 'rejected' },
      { invoice_id: ELSEWHERE, ok: false, code: 'NOT_FOUND' },
    ])
    expect(body.data.page.invoices.map((i) => i.state)).toEqual(['attested', 'open', 'rejected'])

    // As the attester the link names, from the mail, every decision into the same collector.
    expect(approveSupplierInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c1', userId: ATTESTER }),
      expect.objectContaining({ invoiceId: MF1, source: 'email_link', decisions: collector }),
    )
    expect(rejectSupplierInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ATTESTER }),
      expect.objectContaining({ invoiceId: KB, comment: 'Fel belopp', source: 'email_link', decisions: collector }),
    )
    for (const [, input] of [...approveSupplierInvoice.mock.calls, ...rejectSupplierInvoice.mock.calls]) expect(input).not.toHaveProperty('notifyRegistrant')
    // One flush for the whole answer, on the link's service client.
    expect(collector.flush).toHaveBeenCalledTimes(1)
    expect(collector.flush).toHaveBeenCalledWith(service.supabase)
    // Something is still open (the refused one): the link keeps working.
    expect(service.payloads('supplier_invoice_attest_batches', 'update')).toEqual([])
  })

  it('still flushes the collected answers when a decision throws', async () => {
    seed()
    approveSupplierInvoice.mockImplementation(async (_op: unknown, input: { invoiceId: string }) => {
      if (input.invoiceId === MF2) throw new Error('connection reset')
      return approvedOk
    })
    const { body } = await parseJsonResponse<{ data: { results: unknown[] } }>(
      await answer([
        { invoice_id: MF1, decision: 'approve' },
        { invoice_id: MF2, decision: 'approve' },
      ]),
    )
    expect(body.data.results).toEqual([
      { invoice_id: MF1, ok: true, decision: 'approved', attested: true },
      { invoice_id: MF2, ok: false, code: 'INTERNAL_ERROR' },
    ])
    expect(collector.flush).toHaveBeenCalledTimes(1)
  })

  it('consumes the link once nothing listed is left to decide', async () => {
    seed({
      supplier_invoice_attest_batches: { data: batch({ invoice_ids: [MF1] }) },
      supplier_invoices: [{ data: [invoice(MF1)] }, { data: [invoice(MF1, { approved_at: '2026-10-31T13:00:00Z', status: 'approved' })] }],
    })
    approveSupplierInvoice.mockResolvedValue(approvedOk)
    expect((await answer([{ invoice_id: MF1, decision: 'approve' }])).status).toBe(200)
    expect(service.payloads('supplier_invoice_attest_batches', 'update')).toEqual([{ consumed_at: expect.any(String) }])
  })

  it('answers 400 for a body that is not a list of answers', async () => {
    seed()
    for (const body of [{}, { decisions: [] }, { decisions: [{ invoice_id: 'not-a-uuid', decision: 'approve' }] }, { decisions: [{ invoice_id: MF1, decision: 'maybe' }] }]) {
      const res = await decide(createMockRequest('/api/attest/lista/t/decisions', { method: 'POST', body }), params())
      expect(res.status).toBe(400)
    }
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('gives the answer route time for up to 100 approvals, one after the other', () => {
    expect(maxDuration).toBe(300)
  })

  it('serves only the documents of the invoices the link lists', async () => {
    seed()
    const res = await readDocument(createMockRequest('/api/attest/lista/t/document/x'), createMockRouteParams({ token: TOKEN, invoiceId: ELSEWHERE }))
    expect(res.status).toBe(404)
    expect(service.findCalls('document_attachments', 'eq')).toEqual([])
  })
})
