/**
 * Drives the REAL Enable Banking client against the fake API in
 * tests/e2e/fakes/. Nothing is mocked: lib/jwt.ts signs a genuine RS256 token,
 * the fake verifies the signature, and every response is parsed by the
 * production code path.
 *
 * This is the contract test that keeps the fake honest. If the client starts
 * calling a different endpoint or expecting a different shape, this fails and
 * the fake gets updated with it, instead of the browser suite silently drifting
 * away from what Enable Banking actually returns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as crypto from 'node:crypto'

type Fake = {
  url: string
  scenario: { sessionStatus: string; transactionsError: number | null; authError: number | null }
  reset: () => void
  close: () => Promise<void>
}

let fake: Fake
let client: typeof import('@/extensions/general/enable-banking/lib/api-client')

beforeAll(async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const mod = await import('../fakes/enable-banking-server.mjs')
  fake = await mod.startFakeEnableBanking({ publicKey })

  // api-client and jwt read these at module load, so they must be set before
  // the dynamic import below.
  process.env.ENABLE_BANKING_API_URL = fake.url
  process.env.ENABLE_BANKING_API_URL_PRODUCTION = ''
  process.env.ENABLE_BANKING_APP_ID = 'e2e-test-app-id'
  process.env.ENABLE_BANKING_APP_ID_PRODUCTION = ''
  process.env.ENABLE_BANKING_PRIVATE_KEY = Buffer.from(privateKey).toString('base64')
  process.env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION = ''

  client = await import('@/extensions/general/enable-banking/lib/api-client')
})

afterAll(async () => {
  await fake?.close()
})

/** Walk the consent flow the way a browser would, and return the session. */
async function connectBank(aspspName = 'Swedbank') {
  const auth = await client.startAuthorization(
    aspspName,
    'SE',
    'http://localhost:3000/api/extensions/enable-banking/callback',
    'state-123',
    'business'
  )

  // The browser would render this page and the user would press the button.
  const approve = await fetch(`${fake.url}/sca/${auth.authorization_id}/approve`, {
    method: 'POST',
    redirect: 'manual',
  })
  const location = approve.headers.get('location')!
  const code = new URL(location).searchParams.get('code')!

  return { auth, location, session: await client.createSession(code) }
}

describe('enable banking client against the fake API', () => {
  it('signs a JWT the server accepts', async () => {
    // A bad signature comes back as 401 and getASPSPs throws, so simply
    // getting a list proves lib/jwt.ts produced a verifiable RS256 token.
    const aspsps = await client.getASPSPs('SE', 'business')
    expect(aspsps.map((a) => a.name)).toEqual(
      expect.arrayContaining(['Swedbank', 'Handelsbanken', 'Lunar', 'SEB'])
    )
  })

  it('pins Handelsbanken hidden Mobile BankID, and nothing else', async () => {
    const aspsps = await client.getASPSPs('SE', 'business')

    // Hidden DECOUPLED: unreachable unless pinned explicitly.
    const shb = aspsps.find((a) => a.name === 'Handelsbanken')
    expect(client.selectPreferredAuthMethod(shb?.auth_methods, 'business')?.name).toBe(
      'SE_BANKID_DECOUPLED'
    )

    // Visible DECOUPLED: part of the bank's own default flow. Pinning it is
    // the PR #854 regression that broke Lunar, so it must stay unpinned.
    const lunar = aspsps.find((a) => a.name === 'Lunar')
    expect(client.selectPreferredAuthMethod(lunar?.auth_methods, 'business')).toBeUndefined()

    // Plain REDIRECT banks are never pinned either.
    const swedbank = aspsps.find((a) => a.name === 'Swedbank')
    expect(client.selectPreferredAuthMethod(swedbank?.auth_methods, 'business')).toBeUndefined()
  })

  it('completes the consent flow and returns the accounts', async () => {
    const { location, session } = await connectBank()

    // The redirect back must carry both code and the state we sent, or the
    // callback route cannot tie the consent to the right company.
    expect(new URL(location).searchParams.get('state')).toBe('state-123')

    expect(session.session_id).toBeTruthy()
    expect(session.aspsp.name).toBe('Swedbank')
    expect(session.accounts).toHaveLength(2)
    expect(session.accounts[0].account_id?.iban).toBe('SE4550000000058398257466')
    expect(session.accounts[1].currency).toBe('EUR')
    expect(new Date(session.access.valid_until).getTime()).toBeGreaterThan(Date.now())
  })

  it('reads a balance', async () => {
    await connectBank()
    const balances = await client.getAccountBalances('acc-sek-0000-0000-0000-000000000001')
    expect(balances[0].balance_amount).toEqual({ amount: '184320.55', currency: 'SEK' })
    expect(balances[0].balance_type).toBe('CLBD')
  })

  it('paginates through every transaction', async () => {
    await connectBank()
    // The fake pages in tens; 20 fixtures means the loop must follow two
    // continuation keys rather than stopping after the first page.
    const txs = await client.getAllTransactions('acc-sek-0000-0000-0000-000000000001')
    expect(txs).toHaveLength(20)

    const refs = new Set(txs.map((t) => t.entry_reference))
    expect(refs.size).toBe(20)
  })

  it('converts amounts with the right sign and no rounding drift', async () => {
    await connectBank()
    const txs = await client.getAllTransactions('acc-sek-0000-0000-0000-000000000001')

    const incoming = txs.find((t) => t.debtor_name === 'NORDIC DESIGN AB')!
    const outgoing = txs.find((t) => t.creditor_name === 'SKATTEVERKET')!

    expect(client.convertTransaction(incoming, 'SEK').amount).toBe(18750)
    expect(client.convertTransaction(outgoing, 'SEK').amount).toBe(-43120)

    // Öre must survive the round trip intact.
    const ore = txs.find((t) => t.transaction_amount.amount === '62.75')!
    expect(client.convertTransaction(ore, 'SEK').amount).toBe(-62.75)

    const brf = txs.find((t) => t.debtor_name === 'BRF SOLGÅRDEN')!
    expect(client.convertTransaction(brf, 'SEK').amount).toBe(7350.25)
  })

  it('honours the date window', async () => {
    await connectBank()
    const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
    const txs = await client.getAllTransactions('acc-sek-0000-0000-0000-000000000001', from)
    expect(txs.length).toBeGreaterThan(0)
    expect(txs.every((t) => t.booking_date! >= from)).toBe(true)
  })

  it('surfaces a consent that died bank-side as a session expiry', async () => {
    const { session } = await connectBank()
    fake.scenario.sessionStatus = 'CLOSED'

    // This is the reconnect-banner path: the client must classify the failure
    // as "re-authorize", not as a transient error to retry forever.
    await expect(
      client.getAllTransactions('acc-sek-0000-0000-0000-000000000001')
    ).rejects.toThrow()

    expect(client.isSessionExpiredResponse(401, 'CLOSED_SESSION')).toBe(true)
    expect(client.isSessionExpiredResponse(401, 'Unauthorized')).toBe(false)

    const health = await client.probeSessionHealth(session.session_id)
    expect(health).toBeTruthy()

    fake.scenario.sessionStatus = 'VALID'
  })

  it('deletes a session on disconnect', async () => {
    const { session } = await connectBank()
    await expect(client.deleteSession(session.session_id)).resolves.not.toThrow()
    await expect(client.getSession(session.session_id)).rejects.toThrow()
  })

  it('rejects a reused authorization code', async () => {
    const auth = await client.startAuthorization(
      'SEB',
      'SE',
      'http://localhost:3000/api/extensions/enable-banking/callback',
      'state-abc',
      'business'
    )
    const approve = await fetch(`${fake.url}/sca/${auth.authorization_id}/approve`, {
      method: 'POST',
      redirect: 'manual',
    })
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!

    await expect(client.createSession(code)).resolves.toBeTruthy()
    // A replayed code must not mint a second consent.
    await expect(client.createSession(code)).rejects.toThrow()
  })
})
