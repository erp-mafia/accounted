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
  describeCashAccountSiblings,
  findPairableCashAccountByIban,
  guardCounterLegs,
  guardBookedCounterLines,
  loadCounterLegTopology,
  shouldRepointToSibling,
} from '../service'

const IBAN = 'SE4550000000058398257466'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ca-1',
    ledger_account: '1930',
    bank_connection_id: 'conn-live',
    external_uid: 'uid-1',
    iban: IBAN,
    enabled: true,
    is_primary: false,
    currency: 'SEK',
    ...overrides,
  }
}

describe('getOrphanedCounterLedgers', () => {
  it('flags a revoked-held twin of an actively connected row', async () => {
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

  it('does NOT flag a revoked-held row without a live twin (a disconnected but real account, #1643 round 3)', async () => {
    // Prod shape: the company's only 1930 on a bank-side revoked connection
    // (never demoted), or two distinct real accounts on one revoked
    // connection. Both are accounts the user still tracks, not junk.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930', bank_connection_id: 'conn-old' }),
        row({ id: 'ca-1940', ledger_account: '1940', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-old', status: 'revoked' }] })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.size).toBe(0)
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

  it('flags an expired-connection twin of an actively connected row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-expired', ledger_account: '1931', bank_connection_id: 'conn-expired' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-expired', status: 'expired' },
      ],
    })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.has('1931')).toBe(true)
    expect(orphaned.has('1940')).toBe(false)
  })

  it('does NOT flag a lone expired connection (re-auth window)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-expired', ledger_account: '1930', bank_connection_id: 'conn-expired' })] })
    enqueue({ data: [{ id: 'conn-expired', status: 'expired' }] })

    const orphaned = await getOrphanedCounterLedgers(supabase as never, 'company-1')
    expect(orphaned.size).toBe(0)
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

  it('does NOT flag another-currency pocket of a live row that shares its IBAN (Wise/Revolut reconnect)', async () => {
    // Two pockets on one IBAN were demoted by a disconnect; the reconnect
    // picked only the SEK pocket, so 1935 is live and the GBP pocket 1937 is
    // still a manual row carrying the same IBAN. It is a distinct account.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-gbp', ledger_account: '1937', currency: 'GBP', bank_connection_id: null }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

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
  it('returns the same-currency sibling rows with id, ledger, currency and liveness so a link can re-point at one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940', iban: 'SE45 5000 0000 0583 9825 7466', bank_connection_id: 'conn-live' }),
        // Same IBAN, other currency: a pocket of a multi-currency account, not a sibling.
        row({ id: 'ca-eur', ledger_account: '1932', currency: 'EUR', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-other', ledger_account: '1935', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const siblings = await listSiblingCashAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual([{ id: 'ca-live', ledger_account: '1940', currency: 'SEK', live: true, released: false }])
  })

  it('returns [] on a lookup failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    const siblings = await listSiblingCashAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual([])
  })
})

describe('same-connection re-registration twins (#1643, deliberately out of scope)', () => {
  it('keeps two enabled rows on ONE active connection sharing IBAN+currency BOTH live: neither is orphaned and a transfer to that IBAN pairs with nothing', async () => {
    // The bank re-registered the account under a new external_uid, so two
    // enabled rows sit on the same active connection. No liveness signal
    // has held up on prod (balance_updated_at, accounts_data uid presence),
    // so the rows are not ranked: both stay live until the founder decides
    // how to model the shape.
    const twins = () => [
      row({ id: 'ca-old', ledger_account: '1930', external_uid: 'uid-old' }),
      row({ id: 'ca-new', ledger_account: '1931', external_uid: 'uid-new' }),
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: twins() })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    expect((await getOrphanedCounterLedgers(supabase as never, 'company-1')).size).toBe(0)

    const again = createQueuedMockSupabase()
    again.enqueue({
      data: [...twins(), row({ id: 'ca-savings', ledger_account: '1940', external_uid: 'uid-savings', iban: 'SE1112223334445556667778' })],
    })
    again.enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    const paired = await findPairableCashAccountByIban(again.supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-savings',
    })
    expect(paired).toBeNull()
  })
})

describe('describeCashAccountSiblings', () => {
  it('never lists a disabled row as a sibling (not a re-point destination, round 5)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-released', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-disabled', ledger_account: '1930', enabled: false, bank_connection_id: null }),
      ],
    })
    const described = await describeCashAccountSiblings(supabase as never, 'company-1', 'ca-released')
    expect(described?.siblings).toEqual([])
  })

  it('reports the own row as not live when its connection is revoked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-old', status: 'revoked' },
        { id: 'conn-live', status: 'active' },
      ],
    })

    const described = await describeCashAccountSiblings(supabase as never, 'company-1', 'ca-orphan')
    expect(described?.own).toEqual({ id: 'ca-orphan', ledger_account: '1931', currency: 'SEK', live: false, released: true })
    expect(described?.siblings).toEqual([{ id: 'ca-live', ledger_account: '1940', currency: 'SEK', live: true, released: false }])
  })

  it('reports an expired-connection row as neither live nor released (re-auth renews it in place)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-expired', ledger_account: '1930', bank_connection_id: 'conn-expired' }),
        row({ id: 'ca-manual', ledger_account: '1931', bank_connection_id: null }),
      ],
    })
    enqueue({ data: [{ id: 'conn-expired', status: 'expired' }] })

    const described = await describeCashAccountSiblings(supabase as never, 'company-1', 'ca-expired')
    expect(described?.own).toEqual({ id: 'ca-expired', ledger_account: '1930', currency: 'SEK', live: false, released: false })
    expect(described?.siblings).toEqual([{ id: 'ca-manual', ledger_account: '1931', currency: 'SEK', live: false, released: true }])
  })
})

describe('shouldRepointToSibling', () => {
  const sib = (overrides: Partial<{ id: string; live: boolean; released: boolean }> = {}) => ({
    id: 'ca-sib',
    ledger_account: '1931',
    currency: 'SEK',
    live: false,
    released: true,
    ...overrides,
  })
  const own = (overrides: Partial<{ live: boolean; released: boolean }> = {}) => ({
    id: 'ca-own',
    ledger_account: '1930',
    currency: 'SEK',
    live: false,
    released: false,
    ...overrides,
  })

  it('always moves onto a live sibling', () => {
    const sibling = sib({ live: true, released: false })
    expect(shouldRepointToSibling({ own: own({ live: true }), siblings: [sibling] }, sibling)).toBe(true)
  })

  it('moves onto a dead sibling only when the own holder is gone and no sibling is live', () => {
    const dead = sib()
    expect(shouldRepointToSibling({ own: own({ released: true }), siblings: [dead] }, dead)).toBe(true)
    const live = sib({ id: 'ca-live', live: true, released: false })
    expect(shouldRepointToSibling({ own: own({ released: true }), siblings: [dead, live] }, dead)).toBe(false)
  })

  it('never moves an expired/error/pending own row (not live, not released) onto a dead sibling', () => {
    const dead = sib()
    expect(shouldRepointToSibling({ own: own(), siblings: [dead] }, dead)).toBe(false)
  })

  it('never moves a live own row onto a dead sibling', () => {
    const dead = sib()
    expect(shouldRepointToSibling({ own: own({ live: true }), siblings: [dead] }, dead)).toBe(false)
  })
})

describe('listSiblingLedgerAccounts', () => {
  it('returns the other ledgers sharing the row\'s IBAN, normalized', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        // Own row: orphan on 1931 with a spaced IBAN variant.
        row({ id: 'ca-orphan', ledger_account: '1931', iban: 'SE45 5000 0000 0583 9825 7466', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-other', ledger_account: '1935', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const siblings = await listSiblingLedgerAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual(['1940'])
  })

  it('returns [] for a row without an IBAN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-kassa', ledger_account: '1910', iban: null, bank_connection_id: null })] })
    const siblings = await listSiblingLedgerAccounts(supabase as never, 'company-1', 'ca-kassa')
    expect(siblings).toEqual([])
  })

  it('returns [] when the row cannot be found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
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

  it('drops a demoted-to-manual twin of the live row (same orphan definition as the commit guard)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-new' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-new', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account?.id).toBe('ca-live')
  })

  it('drops an expired-connection twin of the live row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-expired', ledger_account: '1931', bank_connection_id: 'conn-expired' }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-new' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-expired', status: 'expired' },
        { id: 'conn-new', status: 'active' },
      ],
    })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account?.id).toBe('ca-live')
  })

  it('still pairs with a lone expired connection (re-auth window: it is still the real account)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-expired', ledger_account: '1940', bank_connection_id: 'conn-expired' })] })
    enqueue({ data: [{ id: 'conn-expired', status: 'expired' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account?.id).toBe('ca-expired')
  })

  it('still pairs with a revoked-held row that has no live twin (bank switch: closing balance moved into the disconnected account, #1643 round 3)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-new', ledger_account: '1940', bank_connection_id: 'conn-live', iban: 'SE1112223334445556667778' }),
        row({ id: 'ca-old', ledger_account: '1930', bank_connection_id: 'conn-old', iban: IBAN }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    const found = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-new',
    })
    expect(found?.ledger_account).toBe('1930')
  })

  it('excludes the requested cash account id (self)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-own', ledger_account: '1931' })] })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-own',
    })
    expect(account).toBeNull()
  })

  it('returns null for the own IBAN when two ACTIVE same-currency rows share it (the same physical account)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Both rows enabled, both on the same active connection: the shape a
    // duplicate reconnect row leaves behind. Neither is a transfer target for
    // a transaction on the other.
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930' }),
        row({ id: 'ca-1931', ledger_account: '1931' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-1930',
    })
    expect(account).toBeNull()
  })

  it('returns null for the own IBAN when the twin is the live row and the own row is a demoted orphan', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-orphan',
    })
    expect(account).toBeNull()
  })

  it('pairs an own-IBAN counterparty with the single other-currency pocket of a multi-currency account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK' }),
        row({ id: 'ca-gbp', ledger_account: '1937', currency: 'GBP' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-sek',
    })
    expect(account?.id).toBe('ca-gbp')
  })

  it('returns null when several candidates in different currencies survive (no discriminator to pick a pocket)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1931', currency: 'SEK' }),
        row({ id: 'ca-eur', ledger_account: '1932', currency: 'EUR' }),
        row({ id: 'ca-usd', ledger_account: '1933', currency: 'USD' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-sek',
    })
    expect(account).toBeNull()
  })

  it('returns null when only disabled rows carry the IBAN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row({ id: 'ca-disabled', enabled: false })] })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    const account = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN)
    expect(account).toBeNull()
  })
})

describe('guardCounterLegs', () => {
  const mapping = (debit: string, credit: string) => ({
    rule: null,
    debit_account: debit,
    credit_account: credit,
    risk_level: 'LOW' as const,
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'test',
  })

  it('does not touch the database when no non-settlement 19xx leg is present', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('5010', '1940'), '1940', 'ca-live')
    expect(result.refusedLedger).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rewrites a learned BANK leg on a twin ledger to the settlement account instead of refusing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Template learned as 5010 / 1931 while the account sat on 1931; the
    // transaction now settles on the live 1940 row of the same IBAN.
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('5010', '1931'), '1940', 'ca-live')
    expect(result.refusedLedger).toBeNull()
    expect(result.mappingResult.debit_account).toBe('5010')
    expect(result.mappingResult.credit_account).toBe('1940')
  })

  it('refuses a twin of the settlement account as counter even when both rows are active', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930' }),
        row({ id: 'ca-1931', ledger_account: '1931' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    // Interest proposed as a "transfer" 1930 / 1931: both legs are the same
    // physical account, nothing reaches the P&L.
    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1930', '1931'), '1930', 'ca-1930')
    expect(result.refusedLedger).toBe('1931')
  })

  it('refuses a transfer to the live twin from a transaction stranded on the orphan row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1940', '1931'), '1931', 'ca-orphan')
    expect(result.refusedLedger).toBe('1940')
  })

  it('leaves another-currency pocket of the same IBAN alone (a real FX pocket transfer)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK' }),
        row({ id: 'ca-gbp', ledger_account: '1937', currency: 'GBP' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1937', '1935'), '1935', 'ca-sek')
    expect(result.refusedLedger).toBeNull()
    expect(result.mappingResult.debit_account).toBe('1937')
  })

  it('refuses a revoked-held twin of a live row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
        row({ id: 'ca-savings', ledger_account: '1930', bank_connection_id: 'conn-live', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1931', '1930'), '1930', 'ca-savings')
    expect(result.refusedLedger).toBe('1931')
  })

  it('accepts a revoked-held row without a live twin as counter (two real accounts on one disconnected bank, #1643 round 3)', async () => {
    // Company shape from prod: 1930 and 1940 (different IBANs) both on one
    // revoked connection; a 1940 -> 1930 transfer must still book.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930', bank_connection_id: 'conn-old' }),
        row({ id: 'ca-1940', ledger_account: '1940', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-old', status: 'revoked' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1930', '1940'), '1940', 'ca-1940')
    expect(result.refusedLedger).toBeNull()
    expect(result.mappingResult.debit_account).toBe('1930')
  })
})

describe('loadCounterLegTopology (suggest-categories batch)', () => {
  const fixture = () => [
    row({ id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live', currency: 'SEK' }),
    // Demoted same-IBAN same-currency twin: orphaned, and a twin of ca-live.
    row({ id: 'ca-twin', ledger_account: '1931', bank_connection_id: null, currency: 'SEK' }),
    // Same IBAN, other currency: a real pocket, neither orphaned nor a twin.
    row({ id: 'ca-gbp', ledger_account: '1937', bank_connection_id: null, currency: 'GBP' }),
    // Revoked-held, no twin: a real disconnected account.
    row({ id: 'ca-old', ledger_account: '1930', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
  ]
  const statuses = () => [
    { id: 'conn-live', status: 'active' },
    { id: 'conn-old', status: 'revoked' },
  ]
  const mapping = (debit: string, credit: string) => ({
    rule: null,
    debit_account: debit,
    credit_account: credit,
    risk_level: 'LOW' as const,
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'test',
  })

  it('derives the settlement ledger and the same-currency twins of a row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: fixture() })
    enqueue({ data: statuses() })

    const topology = await loadCounterLegTopology(supabase as never, 'company-1')
    expect(topology).not.toBeNull()
    const context = topology!.contextFor('ca-live')
    expect(context.settlementLedger).toBe('1940')
    expect([...context.twins]).toEqual(['1931'])
  })

  it('gives an other-currency pocket no twins, and null/unknown ids no settlement ledger', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: fixture() })
    enqueue({ data: statuses() })

    const topology = await loadCounterLegTopology(supabase as never, 'company-1')
    expect(topology!.contextFor('ca-gbp')).toEqual({ settlementLedger: '1937', twins: new Set() })
    expect(topology!.contextFor(null)).toEqual({ settlementLedger: null, twins: new Set() })
    expect(topology!.contextFor(undefined)).toEqual({ settlementLedger: null, twins: new Set() })
    expect(topology!.contextFor('ca-unknown')).toEqual({ settlementLedger: null, twins: new Set() })
  })

  it('caches the per-row context and never re-queries', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: fixture() })
    enqueue({ data: statuses() })

    const topology = await loadCounterLegTopology(supabase as never, 'company-1')
    const first = topology!.contextFor('ca-live')
    expect(topology!.contextFor('ca-live')).toBe(first)
    expect(findCalls('cash_accounts', 'select')).toHaveLength(1)
    expect(findCalls('bank_connections', 'select')).toHaveLength(1)
  })

  it('exposes the same orphan set the commit guard refuses on the same fixture', async () => {
    const batch = createQueuedMockSupabase()
    batch.enqueue({ data: fixture() })
    batch.enqueue({ data: statuses() })
    const topology = await loadCounterLegTopology(batch.supabase as never, 'company-1')
    expect([...topology!.orphaned]).toEqual(['1931'])

    // guardCounterLegs on the same fixture: the twin is refused as counter,
    // the GBP pocket and the revoked-held 1930 are accepted.
    for (const [counter, expected] of [['1931', '1931'], ['1937', null], ['1930', null]] as const) {
      const commit = createQueuedMockSupabase()
      commit.enqueue({ data: fixture() })
      commit.enqueue({ data: statuses() })
      const result = await guardCounterLegs(commit.supabase as never, 'company-1', mapping(counter, '1940'), '1940', 'ca-live')
      expect(result.refusedLedger).toBe(expected)
    }
  })

  it('returns null when the row lookup fails (nothing withheld)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await loadCounterLegTopology(supabase as never, 'company-1')).toBeNull()
  })
})

describe('#1643 round 2: same-IBAN other-currency pocket beside a live pocket', () => {
  const mapping = (debit: string, credit: string) => ({
    rule: null,
    debit_account: debit,
    credit_account: credit,
    risk_level: 'LOW' as const,
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'test',
  })
  const pockets = () => [
    row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK', bank_connection_id: 'conn-live' }),
    row({ id: 'ca-gbp', ledger_account: '1937', currency: 'GBP', bank_connection_id: null }),
  ]

  it('guardCounterLegs accepts the manual GBP pocket as counter of a SEK->GBP conversion', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: pockets() })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1937', '1935'), '1935', 'ca-sek')
    expect(result.refusedLedger).toBeNull()
    expect(result.mappingResult.debit_account).toBe('1937')
  })

  it('findPairableCashAccountByIban still proposes the manual GBP pocket', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: pockets() })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const found = await findPairableCashAccountByIban(supabase as never, 'company-1', IBAN, {
      excludeCashAccountId: 'ca-sek',
    })
    expect(found?.ledger_account).toBe('1937')
  })
})

describe('guardBookedCounterLines (POST /book)', () => {
  it('refuses a 19xx line that is an active twin of the transaction\'s own row', async () => {
    // The issue's dialog shape: 1930 and 1931 both enabled on one active
    // connection, a learned template pre-fills 1930 debit / 1931 credit.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930' }),
        row({ id: 'ca-1931', ledger_account: '1931' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    const refused = await guardBookedCounterLines(supabase as never, 'company-1', ['1930', '1931'], 'ca-1930')
    expect(refused.refusedLedger).toBe('1931')
  })

  it('refuses a 19xx line on a revoked-held twin of the transaction\'s own row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    const refused = await guardBookedCounterLines(supabase as never, 'company-1', ['1931', '1940'], 'ca-live')
    expect(refused.refusedLedger).toBe('1931')
  })

  it('accepts a transfer to a revoked-held account without a live twin (#1643 round 3)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940' }),
        row({ id: 'ca-old', ledger_account: '1930', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1930', '1940'], 'ca-live')).toEqual({ refusedLedger: null, repointCashAccountId: null })
  })

  it('accepts another-currency pocket of the same IBAN and a real transfer to another account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK' }),
        row({ id: 'ca-gbp', ledger_account: '1937', currency: 'GBP', bank_connection_id: null }),
        row({ id: 'ca-savings', ledger_account: '1940', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1935', '1937'], 'ca-sek')).toEqual({ refusedLedger: null, repointCashAccountId: null })

    const again = createQueuedMockSupabase()
    again.enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK' }),
        row({ id: 'ca-savings', ledger_account: '1940', iban: 'SE1112223334445556667778' }),
      ],
    })
    again.enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    expect(await guardBookedCounterLines(again.supabase as never, 'company-1', ['1935', '1940'], 'ca-sek')).toEqual({ refusedLedger: null, repointCashAccountId: null })
  })

  it('only reads the own row for an ordinary booking whose single bank line is the own ledger', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['6200', '2640', '1930'], 'ca-1930')).toEqual({ refusedLedger: null, repointCashAccountId: null })
    expect(findCalls('cash_accounts', 'select')).toEqual([['ledger_account']])
    expect(findCalls('bank_connections', 'select')).toHaveLength(0)
  })

  it('does not look anything up when the transaction has no cash_accounts row', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['6200', '2640', '1930'], null)).toEqual({ refusedLedger: null, repointCashAccountId: null })
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('re-points a stranded row when its single bank line is the live sibling ledger (#1643 round 4)', async () => {
    // The #1643 prod shape: the transaction sits on the demoted 1931, the
    // user types the bank leg on the live 1940 (where the money is) against
    // a P&L account. The booking posts on 1940 and the row moves there.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1931' } })
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-live', ledger_account: '1940' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })

    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1940', '8311'], 'ca-orphan')).toEqual({
      refusedLedger: null,
      repointCashAccountId: 'ca-live',
    })
  })

  it('refuses a single bank line on a dead twin instead of stranding the bank leg there (#1643 round 5)', async () => {
    // Live 1940 row, dialog pre-filled the bank leg on the revoked 1931 twin
    // from a template learned before the reconnect (problem 4): posting it
    // would put the only bank leg on a ledger no connection feeds while the
    // transaction stays on 1940. Refused, as manualLink refuses the same
    // voucher.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1940' } })
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1931', '8311'], 'ca-live')).toEqual({
      refusedLedger: '1931',
      repointCashAccountId: null,
    })
  })

  it('refuses a single bank line on a disabled twin even when the own row is released (never moves onto a deselected row, round 5)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1931' } })
    enqueue({
      data: [
        row({ id: 'ca-released', ledger_account: '1931', bank_connection_id: null }),
        row({ id: 'ca-disabled', ledger_account: '1930', enabled: false, bank_connection_id: null }),
      ],
    })
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1930', '8311'], 'ca-released')).toEqual({
      refusedLedger: '1930',
      repointCashAccountId: null,
    })
  })

  it('posts as typed when the single bank line is an unrelated ledger (a transfer to another account)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({
      data: [
        row({ id: 'ca-1930', ledger_account: '1930' }),
        row({ id: 'ca-savings', ledger_account: '1940', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1940', '8311'], 'ca-1930')).toEqual({
      refusedLedger: null,
      repointCashAccountId: null,
    })
  })
})
