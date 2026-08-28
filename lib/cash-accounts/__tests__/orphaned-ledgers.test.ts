/**
 * Issue #1643: helpers that keep orphaned cash_accounts rows (leftovers of a
 * broken bank reconnect) out of counter-account proposals, and that let a
 * transaction stranded on an orphan match/link against the live ledger of the
 * same physical account (identified by IBAN).
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  getOrphanedCounterLedgers,
  findOrphanedCounterLedger,
  listSiblingCashAccounts,
  listSiblingLedgerAccounts,
  findPairableCashAccountByIban,
} from '../service'

const IBAN = 'SE4550000000058398257466'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ca-1',
    ledger_account: '1930',
    bank_connection_id: 'conn-live',
    iban: IBAN,
    enabled: true,
    is_primary: false,
    currency: 'SEK',
    ...overrides,
  }
}

describe('getOrphanedCounterLedgers', () => {
  it('flags rows held by a revoked connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.has('1931')).toBe(true)
    expect(orphaned.has('1940')).toBe(false)
  })

  it('flags a demoted-to-manual twin whose IBAN belongs to an actively connected row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        // Demoted by upsertFromPsd2: connection released, IBAN kept.
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.has('1931')).toBe(true)
  })

  it('does NOT flag a manual account without a live IBAN twin', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1930', bank_connection_id: 'conn-live', iban: IBAN }),
        // A genuinely manual account (CSV-imported savings, own IBAN): legit.
        row({ id: 'ca-manual', ledger_account: '1940', bank_connection_id: null, iban: 'SE1112223334445556667778' }),
        row({ id: 'ca-kassa', ledger_account: '1910', bank_connection_id: null, iban: null }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.size).toBe(0)
  })

  it('returns an empty set on lookup failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.size).toBe(0)
  })
})

describe('findOrphanedCounterLedger', () => {
  it('returns the first non-settlement 19xx account in the orphaned set', () => {
    expect(
      findOrphanedCounterLedger(['1940', '1931'], '1940', new Set(['1931'])),
    ).toBe('1931')
  })

  it('exempts the settlement account itself', () => {
    // A transaction stranded on the orphan still settles there: only the
    // COUNTER position is forbidden.
    expect(
      findOrphanedCounterLedger(['1931', '8311'], '1931', new Set(['1931'])),
    ).toBeNull()
  })

  it('ignores non-cash accounts and clean cash accounts', () => {
    expect(
      findOrphanedCounterLedger(['3001', '2611', '1940'], '1930', new Set(['1931'])),
    ).toBeNull()
  })
})

describe('listSiblingCashAccounts', () => {
  it('returns the sibling rows with id, ledger and currency so a link can re-point at one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ca-orphan', iban: IBAN, ledger_account: '1931' } })
    enqueue({
      data: [
        { id: 'ca-orphan', iban: IBAN, ledger_account: '1931', currency: 'SEK' },
        { id: 'ca-live', iban: 'SE45 5000 0000 0583 9825 7466', ledger_account: '1940', currency: 'SEK' },
        { id: 'ca-other', iban: 'SE1112223334445556667778', ledger_account: '1935', currency: 'SEK' },
      ],
    })

    const siblings = await listSiblingCashAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual([{ id: 'ca-live', ledger_account: '1940', currency: 'SEK' }])
  })

  it('returns [] on a sibling lookup failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ca-orphan', iban: IBAN, ledger_account: '1931' } })
    enqueue({ data: null, error: { message: 'boom' } })

    const siblings = await listSiblingCashAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual([])
  })
})

describe('listSiblingLedgerAccounts', () => {
  it('returns the other ledgers sharing the row\'s IBAN, normalized', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Own row: orphan on 1931 with a spaced IBAN variant.
    enqueue({ data: { id: 'ca-orphan', iban: 'SE45 5000 0000 0583 9825 7466', ledger_account: '1931' } })
    enqueue({
      data: [
        { id: 'ca-orphan', iban: 'SE45 5000 0000 0583 9825 7466', ledger_account: '1931' },
        { id: 'ca-live', iban: IBAN, ledger_account: '1940' },
        { id: 'ca-other', iban: 'SE1112223334445556667778', ledger_account: '1935' },
      ],
    })

    const siblings = await listSiblingLedgerAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual(['1940'])
  })

  it('returns [] for a row without an IBAN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ca-kassa', iban: null, ledger_account: '1910' } })
    const siblings = await listSiblingLedgerAccounts(supabase as never, 'company-1', 'ca-kassa')
    expect(siblings).toEqual([])
  })

  it('returns [] when the row cannot be found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const siblings = await listSiblingLedgerAccounts(supabase as never, 'company-1', 'missing')
    expect(siblings).toEqual([])
  })
})

describe('findPairableCashAccountByIban', () => {
  it('prefers the actively connected row and drops orphans', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-new' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-old', status: 'revoked' },
        { id: 'conn-new', status: 'active' },
      ],
    })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account?.id).toBe('ca-live')
  })

  it('excludes the requested cash account id (self)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-own', ledger_account: '1931' })] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-own',
    })
    expect(account).toBeNull()
  })

  it('returns null when only disabled rows carry the IBAN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-disabled', enabled: false })] })
    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account).toBeNull()
  })
})
