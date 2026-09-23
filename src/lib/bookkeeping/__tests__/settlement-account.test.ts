import { describe, it, expect, vi } from 'vitest'
import { createMockSupabase, createQueuedMockSupabase } from '@/tests/helpers'
import { resolveSettlementAccount } from '../settlement-account'
import { BookkeepingDatabaseError } from '../errors'

const noopLog = { warn: vi.fn() } as unknown as import('@/lib/logger').Logger

describe('resolveSettlementAccount', () => {
  describe('no cash_account_id: single-enabled-account currency fallback (#1722)', () => {
    it('resolves the single enabled account for the currency instead of 1930', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: '1920' }], error: null })

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog)

      expect(result).toBe('1920')
      expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
      // The candidate listing must be narrowed to enabled accounts in the
      // transaction's currency (SEK by default), mirroring the client-side
      // resolveAccount semantics.
      const eqArgs = findCalls('cash_accounts', 'eq')
      expect(eqArgs).toContainEqual(['company_id', 'company-1'])
      expect(eqArgs).toContainEqual(['enabled', true])
      expect(eqArgs).toContainEqual(['currency', 'SEK'])
    })

    it('filters candidates by the currency argument', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: '1939' }], error: null })

      const result = await resolveSettlementAccount(
        supabase as never,
        'company-1',
        null,
        noopLog,
        'EUR',
      )

      expect(result).toBe('1939')
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['currency', 'EUR'])
    })

    it('keeps the 1930 fallback when the company has no enabled account in the currency', async () => {
      // A SEK transaction in a company whose only enabled cash account is EUR:
      // the currency-narrowed listing comes back empty.
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [], error: null })

      const result = await resolveSettlementAccount(
        supabase as never,
        'company-1',
        null,
        noopLog,
        'SEK',
      )

      expect(result).toBe('1930')
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['currency', 'SEK'])
    })

    it('keeps the 1930 fallback when several enabled accounts share the currency', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: [{ ledger_account: '1920' }, { ledger_account: '1930' }],
        error: null,
      })

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog)

      expect(result).toBe('1930')
    })

    it('warns and keeps the 1930 fallback when the candidate lookup errors', async () => {
      // Unlike the explicit-cashAccountId branch (#842), this branch never
      // queried before, so an infra error degrades to the historical fallback
      // instead of failing the request.
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: { message: 'boom' } })
      const warn = vi.fn()

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, {
        warn,
      } as unknown as import('@/lib/logger').Logger)

      expect(result).toBe('1930')
      expect(warn).toHaveBeenCalledWith(
        'settlement-account currency fallback lookup failed; defaulting to 1930',
        expect.objectContaining({ companyId: 'company-1', currency: 'SEK' }),
      )
    })

    it('warns and keeps the 1930 fallback when the single row has no ledger_account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: null }], error: null })
      const warn = vi.fn()

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, {
        warn,
      } as unknown as import('@/lib/logger').Logger)

      expect(result).toBe('1930')
      expect(warn).toHaveBeenCalledWith(
        'settlement-account currency fallback row has no ledger_account; defaulting to 1930',
        expect.objectContaining({ companyId: 'company-1', currency: 'SEK' }),
      )
    })
  })

  it('returns the linked cash account ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: '1940' }, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog)

    expect(result).toBe('1940')
    expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
  })

  it('throws a BookkeepingDatabaseError instead of silently falling back when the lookup errors', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: { message: 'boom' } })

    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toMatchObject({
      operation: 'resolve_settlement_account',
      message: expect.stringContaining('boom'),
    })
  })

  it('falls back to 1930 when cash_account_id does not match any row', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-unknown', noopLog)

    expect(result).toBe('1930')
  })

  it('falls back to 1930 and warns when the row has no ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: null }, error: null })
    const warn = vi.fn()

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', {
      warn,
    } as unknown as import('@/lib/logger').Logger)

    expect(result).toBe('1930')
    expect(warn).toHaveBeenCalledWith(
      'settlement-account lookup returned no ledger_account; defaulting to 1930',
      expect.objectContaining({ cashAccountId: 'ca-1' }),
    )
  })
})
