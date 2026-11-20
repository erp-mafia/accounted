import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  deriveSkattekontoAccountFromBooks,
  ensureSkattekontoAccountDerived,
  isSkattekontoLedgerAccount,
  resolveSkattekontoAccount,
  skattekontoAccountChoices,
  skattekontoAccountFor,
} from '../skattekonto-account'

const COMPANY = 'company-1'

beforeEach(() => vi.clearAllMocks())

describe('the accounts a form may run its skattekonto on', () => {
  it('lets an enskild firma choose 2012, every other form only 1630', () => {
    expect(skattekontoAccountChoices('enskild_firma')).toEqual(['1630', '2012'])
    expect(skattekontoAccountChoices('aktiebolag')).toEqual(['1630'])
    expect(skattekontoAccountChoices('ekonomisk_forening')).toEqual(['1630'])
    expect(skattekontoAccountChoices('ideell_forening')).toEqual(['1630'])
  })

  it('honours a stored 2012 only for an enskild firma (the TS mirror of company_skattekonto_account)', () => {
    expect(skattekontoAccountFor('enskild_firma', '2012')).toBe('2012')
    expect(skattekontoAccountFor('enskild_firma', null)).toBe('1630')
    expect(skattekontoAccountFor('enskild_firma', '1930')).toBe('1630')
    expect(skattekontoAccountFor('aktiebolag', '2012')).toBe('1630')
    expect(isSkattekontoLedgerAccount('2012')).toBe(true)
    expect(isSkattekontoLedgerAccount(2012)).toBe(false)
  })
})

describe('resolveSkattekontoAccount', () => {
  it('asks the one SQL resolver', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: '2012' })
    expect(await resolveSkattekontoAccount(supabase as never, COMPANY)).toBe('2012')
    expect(supabase.rpc).toHaveBeenCalledWith('company_skattekonto_account', { p_company_id: COMPANY })
  })

  it('reads 1630 for anything the function does not answer with a known account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await resolveSkattekontoAccount(supabase as never, COMPANY)).toBe('1630')
  })

  it('reads 1630 while the migration has not run yet (unknown function)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { code: 'PGRST202', message: 'Could not find the function' } })
    expect(await resolveSkattekontoAccount(supabase as never, COMPANY)).toBe('1630')
  })

  it('throws on any other failure: guessing 1630 for a firm on 2012 would book on the wrong account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    await expect(resolveSkattekontoAccount(supabase as never, COMPANY)).rejects.toThrow(/skattekontots konto/)
  })
})

describe('deriveSkattekontoAccountFromBooks', () => {
  it('passes the books evidence through, null without any', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: '2012' })
    enqueue({ data: null })
    expect(await deriveSkattekontoAccountFromBooks(supabase as never, COMPANY)).toBe('2012')
    expect(await deriveSkattekontoAccountFromBooks(supabase as never, COMPANY)).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('derive_skattekonto_account', { p_company_id: COMPANY })
  })
})

describe('ensureSkattekontoAccountDerived', () => {
  it('stores 2012 once for an unset enskild firma whose books run 2012, guarded on the column still being unset', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    enqueue({ data: '2012' }) // derive
    enqueue({ data: null }) // update
    enqueue({ data: '2012' }) // resolve
    expect(await ensureSkattekontoAccountDerived(supabase as never, COMPANY)).toBe('2012')
    expect(findCalls('company_settings', 'update')).toEqual([[{ skattekonto_account: '2012' }]])
    expect(findCalls('company_settings', 'is')).toContainEqual(['skattekonto_account', null])
  })

  it('stores what the books say only when they say something', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    enqueue({ data: null }) // derive: no lines on either account
    enqueue({ data: '1630' }) // resolve
    expect(await ensureSkattekontoAccountDerived(supabase as never, COMPANY)).toBe('1630')
    expect(findCalls('company_settings', 'update')).toEqual([])
  })

  it('never changes a stored choice, and never derives for an aktiebolag', async () => {
    for (const settings of [
      { entity_type: 'enskild_firma', skattekonto_account: '1630' },
      { entity_type: 'aktiebolag', skattekonto_account: null },
    ]) {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: settings })
      enqueue({ data: '1630' }) // resolve
      expect(await ensureSkattekontoAccountDerived(supabase as never, COMPANY)).toBe('1630')
      expect(findCalls('company_settings', 'update')).toEqual([])
      expect(supabase.rpc).not.toHaveBeenCalledWith('derive_skattekonto_account', expect.anything())
      vi.clearAllMocks()
    }
  })

  it('never throws: a failed write is reported and the company resolves as it is', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const onError = vi.fn()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    enqueue({ data: '2012' })
    enqueue({ error: { message: 'Archived migration reset source records are immutable' } })
    enqueue({ data: '1630' })
    expect(await ensureSkattekontoAccountDerived(supabase as never, COMPANY, onError)).toBe('1630')
    expect(onError).toHaveBeenCalledTimes(1)

    const failing = createQueuedMockSupabase()
    failing.enqueue({ error: { message: 'down' } })
    failing.enqueue({ error: { code: '57014', message: 'timeout' } })
    expect(await ensureSkattekontoAccountDerived(failing.supabase as never, COMPANY, onError)).toBeUndefined()
  })
})
