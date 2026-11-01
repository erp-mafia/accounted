import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

/**
 * The attest mail's token door (/api/attest/:token): the link is the
 * authentication. Every way a token fails reads the same 404; a decision runs
 * the attest service as the attester the link names, from 'email_link', and
 * consumes the link.
 */

const service = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => service.supabase,
}))

const approveSupplierInvoice = vi.fn()
const rejectSupplierInvoice = vi.fn()
const getSupplierInvoiceAttestState = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  approveSupplierInvoice: (...args: unknown[]) => approveSupplierInvoice(...args),
  rejectSupplierInvoice: (...args: unknown[]) => rejectSupplierInvoice(...args),
  getSupplierInvoiceAttestState: (...args: unknown[]) => getSupplierInvoiceAttestState(...args),
  loadAttestPeople: async (_s: unknown, ids: string[]) => new Map(ids.map((id) => [id, { user_id: id, name: `Namn ${id}`, email: null }])),
}))

import { GET as readLink } from '../[token]/route'
import { POST as decide } from '../[token]/decision/route'
import { GET as readDocument } from '../[token]/document/route'

// 32 bytes base64url = 43 characters: the format the door accepts.
const TOKEN = 'A'.repeat(43)
const ATTESTER = 'attester-1'
const link = (overrides: Record<string, unknown> = {}) => ({
  id: 'link-1',
  company_id: 'company-1',
  supplier_invoice_id: 'inv-1',
  attester_user_id: ATTESTER,
  expires_at: '2999-01-01T00:00:00Z',
  mail_sent_at: null,
  consumed_at: null,
  created_at: '2026-10-14T09:00:00Z',
  ...overrides,
})
const params = (token = TOKEN) => createMockRouteParams({ token })
const writingMember = { data: { company_id: 'company-1', role: 'member', companies: { archived_at: null, name: 'Testbolaget AB' } } }

describe('the attest link token door', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service.reset()
    service.setTable('company_members', writingMember)
  })

  it('answers 404 for a malformed, unknown, used or expired token, and for an attester who left', async () => {
    expect((await readLink(createMockRequest('/api/attest/x'), params('not-a-token'))).status).toBe(404)

    service.setTable('supplier_invoice_attest_links', { data: null })
    expect((await readLink(createMockRequest('/api/attest/t'), params())).status).toBe(404)

    service.setTable('supplier_invoice_attest_links', { data: link({ consumed_at: '2026-10-14T10:00:00Z' }) })
    expect((await readLink(createMockRequest('/api/attest/t'), params())).status).toBe(404)

    service.setTable('supplier_invoice_attest_links', { data: link({ expires_at: '2000-01-01T00:00:00Z' }) })
    expect((await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'approve' } }), params())).status).toBe(404)

    service.setTable('supplier_invoice_attest_links', { data: link() })
    service.setTable('company_members', { data: null })
    expect((await readLink(createMockRequest('/api/attest/t'), params())).status).toBe(404)
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('answers 404 to a viewer, who keeps no attest', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    service.setTable('company_members', { data: { ...writingMember.data, role: 'viewer' } })
    const res = await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'approve' } }), params())
    expect(res.status).toBe(404)
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('asks through the one live-membership read, so an archived company takes no decision', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    service.setTable('company_members', { data: null }) // the archived filter leaves no row
    const res = await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'approve' } }), params())
    expect(res.status).toBe(404)
    expect(service.findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])
    expect(service.findCalls('company_members', 'eq')).toEqual(
      expect.arrayContaining([
        ['user_id', ATTESTER],
        ['company_id', 'company-1'],
      ]),
    )
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('looks the token up by its sha256 hash, never in clear', async () => {
    service.setTable('supplier_invoice_attest_links', { data: null })
    await readLink(createMockRequest('/api/attest/t'), params())
    const eqCalls = service.findCalls('supplier_invoice_attest_links', 'eq')
    expect(eqCalls).toContainEqual(['token_hash', expect.stringMatching(/^[0-9a-f]{64}$/)])
    expect(JSON.stringify(eqCalls)).not.toContain(TOKEN)
  })

  it('shows the invoice and where the attest stands', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    service.setTable('supplier_invoices', {
      data: { user_id: 'registrant', supplier_invoice_number: 'F-1', arrival_number: 7, invoice_date: '2026-10-01', due_date: '2026-10-31', total: 12500, currency: 'SEK', document_id: 'doc-1', status: 'registered', approved_at: null, supplier: { name: 'Kontorsvaror AB' } },
    })
    service.setTable('companies', { data: { name: 'Testbolaget AB' } })
    getSupplierInvoiceAttestState.mockResolvedValue({
      ok: true,
      data: { policy: { mode: 'any' }, approved: [], remaining: [{ user_id: ATTESTER, name: 'Anna', email: null }], viewer: { may_approve: true, may_reject: true, reason: null } },
    })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await readLink(createMockRequest('/api/attest/t'), params()))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      company_name: 'Testbolaget AB',
      attester_name: `Namn ${ATTESTER}`,
      registered_by: 'Namn registrant',
      state: 'open',
      may_approve: true,
      invoice: { supplier_name: 'Kontorsvaror AB', total: 12500, has_document: true },
    })
    expect(getSupplierInvoiceAttestState).toHaveBeenCalledWith(expect.objectContaining({ userId: ATTESTER, companyId: 'company-1' }), 'inv-1', expect.anything())
  })

  it('refuses a body without a decision with 400', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    const response = await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'maybe' } }), params())
    expect(response.status).toBe(400)
  })

  it('approves as the attester from email_link and consumes the link', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    approveSupplierInvoice.mockResolvedValue({ ok: true, data: { invoice: { approved_at: null }, approved: false, attest: { remaining: ['bo'] }, attestation_id: 'att-1' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'approve' } }), params()),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ decision: 'approved', attested: false, remaining_count: 1 })
    expect(approveSupplierInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ATTESTER, companyId: 'company-1' }),
      expect.objectContaining({ invoiceId: 'inv-1', source: 'email_link' }),
    )
    expect(service.payloads('supplier_invoice_attest_links', 'update')[0]).toMatchObject({ consumed_at: expect.any(String) })
  })

  it('keeps the link when the attest policy refuses the decision', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    approveSupplierInvoice.mockResolvedValue({ ok: false, code: 'ATTEST_ALREADY_GIVEN' })
    const response = await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'approve' } }), params())
    expect(response.status).toBe(409)
    expect(service.payloads('supplier_invoice_attest_links', 'update')).toEqual([])
  })

  it('rejects with the comment', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    rejectSupplierInvoice.mockResolvedValue({ ok: true, data: { supplier_invoice_id: 'inv-1', attestation_id: 'att-2', status: 'registered' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await decide(createMockRequest('/api/attest/t/decision', { method: 'POST', body: { decision: 'reject', comment: 'Fel belopp' } }), params()),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ decision: 'rejected' })
    expect(rejectSupplierInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ATTESTER }),
      expect.objectContaining({ comment: 'Fel belopp', source: 'email_link' }),
    )
  })

  it('serves no document for an invoice without one', async () => {
    service.setTable('supplier_invoice_attest_links', { data: link() })
    service.setTable('supplier_invoices', { data: { document_id: null } })
    expect((await readDocument(createMockRequest('/api/attest/t/document'), params())).status).toBe(404)
  })
})
