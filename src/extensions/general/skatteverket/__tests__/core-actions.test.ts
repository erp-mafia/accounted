/**
 * The registry-resolved services behind the v1 AGI pre-validation and the
 * skattekonto sync (lib/core-actions.ts): the SKATTEVERKET_ENABLED and paid
 * capability gate a direct service call must apply itself, schema
 * re-validation before anything is sent, the SKV status mapping, the audit
 * row, and a sync preview that never reaches Skatteverket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: (...args: unknown[]) => hasCapabilityMock(...args) }
})
const huMock = vi.fn()
const iuMock = vi.fn()
vi.mock('../lib/agi-client', () => ({
  agiKontrolleraHU: (...args: unknown[]) => huMock(...args),
  agiKontrolleraIU: (...args: unknown[]) => iuMock(...args),
}))
const auditMock = vi.fn()
vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: (...args: unknown[]) => auditMock(...args) }))
const resolveReadAuthMock = vi.fn()
vi.mock('../lib/resolve-auth', () => ({ resolveReadAuth: (...args: unknown[]) => resolveReadAuthMock(...args) }))
const syncMock = vi.fn()
vi.mock('../lib/skattekonto-sync', () => ({
  syncSkattekonto: (...args: unknown[]) => syncMock(...args),
  SKATTEKONTO_LAST_SYNCED_AT_KEY: 'skattekonto_last_synced_at',
}))
vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: (supabase: unknown, userId: string, companyId: string) => ({
    supabase,
    userId,
    companyId,
    settings: { get: vi.fn().mockResolvedValue('2026-09-26T07:00:00.000Z'), set: vi.fn() },
  }),
}))

import { SkatteverketAuthError } from '../lib/api-client'
import { previewSkattekontoSync, syncSkattekontoNow, validateAgiUppgift } from '../lib/core-actions'

const supabase = {} as never
const HU = { agRegistreradId: '165560000167', redovisningsPeriod: '202609', summaSkatteavdr: 8200 }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SKATTEVERKET_ENABLED = 'true'
  hasCapabilityMock.mockResolvedValue(true)
  auditMock.mockResolvedValue(undefined)
})
afterEach(() => {
  delete process.env.SKATTEVERKET_ENABLED
})

describe('validateAgiUppgift', () => {
  it('answers EXTENSION_DISABLED when the integration is off, without calling SKV', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: HU })
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_DISABLED', http_status: 503 })
    expect(huMock).not.toHaveBeenCalled()
  })

  it('answers SKATTEVERKET_CAPABILITY_BLOCKED without the paid capability', async () => {
    hasCapabilityMock.mockResolvedValue(false)
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: HU })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_CAPABILITY_BLOCKED', http_status: 403 })
    expect(huMock).not.toHaveBeenCalled()
  })

  it('re-validates the payload against the v1.7 schema before sending', async () => {
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: { ...HU, extra: 1 } })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', http_status: 400 })
    expect(huMock).not.toHaveBeenCalled()
  })

  it('answers the kontrollsvar and writes an ok audit row', async () => {
    huMock.mockResolvedValue({ ok: true, status: 200, data: { status: 'OK', fel: [] } })
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: HU })
    expect(result).toEqual({ ok: true, data: { status: 'OK', fel: [] } })
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endpoint: 'agi.kontrollera.hu', outcome: 'ok', skvStatus: 'OK', agRegistreradId: HU.agRegistreradId }),
    )
  })

  it('maps an SKV 403 to SKATTEVERKET_ACCESS_DENIED with SKV\'s status and felkod', async () => {
    huMock.mockResolvedValue({ ok: false, status: 403, error: 'Behörighet saknas', body: { kod: 'E403' } })
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: HU })
    expect(result).toMatchObject({
      ok: false,
      code: 'SKATTEVERKET_ACCESS_DENIED',
      http_status: 403,
      details: { skv_status: 403, skv_kod: 'E403' },
    })
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'auth_error' }))
  })

  it('maps a thrown auth error (no connection) to SKATTEVERKET_NOT_CONNECTED', async () => {
    huMock.mockRejectedValue(new SkatteverketAuthError('Inte ansluten', 'NOT_CONNECTED'))
    const result = await validateAgiUppgift(supabase, 'u', 'c', { uppgift: 'huvuduppgift', payload: HU })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', details: { skv_code: 'NOT_CONNECTED' } })
  })
})

describe('skattekonto sync services', () => {
  it('the preview resolves the connection and never syncs', async () => {
    resolveReadAuthMock.mockResolvedValue({ ok: true, auth: { mode: 'system' }, source: 'system', tokenUserId: null })
    const result = await previewSkattekontoSync(supabase, 'u', 'c')
    expect(result).toEqual({ ok: true, data: { auth_source: 'system', last_synced_at: '2026-09-26T07:00:00.000Z' } })
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('an expired connection answers SESSION_EXPIRED without a sync attempt', async () => {
    resolveReadAuthMock.mockResolvedValue({ ok: false, reason: 'needs_reconsent' })
    const result = await syncSkattekontoNow(supabase, 'u', 'c')
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', details: { skv_code: 'SESSION_EXPIRED' } })
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('syncs on the resolved company auth', async () => {
    const auth = { mode: 'user', userId: 'owner' }
    resolveReadAuthMock.mockResolvedValue({ ok: true, auth, source: 'user', tokenUserId: 'owner' })
    syncMock.mockResolvedValue({ booked: 1, upcoming: 0, skipped: 0, saldoSkatteverket: 0, saldoKronofogden: 0, syncedAt: 'now' })
    const result = await syncSkattekontoNow(supabase, 'u', 'c')
    expect(result).toMatchObject({ ok: true, data: { booked: 1 } })
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'c' }), auth)
  })
})
