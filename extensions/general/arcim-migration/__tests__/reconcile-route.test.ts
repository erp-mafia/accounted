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

vi.mock('../lib/refresh-migrated-payment-state', () => ({
  refreshMigratedSupplierPaymentState: vi.fn(),
}))

vi.mock('../lib/repair-migrated-invoice-paid-at', () => ({
  repairMigratedInvoicePaidAt: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { getConsent, ConsentNotFoundError } from '../lib/provider-client'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { relinkRegistrationVouchers } from '../lib/relink-registration-vouchers'
import { refreshMigratedSupplierPaymentState } from '../lib/refresh-migrated-payment-state'
import { repairMigratedInvoicePaidAt } from '../lib/repair-migrated-invoice-paid-at'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/reconcile',
)!
type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler

const mReconcile = reconcileSupplierInvoiceVouchers as Mock
const mRelink = relinkRegistrationVouchers as Mock
const mRefresh = refreshMigratedSupplierPaymentState as Mock
const mRepairPaidAt = repairMigratedInvoicePaidAt as Mock
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
const REFRESH_RESULT = {
  providerInvoices: 4, matched: 3, updated: 2, unchanged: 1, unmatched: 1, dryRun: false,
}

const PAID_AT_RESULT = {
  candidates: 311, setToDate: 0, setToDateBySource: { provider: 0, journal_entry: 0 }, setToNull: 311,
  leftAlone: {
    confirmedBySource: 0, ambiguousPaymentRows: 0, providerMaySupplyDate: 0,
    providerUnknown: 0, changedSinceRead: 0, notWritten: 0,
  },
  providers: ['fortnox'], writeError: null, dryRun: true,
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
    mRefresh.mockResolvedValue(REFRESH_RESULT)
    mRepairPaidAt.mockResolvedValue(PAID_AT_RESULT)
    mGetConsent.mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
  })

  it('returns 401 without a user and touches nothing', async () => {
    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx(null))

    expect(res.status).toBe(401)
    expect(mGetConsent).not.toHaveBeenCalled()
    expect(mReconcile).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
    expect(mRefresh).not.toHaveBeenCalled()
  })

  it('returns 401 without a user even when the paid_at repair is asked for', async () => {
    const res = await handler(reconcileRequest({ repairInvoicePaidAt: true }), buildCtx(null))

    expect(res.status).toBe(401)
    expect(mRepairPaidAt).not.toHaveBeenCalled()
  })

  it('without consentId runs the payment reconcile only and answers as before', async () => {
    const res = await handler(reconcileRequest({ dryRun: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, dryRun: true, result: PAYMENT_RESULT })
    expect(mReconcile).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1', dryRun: true }))
    expect(mGetConsent).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
    expect(mRefresh).not.toHaveBeenCalled()
  })

  it('with consentId validates the consent, runs all three passes and returns their counts', async () => {
    const res = await handler(reconcileRequest({ consentId: 'consent-1', dryRun: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({
      success: true,
      dryRun: true,
      result: PAYMENT_RESULT,
      registrationLinks: LINK_RESULT,
      paymentRefresh: REFRESH_RESULT,
    })
    expect(mGetConsent).toHaveBeenCalledWith('consent-1', 'company-1')
    expect(mRelink).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', consentId: 'consent-1', dryRun: true }))
    expect(mRefresh).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', consentId: 'consent-1', dryRun: true }))
  })

  it('answers 404 PROVIDER_CONSENT_NOT_FOUND for a foreign or unknown consent, before any write', async () => {
    mGetConsent.mockRejectedValue(new ConsentNotFoundError())

    const res = await handler(reconcileRequest({ consentId: 'consent-x' }), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('PROVIDER_CONSENT_NOT_FOUND')
    expect(mReconcile).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
    expect(mRefresh).not.toHaveBeenCalled()
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
      paymentRefresh: REFRESH_RESULT,
    })
  })

  it('classifies an unknown relink error as PROVIDER_MIGRATE_FAILED without leaking its message', async () => {
    mRelink.mockRejectedValue(new Error('socket hang up at 10.0.0.1'))

    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx())
    const { body } = await parseJsonResponse<{ registrationLinksError: { code: string } }>(res)

    expect(body.registrationLinksError).toEqual({ code: 'PROVIDER_MIGRATE_FAILED' })
    expect(JSON.stringify(body)).not.toContain('10.0.0.1')
  })

  it('keeps the relink result when the payment refresh fails, and names that failure separately', async () => {
    mRefresh.mockRejectedValue(new Error('socket hang up at 10.0.0.1'))

    const res = await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({
      success: true,
      dryRun: false,
      result: PAYMENT_RESULT,
      registrationLinks: LINK_RESULT,
      paymentRefresh: null,
      paymentRefreshError: { code: 'PROVIDER_MIGRATE_FAILED' },
    })
    expect(JSON.stringify(body)).not.toContain('10.0.0.1')
  })

  // ── invoicePaidAtRepair (#2798 C) ─────────────────────────────

  it('never runs the paid_at repair unless it is asked for: this route defaults to a real run', async () => {
    await handler(reconcileRequest(), buildCtx())
    await handler(reconcileRequest({ dryRun: true }), buildCtx())
    await handler(reconcileRequest({ consentId: 'consent-1' }), buildCtx())
    // Only the literal true opts in.
    await handler(reconcileRequest({ repairInvoicePaidAt: 'true' }), buildCtx())
    await handler(reconcileRequest({ repairInvoicePaidAt: 1 }), buildCtx())

    expect(mRepairPaidAt).not.toHaveBeenCalled()
  })

  it('runs the paid_at repair without a consent, company-scoped, and passes dryRun through', async () => {
    const res = await handler(reconcileRequest({ repairInvoicePaidAt: true, dryRun: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, dryRun: true, result: PAYMENT_RESULT, invoicePaidAtRepair: PAID_AT_RESULT })
    expect(mRepairPaidAt).toHaveBeenCalledTimes(1)
    expect(mRepairPaidAt).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', dryRun: true }))
    // No provider is involved: nothing to look a consent up for.
    expect(mGetConsent).not.toHaveBeenCalled()
    expect(mRelink).not.toHaveBeenCalled()
  })

  it('writes for real only when dryRun is not set', async () => {
    await handler(reconcileRequest({ repairInvoicePaidAt: true }), buildCtx())

    expect(mRepairPaidAt).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', dryRun: false }))
  })

  it('returns the paid_at repair beside the provider-backed passes when a consent is given too', async () => {
    const res = await handler(reconcileRequest({ consentId: 'consent-1', repairInvoicePaidAt: true, dryRun: true }), buildCtx())
    const { body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(body).toEqual({
      success: true,
      dryRun: true,
      result: PAYMENT_RESULT,
      registrationLinks: LINK_RESULT,
      paymentRefresh: REFRESH_RESULT,
      invoicePaidAtRepair: PAID_AT_RESULT,
    })
  })

  it('does not run the paid_at repair for a consent that is not the company\'s', async () => {
    mGetConsent.mockRejectedValue(new ConsentNotFoundError())

    const res = await handler(reconcileRequest({ consentId: 'consent-x', repairInvoicePaidAt: true }), buildCtx())

    expect(res.status).toBe(404)
    expect(mRepairPaidAt).not.toHaveBeenCalled()
  })

  it('keeps the other results when the paid_at repair fails, and leaks nothing of the failure', async () => {
    mRepairPaidAt.mockRejectedValue(new Error('provider_consents read failed: connection to 10.0.0.1 refused'))

    const res = await handler(reconcileRequest({ repairInvoicePaidAt: true }), buildCtx())
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(res)

    expect(status).toBe(200)
    expect(body).toEqual({
      success: true,
      dryRun: false,
      result: PAYMENT_RESULT,
      invoicePaidAtRepair: null,
      invoicePaidAtRepairError: { code: 'PROVIDER_MIGRATE_FAILED' },
    })
    expect(JSON.stringify(body)).not.toContain('10.0.0.1')
  })

  it('reports a write the database refused by its SQLSTATE only, never by its message', async () => {
    mRepairPaidAt.mockResolvedValue({
      ...PAID_AT_RESULT,
      setToNull: 0,
      leftAlone: { ...PAID_AT_RESULT.leftAlone, notWritten: 311 },
      writeError: { code: 'P0001', message: 'Archived migration reset source records are immutable' },
    })

    const res = await handler(reconcileRequest({ repairInvoicePaidAt: true }), buildCtx())
    const { body } = await parseJsonResponse<{ invoicePaidAtRepair: { writeError: unknown; leftAlone: { notWritten: number } } }>(res)

    expect(body.invoicePaidAtRepair.writeError).toEqual({ code: 'P0001' })
    expect(body.invoicePaidAtRepair.leftAlone.notWritten).toBe(311)
    expect(JSON.stringify(body)).not.toContain('Archived')
  })
})
