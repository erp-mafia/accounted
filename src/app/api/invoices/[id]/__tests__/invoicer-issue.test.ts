import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
  makeInvoice,
  parseJsonResponse,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'

/**
 * What the invoicing-only role can do through the two issue routes it was
 * given for #206 (lib/auth/invoicer-role.ts): number a draft (finalize) and
 * issue it without sending (mark-sent). Both run on the company-scoped
 * client. Finalize books nothing; mark-sent books what send books and is
 * refused the one thing send cannot do, issuing the invoice as paid.
 */

const session = createQueuedMockSupabase()
const scoped = createQueuedMockSupabase()
const state = vi.hoisted(() => ({ role: 'invoicer' as CompanyRole | undefined }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(session.supabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn(async (_supabase: unknown, _userId: string, facts?: ActiveCompanyFacts) => {
    if (facts && state.role) facts.role = state.role
    return 'company-1'
  }),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/auth/company-scoped-client', () => ({
  createCompanyScopedClient: vi.fn(() => scoped.supabase),
}))

const mockEnsureInvoiceNumber = vi.fn(async (..._args: unknown[]) => '2026001')
vi.mock('@/lib/invoices/ensure-invoice-number', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices/ensure-invoice-number')>()
  return { ...actual, ensureInvoiceNumber: (...args: unknown[]) => mockEnsureInvoiceNumber(...args) }
})

const mockIssueAndBook = vi.fn(async (..._args: unknown[]) => ({ ok: true, journalEntryId: 'je-1', partialFailures: [] }))
vi.mock('@/lib/invoices/issue-and-book-invoice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices/issue-and-book-invoice')>()
  return { ...actual, issueAndBookInvoice: (...args: unknown[]) => mockIssueAndBook(...args) }
})

import { POST as finalize } from '../finalize/route'
import { POST as markSent } from '../mark-sent/route'

const ID = '550e8400-e29b-41d4-a716-446655440000'
const draft = () => makeInvoice({ id: ID, invoice_number: null, status: 'draft', document_type: 'invoice', customer_id: 'cust-1' })

function post(path: 'finalize' | 'mark-sent', body?: unknown) {
  const request = createMockRequest(`/api/invoices/${ID}/${path}`, { method: 'POST', ...(body === undefined ? {} : { body }) })
  return (path === 'finalize' ? finalize : markSent)(request, createMockRouteParams({ id: ID }))
}

beforeEach(() => {
  vi.clearAllMocks()
  session.reset()
  scoped.reset()
  eventBus.clear()
  state.role = 'invoicer'
  session.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('finalize under the invoicing-only role', () => {
  it('numbers the draft and announces it, on the company-scoped client, and touches no other table', async () => {
    scoped.enqueue({ data: draft(), error: null })
    scoped.enqueue({ data: { ...draft(), invoice_number: '2026001', customer: makeCustomer({ id: 'cust-1' }), items: [] }, error: null })
    const emitted = vi.spyOn(eventBus, 'emit')

    const response = await post('finalize')

    expect(response.status).toBe(200)
    expect(mockEnsureInvoiceNumber).toHaveBeenCalledTimes(1)
    expect(mockEnsureInvoiceNumber.mock.calls[0][0]).toBe(scoped.supabase)
    expect(mockEnsureInvoiceNumber.mock.calls[0][1]).toBe('company-1')
    // Nothing but the invoice is read or written, and nothing through the role's own session.
    expect([...new Set(scoped.calls.map((call) => call.table))]).toEqual(['invoices'])
    expect(session.calls).toEqual([])
    // The one event is the one POST /api/invoices emits for a numbered invoice.
    expect(emitted.mock.calls.map(([event]) => event.type)).toEqual(['invoice.created'])
    expect(mockIssueAndBook).not.toHaveBeenCalled()
  })

  it('has no way to the ledger: the route imports neither the engine nor the issue-and-book step', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/api/invoices/[id]/finalize/route.ts'), 'utf8')
    expect(source).not.toMatch(/@\/lib\/bookkeeping\/(engine|invoice-entries)|issue-and-book-invoice|credit-invoice|createJournalEntry|commitEntry/)
    // The same numbering step the already allowed POST /api/invoices runs.
    expect(source).toContain('ensureInvoiceNumber')
    expect(readFileSync(join(process.cwd(), 'src/app/api/invoices/route.ts'), 'utf8')).toContain('ensureInvoiceNumber')
  })

  it('refuses what any role is refused: an invoice that is not an unnumbered draft', async () => {
    scoped.enqueue({ data: { ...draft(), status: 'sent', invoice_number: '2026001' }, error: null })
    const response = await post('finalize')
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
  })
})

describe('mark-sent under the invoicing-only role', () => {
  const full = () => ({ ...draft(), customer: makeCustomer({ id: 'cust-1' }), items: [] })

  it('issues the draft through the shared issue step, on the company-scoped client, never as paid', async () => {
    scoped.enqueue({ data: full(), error: null })
    scoped.enqueue({ data: makeCompanySettings(), error: null })

    const response = await post('mark-sent')

    expect(response.status).toBe(200)
    expect(mockIssueAndBook).toHaveBeenCalledTimes(1)
    expect(mockIssueAndBook.mock.calls[0][0]).toMatchObject({ supabase: scoped.supabase, companyId: 'company-1', userId: 'user-1', paidAtIssue: null })
    expect((await parseJsonResponse(response)).body).toMatchObject({ success: true, status: 'sent' })
    expect(session.calls).toEqual([])
  })

  it('is refused paid_at_issue, which would also register the payment: nothing is numbered or booked', async () => {
    scoped.enqueue({ data: full(), error: null })

    const response = await post('mark-sent', { paid_at_issue: { account_number: '1930' } })

    expect(response.status).toBe(403)
    expect(JSON.stringify((await parseJsonResponse(response)).body)).toContain('INVOICER_PAID_AT_ISSUE_NOT_ALLOWED')
    expect(mockIssueAndBook).not.toHaveBeenCalled()
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
  })

  it('leaves paid_at_issue as it was for the roles that keep the books, and for a role the resolution did not report', async () => {
    for (const role of ['owner', 'admin', 'member', undefined] as const) {
      state.role = role
      session.reset()
      mockIssueAndBook.mockClear()
      session.enqueue({ data: full(), error: null })
      session.enqueue({ data: makeCompanySettings(), error: null })

      const response = await post('mark-sent', { paid_at_issue: { account_number: '1930' } })

      expect(response.status, String(role)).toBe(200)
      expect(mockIssueAndBook.mock.calls[0][0], String(role)).toMatchObject({
        supabase: session.supabase,
        paidAtIssue: { settlementAccountNumber: '1930' },
      })
    }
  })
})
