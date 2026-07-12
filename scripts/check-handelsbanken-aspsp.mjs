/**
 * One-off diagnostic: dump Enable Banking ASPSP metadata for Handelsbanken,
 * specifically the available auth_methods (name + approach + psu_types) for
 * business vs personal. Answers: does HB expose a DECOUPLED (Mobile BankID)
 * method, and which method is first/default when we omit auth_method?
 *
 * Run: node scripts/check-handelsbanken-aspsp.mjs
 * Reads ENABLE_BANKING_* from .env (sandbox or production, whatever is set).
 */
import * as crypto from 'crypto'
import * as fs from 'fs'

// --- minimal .env parser (APP_ID, PRIVATE_KEY, API_URL) ---
const env = {}
for (const raw of fs.readFileSync('.env', 'utf-8').split('\n')) {
  const line = raw.replace(/\r$/, '')
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const APP_ID = env.ENABLE_BANKING_APP_ID_PRODUCTION || env.ENABLE_BANKING_APP_ID
const PRIVATE_KEY_RAW = env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION || env.ENABLE_BANKING_PRIVATE_KEY
const API_URL =
  env.ENABLE_BANKING_API_URL_PRODUCTION || env.ENABLE_BANKING_API_URL || 'https://api.enablebanking.com'
const isSandbox = API_URL.includes('tilisy')

function getPrivateKey() {
  const decoded = Buffer.from(PRIVATE_KEY_RAW, 'base64').toString('utf-8')
  if (decoded.startsWith('-----BEGIN')) return decoded
  const lines = PRIVATE_KEY_RAW.match(/.{1,64}/g) || []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}
function b64url(d) {
  const s = typeof d === 'string' ? d : d.toString('base64')
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function jwt() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: APP_ID })))
  const payload = b64url(
    Buffer.from(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 600 }))
  )
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  sign.end()
  return `${header}.${payload}.${b64url(sign.sign(getPrivateKey()))}`
}

async function aspsps(psuType) {
  const params = new URLSearchParams({ country: 'SE', sandbox: String(isSandbox), psu_type: psuType })
  const res = await fetch(`${API_URL}/aspsps?${params}`, {
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`/aspsps ${psuType} -> ${res.status}: ${await res.text()}`)
  return (await res.json()).aspsps || []
}

console.log(`API: ${API_URL} (sandbox=${isSandbox})\n`)
for (const psuType of ['business', 'personal']) {
  console.log(`========== psu_type=${psuType} ==========`)
  let list
  try {
    list = await aspsps(psuType)
  } catch (e) {
    console.log(`  ERROR: ${e.message}\n`)
    continue
  }
  const hb = list.filter((a) => /handels/i.test(a.name))
  if (!hb.length) {
    console.log(`  (no Handelsbanken in ${list.length} SE ASPSPs for ${psuType})`)
    console.log(`  names: ${list.map((a) => a.name).join(', ')}\n`)
    continue
  }
  for (const a of hb) {
    console.log(`\n  ${a.name} (${a.country}) bic=${a.bic ?? '-'} beta=${a.beta ?? '-'}`)
    console.log(`  psu_types: ${JSON.stringify(a.psu_types)}`)
    console.log(`  max_consent_validity: ${a.maximum_consent_validity ?? a.max_consent_validity ?? '-'}`)
    const methods = a.auth_methods || a.available_auth_methods || []
    console.log(`  auth_methods (${methods.length}), FIRST is the default when we omit auth_method:`)
    methods.forEach((m, i) =>
      console.log(
        `    [${i}] name=${m.name} approach=${m.approach ?? '-'} psu_types=${JSON.stringify(
          m.psu_types
        )} title=${JSON.stringify(m.title)} hidden=${m.hidden_method ?? '-'}`
      )
    )
  }
  console.log('')
}
