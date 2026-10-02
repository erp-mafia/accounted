#!/usr/bin/env npx tsx
/**
 * First live call on Accounted's ombud identity at Skatteverket
 * (organisationslegitimation + OAuth2 Client Credentials).
 *
 * Unit tests run the system flow on a stub transport; they cannot tell you
 * whether the certificate, client id, gateway keys, scopes and role codes are
 * ones Skatteverket accepts. This script makes the real calls and prints what
 * the rollout still has to pin (role codes, the register's list envelope,
 * what giltigFrom holds), so day one is one command instead of a debugging
 * session. Steps, stopping at the first failure with Skatteverket's answer:
 *
 *   1. Mint a system token. The token and keys are never printed.
 *   2. GET /roller: every role code with its description, and which of
 *      Accounted's two behörigheter each one classifies as.
 *   3. GET /ombud/autentisieratOmbud: who appointed Accounted, with role and
 *      validity.
 *   4. --huvudman <orgnr>: read that company's skattekonto (saldo and
 *      transactions) on the ombud identity.
 *   5. --djuplank <orgnr>: mint an "utse ombud" deep link for that company.
 *      Nothing changes at Skatteverket until someone signs it.
 *
 * Reads only, plus the deep link on request. Test or production follows the
 * environment (token URL and API base URLs). System auth may still be off in
 * that environment: the script switches it to shadow for its own process.
 *
 * Usage:
 *   npx tsx scripts/smoke-skv-ombud.ts
 *   npx tsx scripts/smoke-skv-ombud.ts --huvudman 165566778899
 *   npx tsx scripts/smoke-skv-ombud.ts --djuplank 165566778899
 *   ENV_FILE=.env.production.local npx tsx scripts/smoke-skv-ombud.ts
 */

import { config } from 'dotenv'
// The selected file wins over whatever the shell already exports, and a file
// that cannot be read stops the run: otherwise a mistyped ENV_FILE would
// silently send live calls with inherited values to another environment.
const envFile = process.env.ENV_FILE ?? '.env.local'
const loaded = config({ path: envFile, override: true })
if (loaded.error) {
  console.error(`Cannot read ${envFile}: ${loaded.error.message}`)
  process.exit(1)
}

import {
  getSystemCertInfo,
  getSystemScopes,
  getSystemTokenUrl,
  isSystemAuthConfigured,
} from '@/extensions/general/skatteverket/lib/system-auth/config'
import { getSystemAccessToken } from '@/extensions/general/skatteverket/lib/system-auth/token-provider'
import {
  classifyOmbudRole,
  createUtseOmbudDeepLink,
  getOmbudApiBaseUrl,
  getOmbudRoleDescriptions,
  listOmbudGrants,
} from '@/extensions/general/skatteverket/lib/ombud-client'
import { getSaldo, getSkattekontoBaseUrl, getTransaktioner } from '@/extensions/general/skatteverket/lib/skattekonto-client'

const ROLE_ENV = { lasombud: 'SKATTEVERKET_OMBUD_ROLL_LASOMBUD', moms_ombud: 'SKATTEVERKET_OMBUD_ROLL_MOMS' } as const

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** 12-digit huvudman; a bare 10-digit org number gets the 16 prefix. */
function huvudman(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (/^\d{12}$/.test(digits)) return digits
  if (/^\d{10}$/.test(digits)) return `16${digits}`
  throw new Error(`Not an org number: ${raw}`)
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return `${err.name}${code ? ` ${String(code)}` : ''}: ${err.message}`
  }
  return String(err)
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    console.error(`\nFAILED at ${label}\n  ${describeError(err)}`)
    process.exit(1)
  }
}

async function main() {
  process.env.SKATTEVERKET_SYSTEM_AUTH_MODE ||= 'shadow'
  if (process.env.SKATTEVERKET_SYSTEM_AUTH_MODE === 'off') process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'shadow'

  const cert = getSystemCertInfo()
  console.log(`Configuration (${envFile})`)
  console.log(`  token endpoint   ${getSystemTokenUrl() ?? '(SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL missing)'}`)
  console.log(`  client id        ${process.env.SKATTEVERKET_SYSTEM_CLIENT_ID ? 'set' : '(SKATTEVERKET_SYSTEM_CLIENT_ID missing)'}`)
  console.log(`  gateway keys     ${process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_ID ? 'system pair' : 'shared SKATTEVERKET_APIGW_* pair'}`)
  console.log(`  scopes           ${getSystemScopes().join(' ')}`)
  console.log(`  certificate      ${cert ? `${cert.subject.replace(/\n/g, ', ')}, valid to ${cert.notAfter.slice(0, 10)}` : '(missing or unreadable)'}`)
  console.log(`  ombud API        ${getOmbudApiBaseUrl()}`)
  console.log(`  skattekonto API  ${getSkattekontoBaseUrl()}`)
  if (!isSystemAuthConfigured()) {
    console.error('\nSystem auth is not configured: token URL, certificate and key are required.')
    process.exit(1)
  }

  const token = await step('1. token', () => getSystemAccessToken())
  console.log(`\n1. Token minted (${token.length} characters, not printed).`)

  const roles = await step('2. GET /roller', () => getOmbudRoleDescriptions())
  console.log(`\n2. ${roles.length} roles:`)
  for (const role of roles) {
    const key = classifyOmbudRole(role)
    console.log(`  ${role.roll.padEnd(12)} ${role.rollbeskrivning ?? ''}${key ? `   <- ${key}` : ''}`)
  }
  for (const [key, env] of Object.entries(ROLE_ENV)) {
    const hit = roles.find((role) => classifyOmbudRole(role) === key)
    console.log(hit ? `  pin: ${env}=${hit.roll}` : `  ${key}: no role matched by description; pick its code above and set ${env}`)
  }

  const grants = await step('3. GET /ombud/autentisieratOmbud', () => listOmbudGrants({}, { emptyOn404: true }))
  console.log(`\n3. ${grants.length} grants to this ombud:`)
  for (const post of grants) {
    console.log(
      `  ${post.huvudman}  ${post.roll} ${post.rollbeskrivning ?? ''}  giltigFrom ${post.giltigFrom}  giltigTom ${post.giltigTom ?? 'tillsvidare'}`
    )
  }

  const readFor = argValue('--huvudman')
  if (readFor) {
    const orgnr = huvudman(readFor)
    const saldo = await step(`4. skattekonto saldo for ${orgnr}`, () => getSaldo({ mode: 'system' }, orgnr))
    const tx = await step(`4. skattekonto transaktioner for ${orgnr}`, () => getTransaktioner({ mode: 'system' }, orgnr))
    console.log(`\n4. Skattekonto ${orgnr}: saldo fields ${Object.keys(saldo).join(', ')}`)
    console.log(`   transaktioner response fields ${Object.keys(tx).join(', ')}`)
  }

  const linkFor = argValue('--djuplank')
  if (linkFor) {
    const orgnr = huvudman(linkFor)
    const link = await step(`5. deep link for ${orgnr}`, () => createUtseOmbudDeepLink(orgnr))
    console.log(`\n5. Deep link (valid until ${link.expiresOn}), roles ${Object.values(link.roller).join(', ')}:`)
    console.log(`   ${link.djuplank}`)
  }

  console.log('\nAll requested steps passed.')
}

main().catch((err) => {
  console.error(describeError(err))
  process.exit(1)
})
