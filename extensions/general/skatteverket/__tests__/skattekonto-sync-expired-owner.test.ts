/**
 * When a sync run on another member's token dies with a terminal auth error,
 * the connection-expired event must name the token OWNER, not whoever
 * pressed "Synkronisera nu": only the owner can redo the BankID consent, and
 * the notification handler keys its dedup on the owner's token row (#1673).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', () => ({
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

import { syncSkattekonto } from '../lib/skattekonto-sync'
import { SkatteverketAuthError } from '../lib/api-client'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeCtx(userId: string): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId,
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

describe('syncSkattekonto: connection.expired names the token owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    const dead = new SkatteverketAuthError('Sessionen har gått ut. Logga in med BankID igen.', 'SESSION_EXPIRED')
    getSaldoMock.mockRejectedValue(dead)
    getTransaktionerMock.mockRejectedValue(dead)
  })

  it('member B syncs on member A\'s token: the event carries A', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = []
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(async (event) => {
      emitted.push(event as { type: string; payload: Record<string, unknown> })
    })

    await expect(
      syncSkattekonto(makeCtx('user-b'), {
        mode: 'user',
        supabase: supabase as unknown as SupabaseClient,
        userId: 'user-a',
        companyId: 'company-1',
      }),
    ).rejects.toBeInstanceOf(SkatteverketAuthError)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'skattekonto.connection.expired',
      payload: { reason: 'SESSION_EXPIRED', userId: 'user-a', companyId: 'company-1' },
    })
    emitSpy.mockRestore()
  })

  it('default (own token) keeps the ctx user as recipient', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = []
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(async (event) => {
      emitted.push(event as { type: string; payload: Record<string, unknown> })
    })

    await expect(syncSkattekonto(makeCtx('user-a'))).rejects.toBeInstanceOf(SkatteverketAuthError)

    expect(emitted[0]?.payload).toMatchObject({ userId: 'user-a' })
    emitSpy.mockRestore()
  })
})
