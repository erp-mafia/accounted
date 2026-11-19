/**
 * B07: when Skatteverket will not hand the skattekonto over because of a
 * STATE (no account yet: 404 / felkod 3; the consenting person not
 * authorized: 403 felkod 6 -> BEHORIGHET_SAKNAS), syncSkattekonto records it
 * per company for the settings panel and the cron's slower re-check, and
 * still rethrows so every caller sees the answer. A real failure records
 * nothing, and the next successful sync clears the state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-client')>()),
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

import {
  syncSkattekonto,
  skattekontoUnavailableReason,
  SKATTEKONTO_UNAVAILABLE_KEY,
} from '../lib/skattekonto-sync'
import { SkatteverketSkattekontoError } from '../lib/skattekonto-client'
import { SkatteverketAuthError } from '../lib/api-client'
import type { ExtensionContext } from '@/lib/extensions/types'

const settingsGet = vi.fn()
const settingsSet = vi.fn()
const settingsClear = vi.fn()

function makeCtx(): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    settings: { get: settingsGet, set: settingsSet, clear: settingsClear },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

const NO_ACCOUNT = new SkatteverketSkattekontoError('Inget skattekonto är registrerat hos Skatteverket.', null, 404)

function unavailableWrites() {
  return settingsSet.mock.calls.filter(([key]) => key === SKATTEKONTO_UNAVAILABLE_KEY)
}

describe('syncSkattekonto: Skatteverket answers with a state, not data', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    settingsGet.mockResolvedValue(null)
    settingsSet.mockResolvedValue(undefined)
    settingsClear.mockResolvedValue(undefined)
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods
  })

  it('a 404 records no_account and rethrows, without a connection-expired event', async () => {
    getSaldoMock.mockRejectedValue(NO_ACCOUNT)
    getTransaktionerMock.mockRejectedValue(NO_ACCOUNT)
    const emitSpy = vi.spyOn(eventBus, 'emit')

    await expect(syncSkattekonto(makeCtx())).rejects.toBe(NO_ACCOUNT)

    const writes = unavailableWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toEqual({
      reason: 'no_account',
      since: expect.any(String),
      checkedAt: expect.any(String),
    })
    expect(emitSpy).not.toHaveBeenCalled()
    emitSpy.mockRestore()
  })

  it('a repeat of the same answer keeps when it started', async () => {
    getSaldoMock.mockRejectedValue(NO_ACCOUNT)
    getTransaktionerMock.mockRejectedValue(NO_ACCOUNT)
    settingsGet.mockImplementation(async (key: string) =>
      key === SKATTEKONTO_UNAVAILABLE_KEY
        ? { reason: 'no_account', since: '2026-10-20T10:00:00.000Z', checkedAt: '2026-10-20T10:00:00.000Z' }
        : null,
    )

    await expect(syncSkattekonto(makeCtx())).rejects.toBe(NO_ACCOUNT)

    const state = unavailableWrites()[0][1] as { since: string; checkedAt: string }
    expect(state.since).toBe('2026-10-20T10:00:00.000Z')
    expect(state.checkedAt > state.since).toBe(true)
  })

  it('felkod 6 (BEHORIGHET_SAKNAS) records not_authorized', async () => {
    const denied = new SkatteverketAuthError('Du har inte behörighet', 'BEHORIGHET_SAKNAS')
    getSaldoMock.mockRejectedValue(denied)
    getTransaktionerMock.mockRejectedValue(denied)

    await expect(syncSkattekonto(makeCtx())).rejects.toBe(denied)

    expect(unavailableWrites()[0][1]).toMatchObject({ reason: 'not_authorized' })
  })

  it('a real failure records nothing', async () => {
    const internal = new SkatteverketSkattekontoError('Internt fel hos Skatteverket.', 4, 500)
    getSaldoMock.mockRejectedValue(internal)
    getTransaktionerMock.mockRejectedValue(internal)

    await expect(syncSkattekonto(makeCtx())).rejects.toBe(internal)

    expect(unavailableWrites()).toHaveLength(0)
  })

  it('a failing state write never masks Skatteverket\'s answer', async () => {
    getSaldoMock.mockRejectedValue(NO_ACCOUNT)
    getTransaktionerMock.mockRejectedValue(NO_ACCOUNT)
    settingsSet.mockRejectedValue(new Error('db down'))

    await expect(syncSkattekonto(makeCtx())).rejects.toBe(NO_ACCOUNT)
  })

  it('a successful sync clears the state', async () => {
    getSaldoMock.mockResolvedValue({ saldoSkatteverket: 0, saldoKronofogden: 0 })
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [] })

    await syncSkattekonto(makeCtx())

    expect(settingsClear).toHaveBeenCalledWith(SKATTEKONTO_UNAVAILABLE_KEY)
    expect(unavailableWrites()).toHaveLength(0)
  })
})

describe('skattekontoUnavailableReason', () => {
  it('names the two states and nothing else', () => {
    expect(skattekontoUnavailableReason(NO_ACCOUNT)).toBe('no_account')
    expect(skattekontoUnavailableReason(new SkatteverketSkattekontoError('x', 3, 400))).toBe('no_account')
    expect(skattekontoUnavailableReason(new SkatteverketAuthError('x', 'BEHORIGHET_SAKNAS'))).toBe('not_authorized')
    expect(skattekontoUnavailableReason(new SkatteverketAuthError('x', 'ACCESS_DENIED'))).toBeNull()
    expect(skattekontoUnavailableReason(new SkatteverketAuthError('x', 'SESSION_EXPIRED'))).toBeNull()
    expect(skattekontoUnavailableReason(new SkatteverketSkattekontoError('x', null, 500))).toBeNull()
    expect(skattekontoUnavailableReason(new Error('x'))).toBeNull()
  })
})
