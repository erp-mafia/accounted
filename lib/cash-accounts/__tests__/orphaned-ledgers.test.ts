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
    expect(siblings).toEqual([{ id: 'ca-live', ledger_account: '1940', currency: 'SEK', live: true }])
  })

  it('returns [] on a lookup failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    const siblings = await listSiblingCashAccounts(supabase as never, 'company-1', 'ca-orphan')
    expect(siblings).toEqual([])
  })
})

describe('describeCashAccountSiblings', () => {
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
    expect(described?.own).toEqual({ id: 'ca-orphan', ledger_account: '1931', currency: 'SEK', live: false })
    expect(described?.siblings).toEqual([{ id: 'ca-live', ledger_account: '1940', currency: 'SEK', live: true }])
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

  it('refuses an orphaned ledger held by a revoked connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({ data: [{ id: 'conn-old', status: 'revoked' }] })

    const result = await guardCounterLegs(supabase as never, 'company-1', mapping('1931', '1930'), '1930', null)
    expect(result.refusedLedger).toBe('1931')
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
    expect(refused).toBe('1931')
  })

  it('refuses a 19xx line on a ledger held by a revoked connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        row({ id: 'ca-live', ledger_account: '1940' }),
        row({ id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old', iban: 'SE1112223334445556667778' }),
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })

    const refused = await guardBookedCounterLines(supabase as never, 'company-1', ['1931', '1940'], 'ca-live')
    expect(refused).toBe('1931')
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

    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['1935', '1937'], 'ca-sek')).toBeNull()

    const again = createQueuedMockSupabase()
    again.enqueue({
      data: [
        row({ id: 'ca-sek', ledger_account: '1935', currency: 'SEK' }),
        row({ id: 'ca-savings', ledger_account: '1940', iban: 'SE1112223334445556667778' }),
      ],
    })
    again.enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    expect(await guardBookedCounterLines(again.supabase as never, 'company-1', ['1935', '1940'], 'ca-sek')).toBeNull()
  })

  it('does not look anything up for an ordinary booking with one bank line', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    expect(await guardBookedCounterLines(supabase as never, 'company-1', ['6200', '2640', '1930'], 'ca-1930')).toBeNull()
    expect(findCalls('cash_accounts')).toHaveLength(0)
  })
})
