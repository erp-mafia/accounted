import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  unclaimedAccountsFor,
  findReusableSessions,
  countLiveSiblings,
  fanOutSessionRenewal,
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
    'select', 'eq', 'neq', 'not', 'is', 'in', 'gt', 'order', 'limit', 'range', 'update', 'insert',
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

type MockClient = SupabaseClient & { used: Record<string, ChainStub[]>; rpcMock: ReturnType<typeof vi.fn> }

/** Per-table result queues; each from(table) shifts the next result. */
function makeSupabase(queues: Record<string, Array<Record<string, unknown>>>): MockClient {
  const used: Record<string, ChainStub[]> = {}
  const rpcMock = vi.fn().mockResolvedValue({ data: { applied: true, remapped: 1, unmatched: 0 }, error: null })
  const client = {
    used, rpcMock, rpc: rpcMock,
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
  const input = { oldSessionId: 'sess-old', newSessionId: 'sess-new', consentExpires: FUTURE, excludeConnectionId: 'conn-a',
    sessionAccounts: [{ uid: 'new-uid', iban: 'SE4444444444444444444444', currency: 'SEK' }] }

  it('does nothing when the session did not change', async () => {
    const supabase = makeSupabase({})
    expect(await fanOutSessionRenewal(supabase, { ...input, newSessionId: 'sess-old' })).toEqual({ movedCount: 0 })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpcMock).not.toHaveBeenCalled()
  })

  it('commits each sibling through one company-scoped renewal RPC', async () => {
    const supabase = makeSupabase({ bank_connections: [{ data: [
      { id: 'conn-b', company_id: 'company-b' }, { id: 'conn-c', company_id: 'company-c' },
    ], error: null }] })
    expect(await fanOutSessionRenewal(supabase, input)).toEqual({ movedCount: 2 })
    expect(supabase.used.bank_connections).toHaveLength(1)
    expect(supabase.used.bank_connections[0].calls).toContainEqual(['neq', ['id', 'conn-a']])
    expect(supabase.rpcMock).toHaveBeenCalledTimes(2)
    for (const suffix of ['b', 'c']) {
      expect(supabase.rpcMock).toHaveBeenCalledWith('renew_shared_bank_connection', {
        p_company_id: `company-${suffix}`, p_connection_id: `conn-${suffix}`, p_source_connection_id: 'conn-a',
        p_old_session_id: 'sess-old', p_new_session_id: 'sess-new', p_consent_expires: FUTURE, p_session_accounts: input.sessionAccounts,
      })
    }
  })

  it('counts only committed renewals and continues after a stale or failed sibling', async () => {
    const supabase = makeSupabase({ bank_connections: [{ data: [
      { id: 'conn-b', company_id: 'company-b' }, { id: 'conn-c', company_id: 'company-c' }, { id: 'conn-d', company_id: 'company-d' },
    ], error: null }] })
    supabase.rpcMock.mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'Changed' } })
      .mockResolvedValueOnce({ data: { applied: false, reason: 'connection-changed' }, error: null })
    expect(await fanOutSessionRenewal(supabase, input)).toEqual({ movedCount: 1 })
    expect(supabase.rpcMock).toHaveBeenCalledTimes(3)
  })

  it('does not write after a failed sibling scan', async () => {
    const supabase = makeSupabase({ bank_connections: [{ data: null, error: { message: 'Unavailable' } }] })
    expect(await fanOutSessionRenewal(supabase, input)).toEqual({ movedCount: 0 })
    expect(supabase.rpcMock).not.toHaveBeenCalled()
  })

  it('reads every page before changing the session used by the scan filter', async () => {
    const supabase = makeSupabase({ bank_connections: [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `connection-${i}`, company_id: `company-${i}` })), error: null },
      { data: [{ id: 'last-connection', company_id: 'last-company' }], error: null },
    ] })
    expect(await fanOutSessionRenewal(supabase, input)).toEqual({ movedCount: 1001 })
    expect(supabase.used.bank_connections[0].calls).toContainEqual(['order', ['id']])
    expect(supabase.used.bank_connections[1].calls).toContainEqual(['range', [1000, 1999]])
    expect(supabase.rpcMock).toHaveBeenCalledTimes(1001)
  })
})
