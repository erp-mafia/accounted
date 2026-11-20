import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { physicalAccountKey, sameCashAccount } from '../service'
import { readPhysicalKeys, supersededTwins } from '../twins'

const IBAN = 'SE4550000000058398257466'

describe('physicalAccountKey', () => {
  it('reads one account however a bank spells it', () => {
    const key = physicalAccountKey({ iban: IBAN, currency: 'SEK' })
    expect(physicalAccountKey({ iban: 'SE45 5000 0000 0583 9825 7466', currency: 'SEK' })).toBe(key)
    expect(physicalAccountKey({ iban: 'se4550000000058398257466', currency: 'sek' })).toBe(key)
  })

  it('a bank that names no currency means SEK, the column default', () => {
    const key = physicalAccountKey({ iban: IBAN, currency: 'SEK' })
    expect(physicalAccountKey({ iban: IBAN, currency: null })).toBe(key)
    expect(physicalAccountKey({ iban: IBAN, currency: '' })).toBe(key)
    expect(physicalAccountKey({ iban: IBAN })).toBe(key)
  })

  it('another currency on one IBAN is another account', () => {
    expect(physicalAccountKey({ iban: IBAN, currency: 'EUR' })).not.toBe(physicalAccountKey({ iban: IBAN, currency: 'SEK' }))
  })

  it('a row without an IBAN has no key', () => {
    expect(physicalAccountKey({ iban: null, currency: 'SEK' })).toBeNull()
    expect(physicalAccountKey({ iban: '   ', currency: 'SEK' })).toBeNull()
  })
})

describe('sameCashAccount', () => {
  const keys = new Map([['a', 'K'], ['b', 'K'], ['c', 'L']])

  it('a null side stays compatible, and a row is itself', () => {
    expect(sameCashAccount(null, 'a', keys)).toBe(true)
    expect(sameCashAccount('a', null, keys)).toBe(true)
    expect(sameCashAccount('x', 'x', keys)).toBe(true)
  })

  it('two rows are one account only on one key', () => {
    expect(sameCashAccount('a', 'b', keys)).toBe(true)
    expect(sameCashAccount('a', 'c', keys)).toBe(false)
  })

  it('a row without a key matches only itself', () => {
    expect(sameCashAccount('a', 'x', keys)).toBe(false)
    expect(sameCashAccount('x', 'y', keys)).toBe(false)
  })
})

describe('readPhysicalKeys', () => {
  it('reads nothing while the ids name one account', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect((await readPhysicalKeys(supabase as never, 'c', ['a', 'a', null])).size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('keys the rows with an IBAN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'a', iban: IBAN, currency: 'SEK' }, { id: 'b', iban: null, currency: 'SEK' }] })
    const keys = await readPhysicalKeys(supabase as never, 'c', ['a', 'b'])
    expect([...keys.keys()]).toEqual(['a'])
  })

  it('a failed read answers no keys: two rows read as two accounts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    expect((await readPhysicalKeys(supabase as never, 'c', ['a', 'b'])).size).toBe(0)
  })
})

describe('supersededTwins', () => {
  const row = (id: string, ledger: string, over: Record<string, unknown> = {}) => ({
    id, ledger_account: ledger, is_primary: false, created_at: `2026-01-0${id === 'a' ? 1 : 2}`, iban: IBAN, currency: 'SEK', ...over,
  })

  it('reads nothing without twins', async () => {
    const { supabase } = createQueuedMockSupabase()
    const twins = await supersededTwins(supabase as never, 'c', [row('a', '1930'), row('b', '1940', { iban: 'SE7280000810340009783242' })])
    expect(twins.size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('a row without an IBAN is no twin', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect((await supersededTwins(supabase as never, 'c', [row('a', '1930', { iban: null }), row('b', '1940', { iban: null })])).size).toBe(0)
  })
})
