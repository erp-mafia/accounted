import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * POST /reconcile (#1463): the payment reconcile runs as before, and
 * `{ consentId }` adds the registration-voucher relink. The consent is
 * validated company-scoped BEFORE the payment reconcile writes anything (a
 * wrong id is a clean 404, not a 500 after a write), and a relink failure is
 * reported beside the payment result that was already persisted instead of
 * discarding it.
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn(),
}))

vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn(),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('../lib/relink-registration-vouchers', () => ({
  relinkRegistrationVouchers: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { getConsent, ConsentNotFoundError } from '../lib/provider-client'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { relinkRegistrationVouchers } from '../lib/relink-registration-vouchers'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/reconcile',
)!
type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler

const mReconcile = reconcileSupplierInvoiceVouchers as Mock
const mRelink = relinkRegistrationVouchers as Mock
const mGetConsent = getConsent as Mock

const PAYMENT_RESULT = { scanned: 3, autoLinked: 2, ambiguous: 0, unmatched: 1, items: [] }
const LINK_RESULT = {
  scanned: 2, linked: 1, noRef: 0, refNotFetched: 1, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0,
  reports: [], providerInvoices: 2, matched: 2, unmatched: 0,
  hydration: {
    sales: { needed: 1, hydrated: 0, failed: 0, skippedForBudget: 1 },
    supplier: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 },
  },
}

function buildCtx(user: { id: string } | null = { id: 'user-1' }): ExtensionContext {
  const { supabase } = createMockSupabase()
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user } }),
  }
  return { supabase, companyId: 'company-1', log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as ExtensionContext
}

function reconcileRequest(body?: Record<string, unknown>) {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/reconcile', {
    method: 'POST',
    ...(body ? { body } : {}),
  })
}

describe('POST /reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mReconcile.mockResolvedValue(PAYMENT_RESULT)
    mRelink.mockResolvedValue(LINK_RESULT)
    mGetConsent.mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
  })

  it('returns 401 without a user and touches nothing', async () => {
    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx(null))

    expect(res.status).toBe(401)
    expect(mGetConsent).not.toHaveBeenCalled()
    expect(mReconcile).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
  })

  it('without consentId runs the payment reconcile only and answers as before', async () => {
    const res = await handler(reconcileRequest({ dryRun: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, dryRun: true, result: PAYMENT_RESULT })
    expect(mReconcile).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1', dryRun: true }))
    expect(mGetConsent).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
  })

  it('with consentId validates the consent, runs both passes and returns the link counts', async () => {
    const res = await handler(reconcileRequest({ consentId: 'consent-1', dryRun: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, dryRun: true, result: PAYMENT_RESULT, registrationLinks: LINK_RESULT })
    expect(mGetConsent).toHaveBeenCalledWith('consent-1', 'company-1')
    expect(mRelink).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', consentId: 'consent-1', dryRun: true }))
  })

  it('answers 404 PROVIDER_CONSENT_NOT_FOUND for a foreign or unknown consent, before any write', async () => {
    mGetConsent.mockRejectedValue(new ConsentNotFoundError())

    const res = await handler(reconcileRequest({ consentId: 'consent-x' }), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('PROVIDER_CONSENT_NOT_FOUND')
    expect(mReconcile).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
  })

  it('keeps the persisted payment result when the relink itself fails, and names the failure', async () => {
    mRelink.mockRejectedValue({ status: 404, message: 'Consent not found' })

    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({
      success: true,
      dryRun: false,
      result: PAYMENT_RESULT,
      registrationLinks: null,
      registrationLinksError: { code: 'PROVIDER_CONSENT_NOT_FOUND' },
    })
  })

  it('classifies an unknown relink error as PROVIDER_MIGRATE_FAILED without leaking its message', async () => {
    mRelink.mockRejectedValue(new Error('socket hang up at 10.0.0.1'))

    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx())
    const { body } = await parseJsonResponse<{ registrationLinksError: { code: string } }>(res)

    expect(body.registrationLinksError).toEqual({ code: 'PROVIDER_MIGRATE_FAILED' })
    expect(JSON.stringify(body)).not.toContain('10.0.0.1')
  })
})
