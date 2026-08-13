/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warnRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn() }))

// log.warn is suppressed under NODE_ENV=test, so the failure-path tests
// observe it through this mock instead of a console spy.
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnRecorder,
    error: vi.fn(),
    child() {
      return this
    },
  }),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn().mockReturnValue({ stub: 'ctx' }),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn().mockResolvedValue(true),
}))

vi.mock('../lib/skattekonto-sync', () => ({
  syncSkattekonto: vi.fn(),
}))

vi.mock('../lib/agi-kvittens-reconcile', () => ({
  reconcileAgiDeclaration: vi.fn(),
}))

// Real SkatteverketAuthError shape (message, code) without dragging the full
// api-client module (and its fetch plumbing) into the test.
vi.mock('../lib/api-client', () => ({
  SkatteverketAuthError: class SkatteverketAuthError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock('../lib/token-store', () => ({
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
  RECONSENT_ERROR_CODES: ['SESSION_EXPIRED', 'REFRESH_EXHAUSTED', 'MISSING_SCOPE', 'TOKEN_CORRUPTED'],
}))

import { runPostConnectRefresh } from '../lib/post-connect-refresh'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { syncSkattekonto } from '../lib/skattekonto-sync'
import { SkatteverketAuthError } from '../lib/api-client'
import { markNeedsReconsent } from '../lib/token-store'
import { reconcileAgiDeclaration } from '../lib/agi-kvittens-reconcile'

const mockCreateExtensionContext = vi.mocked(createExtensionContext)
const mockHasCapability = vi.mocked(hasCapability)
const mockSyncSkattekonto = vi.mocked(syncSkattekonto)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)
const mockReconcile = vi.mocked(reconcileAgiDeclaration)

const USER = 'user-1'
const COMPANY = 'company-1'

function pendingDecl(id: string) {
  return {
    id,
    company_id: COMPANY,
    salary_run_id: null,
    period_year: 2026,
    period_month: 5,
  }
}

/** Thenable select chain for the agi_declarations pending lookup. */
function makeSupabase(result: { data: unknown; error?: unknown }) {
  const chain: any = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data, error: result.error ?? null })
  return { from: vi.fn(() => chain) } as any
}

describe('runPostConnectRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateExtensionContext.mockReturnValue({ stub: 'ctx' } as any)
    mockHasCapability.mockResolvedValue(true)
    mockSyncSkattekonto.mockResolvedValue({
      booked: 1,
      upcoming: 0,
      saldoSkatteverket: 100,
      saldoKronofogden: 0,
      syncedAt: '2026-07-12T21:30:00Z',
    } as any)
  })

  it('syncs and reconciles pending declarations on the happy path', async () => {
    const supabase = makeSupabase({ data: [pendingDecl('d-1'), pendingDecl('d-2')] })
    mockReconcile
      .mockResolvedValueOnce({ status: 'signed', kvittensnummer: 'uuid-1' })
      .mockResolvedValueOnce({ status: 'still_pending' })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true, reconciled: 1 })
    expect(mockCreateExtensionContext).toHaveBeenCalledWith(supabase, USER, COMPANY, 'skatteverket')
    expect(mockSyncSkattekonto).toHaveBeenCalledWith({ stub: 'ctx' })
    expect(mockReconcile).toHaveBeenCalledTimes(2)
    expect(mockReconcile).toHaveBeenCalledWith(supabase, pendingDecl('d-1'), {
      reconciledBy: 'post-connect',
      userId: USER,
    })
  })

  it('does nothing when the skatteverket capability is not entitled', async () => {
    mockHasCapability.mockResolvedValueOnce(false)
    const supabase = makeSupabase({ data: [pendingDecl('d-1')] })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false, reconciled: 0 })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('still reconciles kvittenser when the sync fails', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(new Error('SKV timeout'))
    const supabase = makeSupabase({ data: [pendingDecl('d-1')] })
    mockReconcile.mockResolvedValueOnce({ status: 'signed', kvittensnummer: 'uuid-1' })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false, reconciled: 1 })
    // A plain network/timeout failure is transient: it must not flag the
    // freshly granted token as needing re-consent.
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
  })

  it('persists needs_reconsent when the sync hits a terminal auth error (MISSING_SCOPE)', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('The required scopes are not authorized', 'MISSING_SCOPE'),
    )
    const supabase = makeSupabase({ data: [] })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result.synced).toBe(false)
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(supabase, USER, COMPANY, 'MISSING_SCOPE')
  })

  it('does not persist needs_reconsent for non-terminal auth error codes', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('temporary auth hiccup', 'NOT_CONNECTED'),
    )
    const supabase = makeSupabase({ data: [] })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result.synced).toBe(false)
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
  })

  it('continues with remaining declarations when one reconcile throws', async () => {
    const supabase = makeSupabase({ data: [pendingDecl('d-1'), pendingDecl('d-2')] })
    mockReconcile
      .mockRejectedValueOnce(new Error('SESSION_EXPIRED'))
      .mockResolvedValueOnce({ status: 'signed', kvittensnummer: 'uuid-2' })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true, reconciled: 1 })
    expect(mockReconcile).toHaveBeenCalledTimes(2)
  })

  it('never throws when the capability check itself fails', async () => {
    mockHasCapability.mockRejectedValueOnce(new Error('db down'))
    const supabase = makeSupabase({ data: [] })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false, reconciled: 0 })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
  })

  it('handles an empty pending lookup', async () => {
    const supabase = makeSupabase({ data: null })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true, reconciled: 0 })
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('logs a failed pending lookup instead of treating it as no rows', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset' } })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true, reconciled: 0 })
    expect(mockReconcile).not.toHaveBeenCalled()
    const warned = warnRecorder.mock.calls.map(c => String(c[0]))
    expect(warned.some(m => m.includes('kvittens lookup failed'))).toBe(true)
  })

  it('logs non-throw error outcomes from the reconciler', async () => {
    const supabase = makeSupabase({ data: [pendingDecl('d-1'), pendingDecl('d-2')] })
    mockReconcile
      .mockResolvedValueOnce({ status: 'error', error: 'SKV svarade 500' })
      .mockResolvedValueOnce({ status: 'signed', kvittensnummer: 'uuid-2' })

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true, reconciled: 1 })
    const errorWarn = warnRecorder.mock.calls.find(c =>
      String(c[0]).includes('reconcile returned error'),
    )
    expect(errorWarn).toBeDefined()
    expect(errorWarn?.[1]).toMatchObject({ declarationId: 'd-1', message: 'SKV svarade 500' })
  })
})
