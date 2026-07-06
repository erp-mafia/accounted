import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// syncMappedAccounts is exercised by its own suite — here it only needs to be
// observable so allocatePsd2LedgerAccount's chart-ensure call can be asserted.
const { mockSyncMappedAccounts } = vi.hoisted(() => ({
  mockSyncMappedAccounts: vi.fn(),
}))
vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: (...args: unknown[]) => mockSyncMappedAccounts(...args),
}))

import {
  findFreeLedgerAccount,
  allocatePsd2LedgerAccount,
  defaultLedgerForCurrency,
} from '../service'

type CashRow = { ledger_account: string; bank_connection_id: string | null }

function makeSupabase(rows: CashRow[], error: { message: string } | null = null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn(() => Promise.resolve({ data: error ? null : rows, error })),
    })),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSyncMappedAccounts.mockResolvedValue({
    created: 1,
    renamed: 0,
    renamedAccounts: [],
    renameFailed: 0,
    error: null,
  })
})

describe('defaultLedgerForCurrency', () => {
  it('maps the four known currencies and falls back to 1930', () => {
    expect(defaultLedgerForCurrency('SEK')).toBe('1930')
    expect(defaultLedgerForCurrency('eur')).toBe('1932')
    expect(defaultLedgerForCurrency('USD')).toBe('1933')
    expect(defaultLedgerForCurrency('GBP')).toBe('1934')
    expect(defaultLedgerForCurrency('NOK')).toBe('1930')
  })
})

describe('findFreeLedgerAccount', () => {
  it('returns the currency default when nothing holds it', async () => {
    const supabase = makeSupabase([])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
    expect(await findFreeLedgerAccount(supabase, 'c1', 'EUR')).toBe('1932')
  })

  it('returns the default when only a MANUAL row holds it (seed promotion)', async () => {
    // The seeded 1930 row has no bank connection — upsertFromPsd2 promotes it
    // in place, so the slot counts as free.
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: null }])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
  })

  it('overflows to 1931 when a CONNECTED row holds the default', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1931')
  })

  it('never hands out another currency default as an overflow slot', async () => {
    const supabase = makeSupabase([
      { ledger_account: '1930', bank_connection_id: 'conn-1' },
      { ledger_account: '1931', bank_connection_id: 'conn-1' },
    ])
    // 1932/1933/1934 are reserved for EUR/USD/GBP — next free is 1935.
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1935')
  })

  it('does not steal a manual account on an overflow slot', async () => {
    const supabase = makeSupabase([
      { ledger_account: '1930', bank_connection_id: 'conn-1' },
      // Manual (e.g. SIE-imported) account on 1931 — promoting it would
      // silently repoint an unrelated account.
      { ledger_account: '1931', bank_connection_id: null },
    ])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1935')
  })

  it('honors the exclude set for slots assigned earlier in the caller loop', async () => {
    const supabase = makeSupabase([])
    const exclude = new Set(['1930', '1931'])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK', exclude)).toBe('1935')
  })

  it('returns null when every slot in 1931–1959 is taken', async () => {
    const rows: CashRow[] = [{ ledger_account: '1930', bank_connection_id: 'conn-1' }]
    for (let n = 1931; n <= 1959; n++) {
      rows.push({ ledger_account: String(n), bank_connection_id: 'conn-1' })
    }
    const supabase = makeSupabase(rows)
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBeNull()
  })

  it('returns null when the lookup fails', async () => {
    const supabase = makeSupabase([], { message: 'boom' })
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBeNull()
  })
})

describe('allocatePsd2LedgerAccount', () => {
  it('allocates a slot and ensures it exists in the chart of accounts', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }])

    const ledger = await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', {
      currency: 'SEK',
      accountName: 'Sparkonto',
    })

    expect(ledger).toBe('1931')
    expect(mockSyncMappedAccounts).toHaveBeenCalledTimes(1)
    const [, companyId, userId, mappings] = mockSyncMappedAccounts.mock.calls[0]
    expect(companyId).toBe('c1')
    expect(userId).toBe('u1')
    expect(mappings).toEqual([
      expect.objectContaining({
        sourceAccount: '1931',
        targetAccount: '1931',
        sourceName: 'Sparkonto',
      }),
    ])
  })

  it('uses a currency fallback name when the bank account has none', async () => {
    const supabase = makeSupabase([])

    await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'EUR' })

    const [, , , mappings] = mockSyncMappedAccounts.mock.calls[0]
    expect(mappings[0].sourceName).toBe('Bankkonto EUR')
  })

  it('returns null when the chart sync fails — a slot that cannot be booked against is useless', async () => {
    mockSyncMappedAccounts.mockResolvedValue({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: 'chart unavailable',
    })
    const supabase = makeSupabase([])

    expect(
      await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'SEK' }),
    ).toBeNull()
  })

  it('returns null when no slot is free', async () => {
    const rows: CashRow[] = [{ ledger_account: '1930', bank_connection_id: 'conn-1' }]
    for (let n = 1931; n <= 1959; n++) {
      rows.push({ ledger_account: String(n), bank_connection_id: 'conn-1' })
    }
    const supabase = makeSupabase(rows)

    expect(
      await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'SEK' }),
    ).toBeNull()
    expect(mockSyncMappedAccounts).not.toHaveBeenCalled()
  })
})
