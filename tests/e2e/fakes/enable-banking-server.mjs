/**
 * Fake Enable Banking (PSD2) API for end-to-end tests.
 *
 * The real client is extensions/general/enable-banking/lib/api-client.ts. It
 * reads its base URL from ENABLE_BANKING_API_URL, so pointing that at this
 * server exercises the entire connect -> consent -> sync path without touching
 * Enable Banking, a bank, or BankID.
 *
 * What is faithful on purpose:
 *
 * - Every response shape matches the interfaces in api-client.ts (ASPSP,
 *   AuthResponse, SessionResponse, BalanceResponse, TransactionsResponse).
 * - The Authorization header is a real RS256 JWT and this server verifies its
 *   signature against the public half of the test keypair. A signing bug in
 *   lib/jwt.ts fails here instead of silently passing.
 * - Handelsbanken carries a hidden DECOUPLED Mobile BankID method, which is
 *   the case selectPreferredAuthMethod() exists to handle. Lunar carries a
 *   VISIBLE decoupled method, which must NOT be pinned (PR #854 regression).
 * - /auth returns a URL to an SCA page served here that looks and behaves like
 *   a bank's BankID step, so browser replays show a real-looking consent flow
 *   before the redirect back to the app.
 * - Transactions paginate via continuation_key, the way the real API does, so
 *   getAllTransactions()'s pagination loop is actually covered.
 *
 * Scenario control (for the unhappy paths that matter in production):
 *
 *   POST /__fake/scenario  {"sessionStatus": "CLOSED"}   -> consent died bank-side
 *   POST /__fake/scenario  {"transactionsError": 429}    -> upstream rate limit
 *   POST /__fake/scenario  {}                            -> reset to healthy
 *   GET  /__fake/state                                   -> inspect what the app did
 *
 * Run: node tests/e2e/fakes/enable-banking-server.mjs
 */

import { createServer } from 'node:http'
import * as crypto from 'node:crypto'

const PORT = Number(process.env.FAKE_EB_PORT || 4010)
let PUBLIC_KEY = process.env.FAKE_EB_PUBLIC_KEY || ''
let SELF_URL = process.env.FAKE_EB_URL || `http://localhost:${PORT}`

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** authorization_id -> { redirect_url, state, aspsp, psu_type, auth_method } */
const authorizations = new Map()
/** code -> authorization_id */
const codes = new Map()
/** session_id -> session object */
const sessions = new Map()

/** Knobs the test flips to drive the app down an unhappy path. */
const scenario = {
  sessionStatus: 'VALID',
  transactionsError: null,
  authError: null,
}

/** Everything the app asked us for, so a test can assert on the interaction. */
const calls = []

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const ASPSPS = [
  {
    name: 'Swedbank',
    country: 'SE',
    bic: 'SWEDSESS',
    logo: `${SELF_URL}/static/swedbank.svg`,
    max_consent_validity: 7776000,
    auth_methods: [
      {
        name: 'SE_BANKID_REDIRECT',
        title: 'Mobilt BankID',
        approach: 'REDIRECT',
        psu_types: ['personal', 'business'],
      },
    ],
  },
  {
    name: 'Handelsbanken',
    country: 'SE',
    bic: 'HANDSESS',
    logo: `${SELF_URL}/static/handelsbanken.svg`,
    max_consent_validity: 7776000,
    auth_methods: [
      // Visible default that fails for corporate PSUs upstream: the reason the
      // hidden method below has to be pinned explicitly.
      { name: 'SE_CARD_READER', title: 'Dosa', approach: 'REDIRECT', psu_types: ['business'] },
      {
        name: 'SE_BANKID_DECOUPLED',
        title: 'Mobilt BankID',
        approach: 'DECOUPLED',
        hidden_method: true,
        psu_types: ['business'],
      },
    ],
  },
  {
    name: 'Lunar',
    country: 'SE',
    bic: 'LUNASE22',
    logo: `${SELF_URL}/static/lunar.svg`,
    max_consent_validity: 7776000,
    auth_methods: [
      // Visible decoupled: pinning this one is the PR #854 regression.
      {
        name: 'SE_BANKID_DECOUPLED',
        title: 'Mobilt BankID',
        approach: 'DECOUPLED',
        hidden_method: false,
        psu_types: ['personal', 'business'],
      },
    ],
  },
  {
    name: 'SEB',
    country: 'SE',
    bic: 'ESSESESS',
    logo: `${SELF_URL}/static/seb.svg`,
    max_consent_validity: 7776000,
    auth_methods: [
      {
        name: 'SE_BANKID_REDIRECT',
        title: 'Mobilt BankID',
        approach: 'REDIRECT',
        psu_types: ['personal', 'business'],
      },
    ],
  },
]

const ACCOUNTS = [
  {
    uid: 'acc-sek-0000-0000-0000-000000000001',
    account_id: { iban: 'SE4550000000058398257466', bban: '83982574665' },
    name: 'Företagskonto',
    product: 'Företagskonto',
    currency: 'SEK',
    identification_hash: 'hash-sek-1',
  },
  {
    uid: 'acc-eur-0000-0000-0000-000000000002',
    account_id: { iban: 'SE3550000000054910000003', bban: '49100000031' },
    name: 'Valutakonto EUR',
    product: 'Valutakonto',
    currency: 'EUR',
    identification_hash: 'hash-eur-2',
  },
]

const BALANCES = {
  'acc-sek-0000-0000-0000-000000000001': '184320.55',
  'acc-eur-0000-0000-0000-000000000002': '4210.00',
}

/**
 * Realistic Swedish business-account activity. Dates are expressed as
 * days-ago so every run stays inside the PSD2 90-day window without the
 * fixture rotting.
 *
 * Deliberately included, because each one exercises a different code path in
 * the mapping and reconciliation engines:
 * - a customer payment carrying an OCR reference (invoice matching)
 * - a supplier payment naming the supplier (supplier matching)
 * - card purchases with an MCC (categorisation)
 * - a Skatteverket payment (skattekonto reconciliation)
 * - a salary run (payroll)
 * - a transaction with no remittance text and no counterparty, which is what
 *   deriveTransactionLabel() has to fall back on
 * - öre-level amounts, to catch rounding drift
 */
const TX_FIXTURES = [
  {
    daysAgo: 2,
    amount: '18750.00',
    ind: 'CRDT',
    debtor: 'NORDIC DESIGN AB',
    remittance: ['Betalning faktura 2026-114', 'OCR 1141234567890'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 3,
    amount: '2487.50',
    ind: 'DBIT',
    creditor: 'TELIA SVERIGE AB',
    remittance: ['Autogiro Telia 4471028'],
    code: 'PMNT-ICDT-AUTT',
  },
  {
    daysAgo: 5,
    amount: '1249.00',
    ind: 'DBIT',
    creditor: 'DUSTIN SVERIGE AB',
    remittance: ['Kortköp DUSTIN.SE'],
    mcc: '5732',
    code: 'PMNT-CCRD-POSD',
  },
  {
    daysAgo: 7,
    amount: '43120.00',
    ind: 'DBIT',
    creditor: 'SKATTEVERKET',
    remittance: ['Inbetalning skattekonto 16556677-8899'],
    code: 'PMNT-ICDT-ESCT',
  },
  {
    daysAgo: 9,
    amount: '96500.00',
    ind: 'DBIT',
    creditor: 'LÖNEUTBETALNING',
    remittance: ['Lön augusti'],
    code: 'PMNT-ICDT-SALA',
  },
  {
    daysAgo: 11,
    amount: '389.90',
    ind: 'DBIT',
    creditor: 'CIRCLE K',
    remittance: ['Kortköp CIRCLE K STHLM'],
    mcc: '5541',
    code: 'PMNT-CCRD-POSD',
  },
  {
    daysAgo: 12,
    amount: '62.75',
    ind: 'DBIT',
    remittance: [],
    code: 'PMNT-RCDT-CHRG',
    proprietary: 'AVGIFT',
  },
  {
    daysAgo: 15,
    amount: '7350.25',
    ind: 'CRDT',
    debtor: 'BRF SOLGÅRDEN',
    remittance: ['Faktura 2026-108'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 18,
    amount: '12000.00',
    ind: 'DBIT',
    creditor: 'HYRESVÄRDEN FASTIGHETS AB',
    remittance: ['Hyra kontor september'],
    code: 'PMNT-ICDT-ESCT',
  },
  {
    daysAgo: 21,
    amount: '4990.00',
    ind: 'CRDT',
    debtor: 'SWISH',
    remittance: ['Swish från Anna Lindqvist'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 25,
    amount: '899.00',
    ind: 'DBIT',
    creditor: 'AMAZON WEB SERVICES',
    remittance: ['AWS EMEA'],
    mcc: '7372',
    code: 'PMNT-CCRD-POSD',
  },
  {
    daysAgo: 30,
    amount: '25400.00',
    ind: 'CRDT',
    debtor: 'KOMMUNAL FÖRVALTNING',
    remittance: ['Betalning faktura 2026-101', 'OCR 1011234567897'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 34,
    amount: '3125.00',
    ind: 'DBIT',
    creditor: 'FORTUM MARKETS AB',
    remittance: ['El kontor juli'],
    code: 'PMNT-ICDT-AUTT',
  },
  {
    daysAgo: 41,
    amount: '156.40',
    ind: 'DBIT',
    creditor: 'SL',
    remittance: ['Kortköp SL BILJETT'],
    mcc: '4111',
    code: 'PMNT-CCRD-POSD',
  },
  {
    daysAgo: 47,
    amount: '9800.00',
    ind: 'CRDT',
    debtor: 'VÄSTKUST MEDIA AB',
    remittance: ['Faktura 2026-096'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 52,
    amount: '2199.00',
    ind: 'DBIT',
    creditor: 'APPLE DISTRIBUTION INTERNATIONAL',
    remittance: ['Kortköp APPLE.COM/BILL'],
    mcc: '5734',
    code: 'PMNT-CCRD-POSD',
  },
  {
    daysAgo: 58,
    amount: '41000.00',
    ind: 'DBIT',
    creditor: 'SKATTEVERKET',
    remittance: ['Inbetalning skattekonto 16556677-8899'],
    code: 'PMNT-ICDT-ESCT',
  },
  {
    daysAgo: 63,
    amount: '96500.00',
    ind: 'DBIT',
    creditor: 'LÖNEUTBETALNING',
    remittance: ['Lön juni'],
    code: 'PMNT-ICDT-SALA',
  },
  {
    daysAgo: 71,
    amount: '14375.80',
    ind: 'CRDT',
    debtor: 'NORDIC DESIGN AB',
    remittance: ['Betalning faktura 2026-089', 'OCR 891234567895'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 84,
    amount: '525.00',
    ind: 'DBIT',
    creditor: 'POSTNORD SVERIGE AB',
    remittance: ['Frakt'],
    code: 'PMNT-ICDT-ESCT',
  },
]

const EUR_TX_FIXTURES = [
  {
    daysAgo: 6,
    amount: '1450.00',
    ind: 'CRDT',
    debtor: 'HELSINKI SOFTWARE OY',
    remittance: ['Invoice 2026-EU-04'],
    code: 'PMNT-RCDT-ESCT',
  },
  {
    daysAgo: 22,
    amount: '320.00',
    ind: 'DBIT',
    creditor: 'HETZNER ONLINE GMBH',
    remittance: ['Hetzner invoice'],
    code: 'PMNT-ICDT-ESCT',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().slice(0, 10)
}

function buildTransactions(accountUid) {
  const fixtures =
    accountUid === 'acc-eur-0000-0000-0000-000000000002' ? EUR_TX_FIXTURES : TX_FIXTURES
  const currency = accountUid === 'acc-eur-0000-0000-0000-000000000002' ? 'EUR' : 'SEK'

  return fixtures.map((f, i) => {
    const date = isoDaysAgo(f.daysAgo)
    const tx = {
      // Stable per account so re-syncs dedupe instead of re-importing.
      entry_reference: `${accountUid.slice(0, 7)}-${date}-${i}`,
      transaction_id: `${accountUid.slice(0, 7)}-tx-${i}`,
      booking_date: date,
      value_date: date,
      transaction_amount: { amount: f.amount, currency },
      credit_debit_indicator: f.ind,
      remittance_information: f.remittance,
      bank_transaction_code: f.code,
    }
    if (f.creditor) {
      tx.creditor_name = f.creditor
      tx.creditor = { name: f.creditor }
    }
    if (f.debtor) {
      tx.debtor_name = f.debtor
      tx.debtor = { name: f.debtor }
    }
    if (f.mcc) tx.merchant_category_code = f.mcc
    if (f.proprietary) tx.proprietary_bank_transaction_code = f.proprietary
    return tx
  })
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({ __raw: raw })
      }
    })
  })
}

/**
 * Verify the RS256 JWT the app signs in lib/jwt.ts. Returns an error string,
 * or null when the token is good. Without FAKE_EB_PUBLIC_KEY set we only
 * require that a bearer token is present at all.
 */
function verifyAuth(req) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return 'missing bearer token'
  const token = header.slice(7)
  if (!PUBLIC_KEY) return null

  const parts = token.split('.')
  if (parts.length !== 3) return 'malformed jwt'
  const [h, p, s] = parts

  let head
  try {
    head = JSON.parse(Buffer.from(h, 'base64url').toString())
  } catch {
    return 'unparseable jwt header'
  }
  if (head.alg !== 'RS256') return `unexpected alg ${head.alg}`
  if (!head.kid) return 'jwt header missing kid (Enable Banking app id)'

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    PUBLIC_KEY,
    Buffer.from(s, 'base64url')
  )
  if (!ok) return 'jwt signature does not verify'

  let payload
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  } catch {
    return 'unparseable jwt payload'
  }
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) return 'jwt expired'
  if (payload.aud !== 'api.enablebanking.com') return `unexpected aud ${payload.aud}`
  return null
}

function scaPage(authorizationId, aspspName) {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${aspspName} - Identifiering</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background:#f4f5f7; color:#14181f; display:flex; align-items:center;
         justify-content:center; min-height:100vh; }
  .card { background:#fff; border-radius:14px; padding:40px; width:min(420px, 92vw);
          box-shadow:0 1px 3px rgba(0,0,0,.08), 0 10px 32px rgba(0,0,0,.06); }
  .bank { font-size:13px; letter-spacing:.08em; text-transform:uppercase;
          color:#6b7280; margin:0 0 6px; }
  h1 { font-size:21px; margin:0 0 8px; }
  p { color:#4b5563; font-size:14px; line-height:1.55; margin:0 0 26px; }
  label { display:block; font-size:13px; font-weight:600; margin:0 0 6px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px;
          border:1px solid #d1d5db; border-radius:8px; margin:0 0 20px; }
  button { width:100%; padding:13px; font-size:15px; font-weight:600; color:#fff;
           background:#0b5cff; border:0; border-radius:8px; cursor:pointer; }
  button:hover { background:#0a4fdb; }
  .note { margin:22px 0 0; font-size:12px; color:#9ca3af; text-align:center; }
</style>
</head>
<body>
  <main class="card">
    <p class="bank">${aspspName}</p>
    <h1>Identifiera dig med BankID</h1>
    <p>Ange ditt personnummer och godkänn sedan i BankID-appen för att ge Accounted läsbehörighet till dina konton.</p>
    <form method="POST" action="/sca/${authorizationId}/approve">
      <label for="pnr">Personnummer</label>
      <input id="pnr" name="pnr" inputmode="numeric" placeholder="ÅÅÅÅMMDD-XXXX" value="19850101-1234">
      <button type="submit" id="approve">Godkänn i BankID</button>
    </form>
    <p class="note">Testmiljö. Ingen riktig BankID-signering sker.</p>
  </main>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, SELF_URL)
  const path = url.pathname
  const method = req.method || 'GET'

  // --- test control plane, never authenticated -----------------------------
  if (path === '/__fake/scenario' && method === 'POST') {
    const body = await readBody(req)
    scenario.sessionStatus = body.sessionStatus ?? 'VALID'
    scenario.transactionsError = body.transactionsError ?? null
    scenario.authError = body.authError ?? null
    return json(res, 200, { ok: true, scenario })
  }
  if (path === '/__fake/state' && method === 'GET') {
    return json(res, 200, {
      scenario,
      authorizations: [...authorizations.entries()],
      sessions: [...sessions.keys()],
      calls,
    })
  }
  if (path === '/__fake/reset' && method === 'POST') {
    authorizations.clear()
    codes.clear()
    sessions.clear()
    calls.length = 0
    scenario.sessionStatus = 'VALID'
    scenario.transactionsError = null
    scenario.authError = null
    return json(res, 200, { ok: true })
  }
  if (path === '/__fake/health' && method === 'GET') {
    return json(res, 200, { ok: true })
  }

  // --- the SCA pages the browser visits, also unauthenticated --------------
  if (path.startsWith('/sca/') && method === 'GET') {
    const id = path.split('/')[2]
    const auth = authorizations.get(id)
    if (!auth) return html(res, 404, '<h1>Okänd auktorisering</h1>')
    return html(res, 200, scaPage(id, auth.aspsp.name))
  }

  if (path.startsWith('/sca/') && path.endsWith('/approve') && method === 'POST') {
    const id = path.split('/')[2]
    const auth = authorizations.get(id)
    if (!auth) return html(res, 404, '<h1>Okänd auktorisering</h1>')
    await readBody(req)

    const code = `code-${crypto.randomUUID()}`
    codes.set(code, id)

    const back = new URL(auth.redirect_url)
    back.searchParams.set('code', code)
    if (auth.state) back.searchParams.set('state', auth.state)

    res.writeHead(302, { location: back.toString() })
    return res.end()
  }

  // --- everything below is the authenticated Enable Banking API ------------
  const authError = verifyAuth(req)
  if (authError) {
    calls.push({ path, method, rejected: authError })
    return json(res, 401, { error: 'UNAUTHORIZED', message: authError })
  }
  calls.push({ path: path + url.search, method })

  // GET /aspsps?country=SE&sandbox=..&psu_type=..
  if (path === '/aspsps' && method === 'GET') {
    const country = url.searchParams.get('country') || 'SE'
    const psuType = url.searchParams.get('psu_type') || 'business'
    const aspsps = ASPSPS.filter((a) => a.country === country).map((a) => ({
      ...a,
      auth_methods: a.auth_methods.filter(
        (m) => !m.psu_types || m.psu_types.length === 0 || m.psu_types.includes(psuType)
      ),
    }))
    return json(res, 200, { aspsps })
  }

  // POST /auth
  if (path === '/auth' && method === 'POST') {
    const body = await readBody(req)
    if (scenario.authError) {
      return json(res, scenario.authError, { error: 'AUTH_FAILED' })
    }
    if (!body.aspsp?.name || !body.redirect_url) {
      return json(res, 400, { error: 'INVALID_REQUEST', message: 'aspsp.name and redirect_url are required' })
    }
    const authorizationId = crypto.randomUUID()
    authorizations.set(authorizationId, {
      redirect_url: body.redirect_url,
      state: body.state,
      aspsp: body.aspsp,
      psu_type: body.psu_type,
      auth_method: body.auth_method ?? null,
      valid_until: body.access?.valid_until,
    })
    return json(res, 200, {
      url: `${SELF_URL}/sca/${authorizationId}`,
      authorization_id: authorizationId,
    })
  }

  // POST /sessions  { code }
  if (path === '/sessions' && method === 'POST') {
    const body = await readBody(req)
    const authorizationId = codes.get(body.code)
    if (!authorizationId) {
      return json(res, 400, { error: 'INVALID_CODE', message: 'unknown or already-used code' })
    }
    codes.delete(body.code)
    const auth = authorizations.get(authorizationId)

    const sessionId = crypto.randomUUID()
    const session = {
      session_id: sessionId,
      access: { valid_until: auth.valid_until || new Date(Date.now() + 90 * 86400000).toISOString() },
      accounts: ACCOUNTS,
      aspsp: { name: auth.aspsp.name, country: auth.aspsp.country },
      psu_type: auth.psu_type || 'business',
      status: 'VALID',
    }
    sessions.set(sessionId, session)
    return json(res, 200, session)
  }

  // GET / DELETE /sessions/{id}
  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (sessionMatch) {
    const id = sessionMatch[1]
    const session = sessions.get(id)
    if (!session) {
      return json(res, 404, { error: 'SESSION_NOT_FOUND' })
    }
    if (method === 'DELETE') {
      sessions.delete(id)
      return json(res, 200, { ok: true })
    }
    if (method === 'GET') {
      if (scenario.sessionStatus !== 'VALID') {
        return json(res, 200, { ...session, status: scenario.sessionStatus })
      }
      return json(res, 200, session)
    }
  }

  // GET /accounts/{uid}/balances
  const balMatch = path.match(/^\/accounts\/([^/]+)\/balances$/)
  if (balMatch && method === 'GET') {
    const uid = balMatch[1]
    const amount = BALANCES[uid]
    if (!amount) return json(res, 404, { error: 'ACCOUNT_NOT_FOUND' })
    const currency = uid === 'acc-eur-0000-0000-0000-000000000002' ? 'EUR' : 'SEK'
    return json(res, 200, {
      balances: [
        {
          balance_amount: { amount, currency },
          balance_type: 'CLBD',
          reference_date: isoDaysAgo(0),
          last_change_date_time: new Date().toISOString(),
        },
      ],
    })
  }

  // GET /accounts/{uid}/transactions
  const txMatch = path.match(/^\/accounts\/([^/]+)\/transactions$/)
  if (txMatch && method === 'GET') {
    const uid = txMatch[1]
    if (!BALANCES[uid]) return json(res, 404, { error: 'ACCOUNT_NOT_FOUND' })

    if (scenario.sessionStatus !== 'VALID') {
      return json(res, 401, { error: 'CLOSED_SESSION', message: 'Session is closed' })
    }
    if (scenario.transactionsError) {
      return json(res, scenario.transactionsError, { error: 'UPSTREAM_ERROR' })
    }

    const dateFrom = url.searchParams.get('date_from')
    const dateTo = url.searchParams.get('date_to')
    let all = buildTransactions(uid)
    if (dateFrom) all = all.filter((t) => t.booking_date >= dateFrom)
    if (dateTo) all = all.filter((t) => t.booking_date <= dateTo)

    // Page in tens regardless of the client's limit, so the pagination loop in
    // getAllTransactions() is exercised rather than short-circuited.
    const PAGE = 10
    const cont = url.searchParams.get('continuation_key')
    const offset = cont ? Number(cont) : 0
    const page = all.slice(offset, offset + PAGE)
    const nextOffset = offset + PAGE

    const body = { transactions: page }
    if (nextOffset < all.length) body.continuation_key = String(nextOffset)
    return json(res, 200, body)
  }

  return json(res, 404, { error: 'NOT_FOUND', path })
})

/**
 * Start the fake on an ephemeral port and return its base URL plus a close
 * handle. Used by the integration test; the CLI entry point below is what
 * setup-env.sh runs.
 */
export async function startFakeEnableBanking({ publicKey = '', port = 0 } = {}) {
  PUBLIC_KEY = publicKey
  await new Promise((resolve) => server.listen(port, resolve))
  const { port: actual } = server.address()
  SELF_URL = `http://localhost:${actual}`
  return {
    url: SELF_URL,
    scenario,
    calls,
    reset() {
      authorizations.clear()
      codes.clear()
      sessions.clear()
      calls.length = 0
      scenario.sessionStatus = 'VALID'
      scenario.transactionsError = null
      scenario.authError = null
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Only listen automatically when run as a script, not when imported.
const isCli = process.argv[1] && process.argv[1].endsWith('enable-banking-server.mjs')
if (isCli) {
  server.listen(PORT, () => {
    console.log(`[fake-enable-banking] listening on ${SELF_URL}`)
    console.log(
      `[fake-enable-banking] jwt verification: ${PUBLIC_KEY ? 'on' : 'off (no public key)'}`
    )
  })
}
