import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'

const mocks = vi.hoisted(() => ({
  from: vi.fn(), getUser: vi.fn(), createSession: vi.fn(), balance: vi.fn(), read: vi.fn(), finalize: vi.fn(),
  resolve: vi.fn(), crossCompany: vi.fn(), fanOut: vi.fn(), finishSupersession: vi.fn(), revoke: vi.fn(), brand: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({ from: mocks.from }),
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}))
vi.mock('@/lib/cash-accounts/configuration', () => ({ readBankCallbackConfiguration: mocks.read, finalizeBankCallback: mocks.finalize }))
vi.mock('@/extensions/general/enable-banking/lib/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/extensions/general/enable-banking/lib/api-client')>(),
  createSession: mocks.createSession, getAccountBalance: mocks.balance,
}))
vi.mock('@/lib/cash-accounts/service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/cash-accounts/service')>(), resolvePsd2LedgerAccount: mocks.resolve,
}))
vi.mock('@/extensions/general/enable-banking/lib/session-sharing', () => ({
  fetchCrossCompanyAccountContext: mocks.crossCompany, fanOutSessionRenewal: mocks.fanOut,
}))
vi.mock('@/extensions/general/enable-banking/lib/supersede', () => ({ finishBankSupersession: mocks.finishSupersession }))
vi.mock('@/extensions/general/enable-banking/lib/session-revocation', () => ({ revokeUnusedSession: mocks.revoke }))
vi.mock('@/lib/branding/resolve', () => ({ resolveBrandResultByHost: mocks.brand }))
import { GET } from '../route'
import { eventBus } from '@/lib/events/bus'

const row = { id: 'conn-1', company_id: 'company-1', user_id: 'user-1', bank_name: 'TestBank',
  status: 'pending', session_id: null as string | null, accounts_data: null as StoredAccount[] | null, oauth_origin: null as string | null }
const iban = 'SE0000000000000000000001'
const expires = '2027-12-31T00:00:00Z'
const account = { uid: 'a', currency: 'SEK', account_id: { iban }, name: 'Bank' }
let pending: typeof row | null
let prior: StoredAccount[]
let cashRows: Array<{ id: string; external_uid: string; ledger_account: string; currency: string; iban: string | null }>
let cashError: { message: string; code: string } | null
let chains: ReturnType<typeof chain>[]
let emitted: ReturnType<typeof vi.spyOn>
function chain(data: unknown, error: unknown = null) {
  const c = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), single: vi.fn(), update: vi.fn(), delete: vi.fn(),
    then: (resolve: (value: unknown) => void) => resolve({ data, error }) }
  for (const key of ['select','eq','in','update','delete'] as const) c[key].mockReturnValue(c)
  c.single.mockResolvedValue({ data, error })
  return c
}
function request(params: Record<string, string> = { code: 'auth-code', state: 'valid-state' }) {
  return new Request(`http://localhost:3000/api/extensions/enable-banking/callback?${new URLSearchParams(params)}`)
}
async function complete(params?: Record<string, string>) {
  const response = await GET(request(params))
  return { response, body: await response.text() }
}
function plan() { return mocks.finalize.mock.calls[0][1] }
function reconnect(accounts: StoredAccount[]) {
  prior = accounts
  pending = { ...row, status: 'expired', session_id: 'old-session', accounts_data: accounts }
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
  pending = { ...row }; prior = []; cashRows = []; cashError = null; chains = []
  mocks.from.mockImplementation(table => {
    const c = chain(table === 'cash_accounts' ? cashRows : pending, table === 'cash_accounts' ? cashError : null)
    chains.push(c); return c
  })
  mocks.getUser.mockResolvedValue({ data: { user: { id: row.user_id } }, error: null })
  mocks.brand.mockImplementation(async host => ({ brand: host === 'books.partner.example' ? { domain: host } : null, lookupFailed: false }))
  mocks.read.mockImplementation(async () => ({ token: 'token-before-exchange', connection: { ...pending, accounts_data: prior } }))
  mocks.createSession.mockResolvedValue({ session_id: 'new-session', accounts: [account], access: { valid_until: expires } })
  mocks.resolve.mockImplementation(async (_db, _company, _user, input) => {
    const ledger = ['1930', '1931', '1932'].find(l => !input.exclude.has(l))
    return ledger ? { ledgerAccount: ledger, reuseCashAccountId: null } : null
  })
  mocks.crossCompany.mockResolvedValue({ claims: new Map(), deselectedIbans: new Set(), activeCompanyIbans: new Set() })
  mocks.finalize.mockImplementation(async (_db, input) => ({ connection: { ...row }, accounts: input.accounts,
    old_session_id: pending?.session_id ?? null, superseded: [] }))
  mocks.revoke.mockResolvedValue({ revoked: true })
  emitted = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)
})

describe('callback authentication and redirects', () => {
  it.each<Record<string, string>>([{ state: 'valid-state' }, { code: 'auth-code' }, { code: 'short', state: 'valid-state' }])('refuses malformed parameters %j', async params => {
    const { response } = await complete(params)
    expect(response.status).toBe(307); expect(response.headers.get('location')).toContain('bank_error=')
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled()
  })
  it('rejects an unknown state without consulting the user or exchanging the code', async () => {
    pending = null
    const { response } = await complete()
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('Starta bankkopplingen på nytt')
    expect(mocks.getUser).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled()
  })
  it('refuses a different initiator without changing the row', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'other-user' } } })
    const { response } = await complete()
    expect(new URL(response.headers.get('location')!).searchParams.get('bank_error')).toContain('annat användarkonto')
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled()
    expect(chains[0].delete).not.toHaveBeenCalled(); expect(chains[0].update).not.toHaveBeenCalled()
  })
  it.each([null, 'https://books.partner.example', 'https://unregistered.example'])('returns anonymous users to the trusted initiating origin %s', async origin => {
    pending!.oauth_origin = origin
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const { response } = await complete()
    const url = new URL(response.headers.get('location')!)
    expect(url.origin).toBe(origin === 'https://books.partner.example' ? origin : 'http://localhost:3000')
    expect(url.pathname).toBe('/login'); expect(url.searchParams.get('next')).toContain('state=valid-state')
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled()
  })
  it('finalizes an authenticated callback on the trusted brand origin', async () => {
    pending!.oauth_origin = 'https://books.partner.example'
    expect((await complete()).body).toContain('https://books.partner.example/settings/banking?select_accounts=conn-1')
  })
  it('keeps a signed hosted connector bounce separate from local finalization', async () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'test-connector-secret')
    const { signConnectorState } = await import('@/lib/connect/hosted/state')
    const state = signConnectorState({ kid: 'key-1', svc: 'bank', ret: 'https://instance.example.se/api/extensions/enable-banking/callback', st: 'instance-state', cref: 'company-ref' })
    const { response } = await complete({ code: 'auth-code', state })
    const url = new URL(response.headers.get('location')!)
    expect(url.origin).toBe('https://instance.example.se'); expect(url.searchParams.get('state')).toBe('instance-state')
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.getUser).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
  it.each([undefined, 'signed-connector-state'])('passes connector state %s into the exchange after reading current configuration', async connector => {
    await complete({ code: 'auth-code', state: 'valid-state', ...(connector ? { connector_state: connector } : {}) })
    expect(mocks.createSession).toHaveBeenCalledWith('auth-code', connector)
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), row.company_id, row.user_id, row.id, 'valid-state')
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.createSession.mock.invocationCallOrder[0])
  })
})

describe('one callback transaction', () => {
  it('streams a private progress page and finalizes every mirror without direct writes or balance fetching', async () => {
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [account, { ...account, uid: 'b', account_id: { iban: 'SE0002' } }] })
    const { response, body } = await complete()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const nonce = response.headers.get('content-security-policy')?.match(/script-src 'nonce-([^']+)'/)?.[1]
    expect(nonce).toBeTruthy(); expect(body.split(`<script nonce="${nonce}">`).length - 1).toBe(2)
    expect(body).toContain('select_accounts=conn-1'); expect(mocks.finalize).toHaveBeenCalledTimes(1)
    expect(plan()).toMatchObject({ companyId: row.company_id, userId: row.user_id, connectionId: row.id,
      oauthState: 'valid-state', expectedToken: 'token-before-exchange', sessionId: 'new-session',
      mirrors: [{ uid: 'a', ledger_account: '1930' }, { uid: 'b', ledger_account: '1931' }] })
    for (const c of chains) { expect(c.update).not.toHaveBeenCalled(); expect(c.delete).not.toHaveBeenCalled() }
    for (const call of mocks.resolve.mock.calls) expect(call[3].prepareOnly).toBe(true)
    expect(mocks.balance).not.toHaveBeenCalled()
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.consent_granted' }))
  })
  it('accepts an empty bank response and leaves the picker to report it', async () => {
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [] })
    expect((await complete()).body).toContain('select_accounts='); expect(plan().mirrors).toEqual([])
  })
  it('uses fresh snapshot choices rather than the first GET lookup', async () => {
    pending!.accounts_data = [{ uid: 'a', currency: 'SEK', enabled: true }]
    prior = [{ uid: 'a', currency: 'SEK', enabled: false, dedup_scope: 'current-scope' }]
    await complete()
    expect(plan().accounts[0]).toMatchObject({ enabled: false, dedup_scope: 'current-scope' })
  })
  it('does not exchange a code whose attempt already changed', async () => {
    mocks.read.mockRejectedValue(Object.assign(new Error('BANK_CALLBACK_CHANGED'), { code: 'PT409' }))
    expect((await complete()).body).toContain('bank_error=')
    expect(mocks.createSession).not.toHaveBeenCalled(); expect(mocks.finalize).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it.each(['mirror-read', 'allocation-error', 'allocation-empty', 'transaction'])('fails the entire %s attempt without success or old-consent cleanup', async failure => {
    reconnect([{ uid: 'old', currency: 'SEK', iban }])
    if (failure === 'mirror-read') cashError = { message: 'read failed', code: 'PT409' }
    if (failure === 'allocation-error') mocks.resolve.mockRejectedValue(new Error('allocation failed'))
    if (failure === 'allocation-empty') mocks.resolve.mockResolvedValue(null)
    if (failure === 'transaction') mocks.finalize.mockRejectedValue(Object.assign(new Error('BANK_CALLBACK_CHANGED'), { code: 'PT409' }))
    expect((await complete()).body).toContain('bank_error=')
    expect(mocks.fanOut).not.toHaveBeenCalled(); expect(mocks.finishSupersession).not.toHaveBeenCalled()
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'new-session')
    expect(emitted).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.consent_granted' }))
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.finalize_failed' }))
    const cleanup = chains.at(-1)!
    expect(cleanup.eq).toHaveBeenCalledWith('company_id', row.company_id)
    expect(cleanup.eq).toHaveBeenCalledWith('oauth_state', 'valid-state')
    expect(cleanup.in).toHaveBeenCalledWith('status', ['pending','expired','error'])
  })
  it.each(['pending', 'expired'])('scopes provider failure cleanup to the exact %s attempt', async status => {
    pending!.status = status; mocks.createSession.mockRejectedValue(new Error('Provider refused exchange'))
    expect((await complete()).body).toContain('bank_error=')
    const cleanup = chains.at(-1)!
    expect(cleanup.eq).toHaveBeenCalledWith('oauth_state', 'valid-state')
    expect(cleanup.eq).toHaveBeenCalledWith('company_id', row.company_id)
    expect(status === 'pending' ? cleanup.delete : cleanup.update).toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('uses the committed receipt for fan-out and defers all external effects until commit', async () => {
    reconnect([{ uid: 'old', currency: 'SEK', iban }])
    const committed = [{ uid: 'a', currency: 'SEK', iban, dedup_scope: 'donor-scope' }]
    mocks.finalize.mockResolvedValue({ connection: row, accounts: committed, old_session_id: 'receipt-old',
      superseded: [{ id: 'sibling', session_id: 'donor-session' }] })
    await complete()
    expect(mocks.fanOut).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ oldSessionId: 'receipt-old', sessionAccounts: committed }))
    expect(mocks.finishSupersession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ newSessionId: 'new-session' }), [{ id: 'sibling', session_id: 'donor-session' }])
    expect(mocks.finalize.mock.invocationCallOrder[0]).toBeLessThan(mocks.fanOut.mock.invocationCallOrder[0])
    expect(mocks.fanOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.finishSupersession.mock.invocationCallOrder[0])
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'receipt-old')
  })
  it('renews sharers of every superseded consent once, including a fresh bank-list connect', async () => {
    mocks.finalize.mockResolvedValue({ connection: row, accounts: [], old_session_id: null,
      superseded: [{ id: 'a', session_id: 'donor-session' }, { id: 'b', session_id: 'donor-session' }, { id: 'c', session_id: 'new-session' }] })
    await complete()
    expect(mocks.fanOut).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ oldSessionId: 'donor-session' }))
    expect(mocks.fanOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.finishSupersession.mock.invocationCallOrder[0])
  })
  it('keeps a committed callback successful if fan-out, old cleanup or audit emission fails', async () => {
    reconnect([{ uid: 'a', currency: 'SEK', iban }])
    mocks.fanOut.mockRejectedValue(new Error('Sibling busy')); mocks.revoke.mockRejectedValue(new Error('Cleanup unavailable'))
    emitted.mockRejectedValue(new Error('Audit unavailable'))
    expect((await complete()).body).toContain('select_accounts=')
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'old-session')
    expect(chains.every(c => c.update.mock.calls.length === 0 && c.delete.mock.calls.length === 0)).toBe(true)
  })
})

describe('account identity and standing choices', () => {
  it.each(['uid', 'iban'])('retains deselection and explicit dedup scope matched by %s', async matching => {
    reconnect([{ uid: matching === 'uid' ? 'a' : 'old', currency: 'SEK', iban, enabled: false, dedup_scope: 'pinned' }])
    await complete(); expect(plan().accounts[0]).toMatchObject({ enabled: false, dedup_scope: 'pinned' })
  })
  it('keeps multi-currency pockets with the same IBAN separate', async () => {
    reconnect([{ uid: 'old-eur', currency: 'EUR', iban, enabled: false, dedup_scope: 'eur-scope' },
      { uid: 'old-sek', currency: 'SEK', iban, enabled: true, dedup_scope: 'sek-scope' }])
    await complete(); expect(plan().accounts[0]).toMatchObject({ enabled: true, dedup_scope: 'sek-scope' })
  })
  it('matches a UID permutation by physical identity and reuses the correct cash IDs', async () => {
    reconnect([{ uid: 'a', currency: 'SEK', iban: 'SE0002', dedup_scope: 'second' }, { uid: 'b', currency: 'SEK', iban, dedup_scope: 'first' }])
    cashRows = [{ id: 'cash-a', external_uid: 'a', ledger_account: '1931', currency: 'SEK', iban: 'SE0002' },
      { id: 'cash-b', external_uid: 'b', ledger_account: '1930', currency: 'SEK', iban }]
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [account, { ...account, uid: 'b', account_id: { iban: 'SE0002' } }] })
    await complete()
    expect(plan().mirrors).toEqual([{ uid: 'a', ledger_account: '1930', reuse_cash_account_id: 'cash-b' }, { uid: 'b', ledger_account: '1931', reuse_cash_account_id: 'cash-a' }])
    expect(plan().accounts.map((a: StoredAccount) => a.dedup_scope)).toEqual(['first', 'second'])
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('does not trust a mirrored UID when its IBAN now names another account', async () => {
    reconnect([{ uid: 'a', currency: 'SEK', iban: 'SE0002' }])
    cashRows = [{ id: 'wrong-cash', external_uid: 'a', ledger_account: '1935', currency: 'SEK', iban: 'SE0002' }]
    await complete(); expect(mocks.resolve).toHaveBeenCalled(); expect(plan().mirrors[0].reuse_cash_account_id).toBeNull()
  })
  it('preserves an own custom ledger without allocation', async () => {
    reconnect([{ uid: 'a', currency: 'SEK', iban }])
    cashRows = [{ id: 'cash', external_uid: 'a', ledger_account: '1935', currency: 'SEK', iban }]
    await complete(); expect(plan().mirrors).toEqual([{ uid: 'a', ledger_account: '1935', reuse_cash_account_id: 'cash' }])
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('reuses an IBAN mapping even when its prior UID is retired', async () => {
    cashRows = [{ id: 'cash', external_uid: 'retired', ledger_account: '1935', currency: 'SEK', iban }]
    mocks.resolve.mockImplementation(async (_db, _company, _user, input) => {
      expect(input.exclude.has('1935')).toBe(false)
      return { ledgerAccount: '1935', reuseCashAccountId: 'cash', source: 'iban' }
    })
    await complete()
    expect(plan().mirrors[0]).toMatchObject({ ledger_account: '1935', reuse_cash_account_id: 'cash' })
  })
  it('carries a unique no-IBAN pair and rekeys its existing disabled mirror card', async () => {
    reconnect([{ uid: 'old-card', name: 'BOKIO_Debit_Business', currency: 'SEK', enabled: false, dedup_scope: 'legacy-card' }])
    cashRows = [{ id: 'cash', external_uid: 'old-card', ledger_account: '1935', currency: 'SEK', iban: null }]
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [{ uid: 'new-card', name: 'BOKIO_Debit_Business', currency: 'SEK' }] })
    await complete()
    expect(plan()).toMatchObject({ noIbanPairs: { 'new-card': 'old-card' }, accounts: [{ enabled: false, dedup_scope: 'legacy-card', mirror_card_account: true }], mirrors: [{ uid: 'new-card', reuse_cash_account_id: 'cash' }] })
  })
  it.each(['two-prior', 'two-new', 'prior-iban'])('does not guess a no-IBAN pair with %s', async kind => {
    reconnect([{ uid: 'old', currency: 'SEK', ...(kind === 'prior-iban' ? { iban } : {}) }, ...(kind === 'two-prior' ? [{ uid: 'old-2', currency: 'SEK' }] : [])])
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [{ uid: 'new', currency: 'SEK' }, ...(kind === 'two-new' ? [{ uid: 'new-2', currency: 'SEK' }] : [])] })
    await complete(); expect(plan().noIbanPairs).toEqual({}); expect(plan().accounts[0].dedup_scope).toBe('new')
  })
  it('refuses ambiguous IBAN matches before any transaction', async () => {
    reconnect([{ uid: 'old-1', iban, currency: 'SEK' }, { uid: 'old-2', iban, currency: 'SEK' }])
    expect((await complete()).body).toContain('bank_error='); expect(mocks.finalize).not.toHaveBeenCalled()
  })
})

describe('cross-company and mirror-card defaults', () => {
  it.each(['claimed', 'deselected', 'lookup-failed', 'mirror-card'])('disables new %s accounts without allocating or mirroring', async reason => {
    if (reason === 'lookup-failed') mocks.crossCompany.mockResolvedValue(null)
    if (reason === 'claimed') mocks.crossCompany.mockResolvedValue({ claims: new Map([[iban, { companyId: 'other', companyName: 'Other company' }]]), deselectedIbans: new Set() })
    if (reason === 'deselected') mocks.crossCompany.mockResolvedValue({ claims: new Map(), deselectedIbans: new Set([iban]) })
    if (reason === 'mirror-card') mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [{ uid: 'a', currency: 'SEK', name: 'BOKIO_Debit_Business' }] })
    await complete(); expect(plan().accounts[0].enabled).toBe(false); expect(plan().mirrors).toEqual([]); expect(mocks.resolve).not.toHaveBeenCalled()
    if (reason === 'claimed') expect(plan().accounts[0]).toMatchObject({ claimed_by_company_id: 'other', claimed_by_company_name: 'Other company' })
    if (reason === 'deselected') expect(plan().accounts[0].deselected_elsewhere).toBe(true)
    if (reason === 'mirror-card') expect(plan().accounts[0].mirror_card_account).toBe(true)
  })
  it.each([true, false])('preserves the standing enabled=%s choice when another company claims the IBAN', async enabled => {
    reconnect([{ uid: 'old', iban, currency: 'SEK', enabled }])
    mocks.crossCompany.mockResolvedValue({ claims: new Map([[iban, { companyId: 'other', companyName: 'Other' }]]), deselectedIbans: new Set() })
    await complete(); expect(plan().accounts[0].enabled).toBe(enabled)
    if (!enabled) { expect(plan().accounts[0].claimed_by_company_id).toBe('other'); expect(plan().mirrors).toEqual([]) }
    else expect(plan().accounts[0]).not.toHaveProperty('claimed_by_company_id')
  })
  it('drops stale claim labels when no other company claims the account', async () => {
    reconnect([{ uid: 'a', iban, currency: 'SEK', enabled: false, claimed_by_company_id: 'old-claim' }])
    await complete(); expect(plan().accounts[0]).not.toHaveProperty('claimed_by_company_id'); expect(plan().accounts[0].enabled).toBe(false)
  })
  it.each([true, false])('preserves the user mirror-card choice enabled=%s', async enabled => {
    reconnect([{ uid: 'a', currency: 'SEK', enabled }])
    mocks.createSession.mockResolvedValue({ session_id: 'new-session', access: { valid_until: expires }, accounts: [{ uid: 'a', currency: 'SEK', name: 'BOKIO_Debit_Business' }] })
    await complete(); expect(plan().accounts[0].enabled).toBe(enabled)
    expect(plan().mirrors).toHaveLength(enabled ? 1 : 0)
  })
})

describe('bank denial', () => {
  it('returns a translated error without a database request when state is absent', async () => {
    const { response } = await complete({ error: 'access_denied' })
    expect(response.headers.get('location')).toContain('bank_error='); expect(mocks.from).not.toHaveBeenCalled()
  })
  it.each(['pending', 'expired'])('cleans up only the matching %s OAuth attempt and emits an audit event', async status => {
    pending!.status = status; pending!.oauth_origin = 'https://books.partner.example'
    const { response } = await complete({ error: 'access_denied', state: 'valid-state', error_description: 'cancelled' })
    const url = new URL(response.headers.get('location')!)
    expect(url.origin).toBe('https://books.partner.example'); expect(url.searchParams.get('bank_error_code')).toBe('access_denied')
    expect(url.searchParams.get('bank_error_reason')).toBe('cancelled')
    const cleanup = chains.at(-1)!
    expect(cleanup.eq).toHaveBeenCalledWith('oauth_state', 'valid-state'); expect(cleanup.eq).toHaveBeenCalledWith('company_id', row.company_id)
    expect(status === 'pending' ? cleanup.delete : cleanup.update).toHaveBeenCalled()
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.consent_denied' }))
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
  it('keeps an established connection expired when the bank reports session expiry', async () => {
    pending!.status = 'expired'
    await complete({ error: 'session_expired', state: 'valid-state' })
    expect(chains.at(-1)!.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired', oauth_state: null }))
    expect(chains.at(-1)!.in).toHaveBeenCalledWith('status', ['pending','expired','error'])
  })
})
