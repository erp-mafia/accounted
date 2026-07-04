/**
 * Smoke test for other Skatteverket APIs we have OAuth scopes for, using
 * the access token already stored from the moms BankID handshake.
 *
 * Tests:
 *   1. inkomstdeklaration2-4  GET /foretag/inkomstdeklaration/v1/{idPers}/perioder
 *      Scope: inkforetag (already on token)
 *      Auth host: peroauth2.test (same as moms)
 *
 *   2. skattekonto v2  GET /beskattning/skattekonto/v2/skattekonton/{omfragad}/saldo
 *      Scope: ska (already on token)
 *      Auth host: peroauth.test (different from moms, empirical risk)
 *
 *   3. skattekonto v2  GET /skattekonton/{omfragad}/transaktioner
 *      Same scope as #2
 *
 * Usage: npx tsx scripts/test-skv-other-endpoints.ts <USER_ID> <REDOVISARE_12DIGIT>
 *
 * Example: npx tsx scripts/test-skv-other-endpoints.ts \
 *            9762dd12-7009-4ba2-aa9f-f9966d53e077 161128000013
 *
 * READ-ONLY against SKV. Won't modify any SKV state: every operation tested
 * is a GET. Won't modify the gnubok DB either; just reads the token.
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ENCRYPTION_KEY_RAW = process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY!
const APIGW_CLIENT_ID = process.env.SKATTEVERKET_APIGW_CLIENT_ID!
const APIGW_CLIENT_SECRET = process.env.SKATTEVERKET_APIGW_CLIENT_SECRET!

if (!SUPABASE_URL || !SERVICE_KEY || !ENCRYPTION_KEY_RAW || !APIGW_CLIENT_ID || !APIGW_CLIENT_SECRET) {
  console.error('Missing required env vars in .env.local')
  process.exit(1)
}

const [, , userId, redovisare] = process.argv
if (!userId || !redovisare) {
  console.error('Usage: npx tsx scripts/test-skv-other-endpoints.ts <USER_ID> <REDOVISARE_12DIGIT>')
  process.exit(1)
}

const encryptionKey = crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW).digest()
function decrypt(ciphertext: string): string {
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

async function getAccessToken(): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { data, error } = await supabase
    .from('skatteverket_tokens')
    .select('access_token, expires_at, scope')
    .eq('user_id', userId)
    .single()
  if (error || !data) throw new Error(`No token row for user ${userId}: ${error?.message}`)
  const accessToken = decrypt(data.access_token)
  const expiresAt = new Date(data.expires_at)
  if (expiresAt.getTime() < Date.now()) {
    throw new Error(`Token expired at ${expiresAt.toISOString()}. Re-authorize via the panel.`)
  }
  console.log(`Token valid until ${expiresAt.toISOString()}, scope = ${data.scope}`)
  return accessToken
}

async function callSkv(label: string, url: string, accessToken: string): Promise<void> {
  console.log(`\n--- ${label} ---`)
  console.log(`GET ${url}`)
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Client_Id: APIGW_CLIENT_ID,
      Client_Secret: APIGW_CLIENT_SECRET,
      skv_client_correlation_id: crypto.randomUUID(),
      Accept: 'application/json',
    },
  })
  console.log(`Status: ${response.status} ${response.statusText}`)
  const ct = response.headers.get('content-type') ?? ''
  const body = await response.text()
  if (ct.includes('json')) {
    try {
      const json = JSON.parse(body)
      console.log('Body:', JSON.stringify(json, null, 2))
    } catch {
      console.log('Body (raw):', body.slice(0, 500))
    }
  } else {
    console.log(`Content-Type: ${ct}`)
    console.log('Body (first 300 chars):', body.slice(0, 300))
  }
}

async function main() {
  const accessToken = await getAccessToken()

  // 1. inkomstdeklaration2-4: same OAuth host as moms, requires `inkforetag` scope
  await callSkv(
    'inkomstdeklaration2-4: perioder',
    `https://api.test.skatteverket.se/foretag/inkomstdeklaration/v1/${redovisare}/perioder`,
    accessToken,
  )

  // 2. skattekonto v2: declares peroauth.test (different from moms peroauth2.test).
  //    Test if our existing token is accepted; 401 here means we'd need a separate handshake.
  await callSkv(
    'skattekonto v2: saldo',
    `https://api.test.skatteverket.se/beskattning/skattekonto/v2/skattekonton/${redovisare}/saldo`,
    accessToken,
  )

  // 3. skattekonto v2: transaktioner (only meaningful if #2 worked)
  await callSkv(
    'skattekonto v2: transaktioner',
    `https://api.test.skatteverket.se/beskattning/skattekonto/v2/skattekonton/${redovisare}/transaktioner`,
    accessToken,
  )

  console.log('\nDone (read-only).')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
