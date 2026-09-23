import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  unclaimedAccountsFor,
  findReusableSessions,
  countLiveSiblings,
  fanOutSessionRenewal,
  remapAccountUids,
} from '../lib/session-sharing'
import type { StoredAccount } from '../types'

/**
 * Thenable query stub: PostgREST chains terminate on await, not on a fixed
 * method, so the same object has to answer .eq()/.neq()/.gt()/.in() and still
 * resolve when awaited. Mirrors the stub in lib/cash-accounts/__tests__.
 */
/** A recorded builder call: the method name and the arguments it got. */
type RecordedCall = [string, unknown[]]

interface ChainStub {
  calls: RecordedCall[]
  [key: string]: unknown
}

function chainable(result: Record<string, unknown>): ChainStub {
  const calls: RecordedCall[] = []
  const chain = { calls } as ChainStub
  for (const method of [
    'select', 'eq', 'neq', 'not', 'is', 'in', 'gt', 'order', 'limit', 'update', 'insert',
  ]) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args])
      return chain
    })
  }
  chain.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled)
  chain.maybeSingle = vi.fn(() => Promise.resolve(result))
  chain.single = vi.fn(() => Promise.resolve(result))
  return chain
}

type MockClient = SupabaseClient & { used: Record<string, ChainStub[]> }

/** Per-table result queues; each from(table) shifts the next result. */
function makeSupabase(queues: Record<string, Array<Record<string, unknown>>>): MockClient {
  const used: Record<string, ChainStub[]> = {}
  const client = {
    used,
    from: vi.fn((table: string) => {
      const queue = queues[table] ?? []
      const result = queue.shift() ?? { data: [], error: null }
      const chain = chainable(result)
      ;(used[table] ??= []).push(chain)
      return chain
    }),
  }
  return client as unknown as MockClient
}

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

function makeAccount(over: Partial<StoredAccount> = {}): StoredAccount {
  return { uid: 'uid-1', iban: 'SE1122334455667788990011', currency: 'SEK', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('unclaimedAccountsFor', () => {
  it('drops accounts whose IBAN a cash account already claims', () => {
    const accounts = [
      makeAccount({ uid: 'a', iban: 'SE1111111111111111111111' }),
      makeAccount({ uid: 'b', iban: 'SE2222222222222222222222' }),
    ]
    const result = unclaimedAccountsFor(accounts, new Set(['SE1111111111111111111111']))
    expect(result.map(a => a.uid)).toEqual(['b'])
  })

  it('matches claimed IBANs regardless of spacing', () => {
    const accounts = [makeAccount({ uid: 'a', iban: 'SE11 1111 1111 1111 1111 1111' })]
    const result = unclaimedAccountsFor(accounts, new Set(['SE1111111111111111111111']))
    expect(result).toEqual([])
  })

  it('never offers an account without an IBAN', () => {
    // Identity is the IBAN. Without one we cannot prove the account is
    // unclaimed, and two companies booking one physical account is worse than
    // making the user authorize separately.
    const accounts = [makeAccount({ uid: 'a', iban: undefined })]
    expect(unclaimedAccountsFor(accounts, new Set())).toEqual([])
  })

  it('offers a repeated IBAN only once', () => {
    // Some ASPSPs return one resource per balance type on the same account;
    // offering it twice lets the picker map two rows onto one ledger and trip
    // the (company_id, ledger_account) UNIQUE constraint on save.
    const accounts = [
      makeAccount({ uid: 'a', iban: 'SE3333333333333333333333' }),
      makeAccount({ uid: 'b', iban: 'SE33 3333 3333 3333 3333 3333' }),
    ]
    expect(unclaimedAccountsFor(accounts, new Set()).map(a => a.uid)).toEqual(['a'])
  })

  it('strips the source company ledger mapping and enables the account', () => {
    const accounts = [makeAccount({ ledger_account: '1942', enabled: false })]
    const [result] = unclaimedAccountsFor(accounts, new Set())
    expect(result.ledger_account).toBeUndefined()
    expect(result.enabled).toBe(true)
  })
})

describe('findReusableSessions', () => {
  it('returns a session with the accounts no company has claimed', async () => {
    const supabase = makeSupabase({
      bank_connections: [{
        data: [{
          id: 'conn-a', company_id: 'company-a', bank_name: 'Testbanken',
          provider: 'testbanken-se', session_id: 'sess-1', psu_type: 'business',
          consent_expires: FUTURE,
          accounts_data: [
            makeAccount({ uid: 'claimed', iban: 'SE1111111111111111111111' }),
            makeAccount({ uid: 'free', iban: 'SE2222222222222222222222' }),
          ],
        }],
        error: null,
      }],
      cash_accounts: [{ data: [{ iban: 'SE1111111111111111111111' }], error: null }],
      companies: [{ data: [{ id: 'company-a', name: 'Bolag A' }], error: null }],
    })

    const sessions = await findReusableSessions(supabase, 'user-1', 'company-b')

    expect(sessions).toHaveLength(1)
    expect(sessions[0].companyName).toBe('Bolag A')
    expect(sessions[0].sessionId).toBe('sess-1')
    expect(sessions[0].availableAccounts.map(a => a.uid)).toEqual(['free'])
  })

  it('offers nothing when every account is already claimed', async () => {
    const supabase = makeSupabase({
      bank_connections: [{
        data: [{
          id: 'conn-a', company_id: 'company-a', bank_name: 'Testbanken',
          provider: 'testbanken-se', session_id: 'sess-1', psu_type: 'business',
          consent_expires: FUTURE,
          accounts_data: [makeAccount({ uid: 'claimed', iban: 'SE1111111111111111111111' })],
        }],
        error: null,
      }],
      cash_accounts: [{ data: [{ iban: 'SE1111111111111111111111' }], error: null }],
      companies: [{ data: [{ id: 'company-a', name: 'Bolag A' }], error: null }],
    })

    expect(await findReusableSessions(supabase, 'user-1', 'company-b')).toEqual([])
  })

  it('stops offering an account another company already holds but has not mapped', async () => {
    // The gap between attaching a company and that company finishing its
    // picker: no cash_accounts row exists yet, so a claimed-ledger check alone
    // would hand the same physical account to a third company.
    const supabase = makeSupabase({
      bank_connections: [
        {
          data: [{
            id: 'conn-a', company_id: 'company-a', bank_name: 'Testbanken',
            provider: 'testbanken-se', session_id: 'sess-1', psu_type: 'business',
            consent_expires: FUTURE,
            accounts_data: [makeAccount({ uid: 'free', iban: 'SE2222222222222222222222' })],
          }],
          error: null,
        },
        {
          // Carrier pass: company-b already took that account on attach.
          data: [
            { company_id: 'company-a', accounts_data: [makeAccount({ iban: 'SE2222222222222222222222' })] },
            { company_id: 'company-b', accounts_data: [makeAccount({ iban: 'SE2222222222222222222222' })] },
          ],
          error: null,
        },
      ],
      cash_accounts: [{ data: [], error: null }],
      companies: [{ data: [{ id: 'company-a', name: 'Bolag A' }], error: null }],
    })

    expect(await findReusableSessions(supabase, 'user-1', 'company-c')).toEqual([])
  })

  it('counts only enabled cash accounts as claimed', async () => {
    // The connect callback mirrors EVERY account in the consent into
    // cash_accounts, deselected ones included. Treating any row as a claim
    // would mean the first company to connect speaks for the whole bank and
    // nothing is ever free to offer, so the feature would never fire.
    const supabase = makeSupabase({
      bank_connections: [
        {
          data: [{
            id: 'conn-a', company_id: 'company-a', bank_name: 'Testbanken',
            provider: 'testbanken-se', session_id: 'sess-1', psu_type: 'business',
            consent_expires: FUTURE,
            accounts_data: [
              makeAccount({ uid: 'deselected', iban: 'SE2222222222222222222222', enabled: false }),
            ],
          }],
          error: null,
        },
        { data: [], error: null },
      ],
      // The mirrored row exists but is disabled, so it holds nothing.
      cash_accounts: [{ data: [], error: null }],
      companies: [{ data: [{ id: 'company-a', name: 'Bolag A' }], error: null }],
    })

    const sessions = await findReusableSessions(supabase, 'user-1', 'company-b')

    expect(sessions).toHaveLength(1)
    expect(sessions[0].availableAccounts.map(a => a.uid)).toEqual(['deselected'])
    // The enabled filter is what the query must ask for.
    expect(supabase.used.cash_accounts[0].calls).toContainEqual(['eq', ['enabled', true]])
  })

  it('scopes the query to the user, other companies, and a live consent', async () => {
    const supabase = makeSupabase({ bank_connections: [{ data: [], error: null }] })

    await findReusableSessions(supabase, 'user-1', 'company-b')

    const filters = supabase.used.bank_connections[0].calls
    expect(filters).toContainEqual(['eq', ['user_id', 'user-1']])
    expect(filters).toContainEqual(['eq', ['status', 'active']])
    expect(filters).toContainEqual(['neq', ['company_id', 'company-b']])
    expect(filters.some(([m, args]) => m === 'gt' && args[0] === 'consent_expires')).toBe(true)
  })

  it('offers nothing when the claimed-IBAN lookup fails', async () => {
    // Fail closed: without the claimed set we cannot tell a free account from
    // one another company already books to.
    const supabase = makeSupabase({
      bank_connections: [{
        data: [{
          id: 'conn-a', company_id: 'company-a', bank_name: 'Testbanken',
          provider: 'testbanken-se', session_id: 'sess-1', psu_type: 'business',
          consent_expires: FUTURE,
          accounts_data: [makeAccount({ uid: 'free', iban: 'SE2222222222222222222222' })],
        }],
        error: null,
      }],
      cash_accounts: [{ data: null, error: { message: 'boom' } }],
      companies: [{ data: [], error: null }],
    })

    // Nothing is offered: an unreadable claimed set cannot prove an account
    // free, and offering one another company books to is the outcome this
    // feature must never produce. The failure must also not throw and take the
    // settings panel down with it, hence awaiting a value rather than a reject.
    const sessions = await findReusableSessions(supabase, 'user-1', 'company-b')
    expect(sessions).toEqual([])
  })

  it('returns an empty list when the session lookup fails', async () => {
    const supabase = makeSupabase({
      bank_connections: [{ data: null, error: { message: 'rls' } }],
    })
    expect(await findReusableSessions(supabase, 'user-1', 'company-b')).toEqual([])
  })
})

describe('countLiveSiblings', () => {
  it('counts the other non-revoked connections on the session', async () => {
    const supabase = makeSupabase({ bank_connections: [{ count: 2, error: null }] })

    const count = await countLiveSiblings(supabase, 'sess-1', 'conn-a')

    expect(count).toBe(2)
    const filters = supabase.used.bank_connections[0].calls
    expect(filters).toContainEqual(['eq', ['session_id', 'sess-1']])
    expect(filters).toContainEqual(['neq', ['id', 'conn-a']])
    expect(filters).toContainEqual(['neq', ['status', 'revoked']])
  })

  it('reports a sibling when the count fails, so the session is never revoked', async () => {
    const supabase = makeSupabase({
      bank_connections: [{ count: null, error: { message: 'timeout' } }],
    })
    expect(await countLiveSiblings(supabase, 'sess-1', 'conn-a')).toBe(1)
  })
})

describe('fanOutSessionRenewal', () => {
  it('does nothing when the session did not actually change', async () => {
    const supabase = makeSupabase({})
    const result = await fanOutSessionRenewal(supabase, {
      oldSessionId: 'sess-1',
      newSessionId: 'sess-1',
      consentExpires: FUTURE,
      excludeConnectionId: 'conn-a',
    })
    expect(result.movedCount).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('revives a dead sibling and leaves a pending_selection one pending', async () => {
    const supabase = makeSupabase({
      bank_connections: [
        {
          data: [
            { id: 'conn-b', status: 'expired', accounts_data: [] },
            { id: 'conn-c', status: 'pending_selection', accounts_data: [] },
          ],
          error: null,
        },
        { error: null },
        { error: null },
      ],
    })

    const result = await fanOutSessionRenewal(supabase, {
      oldSessionId: 'sess-old',
      newSessionId: 'sess-new',
      consentExpires: FUTURE,
      excludeConnectionId: 'conn-a',
    })

    expect(result.movedCount).toBe(2)

    // The connection that just re-authorized is already correct; touching it
    // again would be a no-op at best and a status regression at worst.
    expect(supabase.used.bank_connections[0].calls).toContainEqual(['neq', ['id', 'conn-a']])

    const revived = supabase.used.bank_connections[1].calls
    expect(revived).toContainEqual([
      'update',
      [{ session_id: 'sess-new', consent_expires: FUTURE, status: 'active', error_message: null }],
    ])

    // Still owes an account selection, so it must not be flipped to active:
    // that would skip the picker and sync nothing.
    const stillPending = supabase.used.bank_connections[2].calls
    expect(stillPending).toContainEqual([
      'update',
      [{ session_id: 'sess-new', consent_expires: FUTURE }],
    ])
  })

  it('re-points sibling accounts at the uids the new session issued', async () => {
    // The uid churn is the subtle half of the renewal: carrying only the
    // session id leaves siblings calling accounts the bank has retired.
    const supabase = makeSupabase({
      bank_connections: [
        {
          data: [{
            id: 'conn-b',
            status: 'active',
            accounts_data: [
              { uid: 'old-uid', iban: 'SE4444444444444444444444', currency: 'SEK', ledger_account: '1930', enabled: true },
            ],
          }],
          error: null,
        },
        { error: null },
        { error: null },
      ],
    })

    await fanOutSessionRenewal(supabase, {
      oldSessionId: 'sess-old',
      newSessionId: 'sess-new',
      consentExpires: FUTURE,
      excludeConnectionId: 'conn-a',
      sessionAccounts: [{ uid: 'new-uid', iban: 'SE44 4444 4444 4444 4444 4444' }],
    })

    // The uid re-point is its own write, after the session move.
    const update = supabase.used.bank_connections[2].calls.find(([m]) => m === 'update')
    const payload = (update?.[1][0] ?? {}) as { accounts_data?: StoredAccount[] }
    expect(payload.accounts_data?.[0].uid).toBe('new-uid')
    // The company's own mapping choices survive the remap.
    expect(payload.accounts_data?.[0].ledger_account).toBe('1930')
  })

  it('counts only the siblings that actually moved', async () => {
    const supabase = makeSupabase({
      bank_connections: [
        {
          data: [
            { id: 'conn-b', status: 'active', accounts_data: [] },
            { id: 'conn-c', status: 'active', accounts_data: [] },
          ],
          error: null,
        },
        { error: { message: 'boom' } },
        { error: null },
      ],
    })

    const result = await fanOutSessionRenewal(supabase, {
      oldSessionId: 'sess-old',
      newSessionId: 'sess-new',
      consentExpires: FUTURE,
      excludeConnectionId: 'conn-a',
    })

    expect(result.movedCount).toBe(1)
  })
})

describe('remapAccountUids', () => {
  it('matches on IBAN regardless of spacing and keeps everything else', () => {
    const { accounts, remapped } = remapAccountUids(
      [{ uid: 'old', iban: 'SE55 5555 5555 5555 5555 5555', currency: 'SEK', enabled: false, ledger_account: '1940' }],
      [{ uid: 'new', iban: 'SE5555555555555555555555' }],
    )
    expect(remapped).toBe(1)
    expect(accounts[0]).toMatchObject({ uid: 'new', enabled: false, ledger_account: '1940' })
  })

  it('leaves an account the new consent does not cover untouched', () => {
    // Silently dropping a mapped account is worse than a visible sync error.
    const { accounts, remapped, unmatched } = remapAccountUids(
      [{ uid: 'old', iban: 'SE6666666666666666666666', currency: 'SEK' }],
      [{ uid: 'new', iban: 'SE7777777777777777777777' }],
    )
    expect(remapped).toBe(0)
    expect(unmatched).toBe(1)
    expect(accounts[0].uid).toBe('old')
  })
})
