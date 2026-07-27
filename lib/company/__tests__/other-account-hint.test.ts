import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { shouldShowOtherAccountHint } from '../other-account-hint'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockCreateServiceClient = vi.mocked(createServiceClient)

/**
 * Chainable query mock keyed by table name: every method returns the chain,
 * awaiting it resolves with the configured { data, error } for that table.
 */
function buildClient(resultsByTable: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from: vi.fn((table: string) => {
      const result = {
        data: resultsByTable[table]?.data ?? null,
        error: resultsByTable[table]?.error ?? null,
      }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'limit', 'order', 'range']) {
        chain[m] = () => chain
      }
      ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result)
      return chain
    }),
  }
}

const OWN_COMPANY = { id: 'own-co', org_number: '5560125790' }

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateServiceClient.mockReturnValue(
    buildClient({ companies: { data: [] }, journal_entries: { data: [] } }) as never,
  )
})

describe('shouldShowOtherAccountHint', () => {
  it('is false when the account has journal entries (common case, no probe)', async () => {
    const supabase = buildClient({
      companies: { data: [OWN_COMPANY] },
      journal_entries: { data: [{ id: 'je1' }] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('is true when the account is empty and a same-orgnr company elsewhere has entries', async () => {
    const supabase = buildClient({
      companies: { data: [OWN_COMPANY] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }, { id: 'other-co' }] },
        journal_entries: { data: [{ id: 'je-other' }] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(true)
  })

  it('is false when the same-orgnr company elsewhere is also empty', async () => {
    const supabase = buildClient({
      companies: { data: [OWN_COMPANY] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }, { id: 'other-co' }] },
        journal_entries: { data: [] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
  })

  it('is false when no other account shares the org number', async () => {
    const supabase = buildClient({
      companies: { data: [OWN_COMPANY] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }] },
        journal_entries: { data: [{ id: 'je-other' }] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
  })

  it('is false when the user has no companies', async () => {
    const supabase = buildClient({ companies: { data: [] }, journal_entries: { data: [] } })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
  })

  it('is false when own companies have no org number', async () => {
    const supabase = buildClient({
      companies: { data: [{ id: 'own-co', org_number: null }] },
      journal_entries: { data: [] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('fails soft to false on query errors', async () => {
    const supabase = buildClient({
      companies: { error: { message: 'boom' } },
      journal_entries: { data: [] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
  })

  it('fails soft to false when the service client throws', async () => {
    const supabase = buildClient({
      companies: { data: [OWN_COMPANY] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockImplementation(() => {
      throw new Error('no service key')
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient)).resolves.toBe(false)
  })
})
