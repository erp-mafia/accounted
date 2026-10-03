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
 * Steps 4 and 5 are calls about one company, so like every such call they
 * write a skatteverket_api_audit_log row (null user: no app user made them).
 * They need --company <uuid>, the Accounted company the org number belongs to.
 * Steps 2 and 3 are Accounted's own register calls as ombud: no company, no
 * row.
 *
 * Reads only at Skatteverket, plus the deep link on request; steps 4 and 5
 * also write their audit rows to the environment's database. Test or
 * production follows the environment (token URL and API base URLs). System
 * auth may still be off in that environment: the script switches it to
 * shadow for its own process.
 *
 * Usage:
 *   npx tsx scripts/smoke-skv-ombud.ts
 *   npx tsx scripts/smoke-skv-ombud.ts --huvudman 165566778899 --company <uuid>
 *   npx tsx scripts/smoke-skv-ombud.ts --djuplank 165566778899 --company <uuid>
 *   ENV_FILE=.env.production.local npx tsx scripts/smoke-skv-ombud.ts
 */

import { config } from 'dotenv'
// The selected file is the ONLY source of Skatteverket settings: inherited
// SKATTEVERKET_* values are cleared first (dotenv's override only replaces
// keys the file supplies), and a file that cannot be read stops the run.
// Otherwise a mistyped ENV_FILE, or a file missing one setting, would send
// live calls with mixed values to another environment.
const envFile = process.env.ENV_FILE ?? '.env.local'
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SKATTEVERKET_')) delete process.env[key]
}
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

/** The company a per-company call is audited against (steps 4 and 5). */
function companyArg(): string {
  const id = argValue('--company')
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    console.error('Steps 4 and 5 need --company <uuid>: the call is audited against that company.')
    process.exit(1)
  }
  return id
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

  const grants = await step('3. GET /ombud/autentisieratOmbud', () =>
    listOmbudGrants({}, 'ombud_register', { emptyOn404: true })
  )
  console.log(`\n3. ${grants.length} grants to this ombud:`)
  for (const post of grants) {
    console.log(
      `  ${post.huvudman}  ${post.roll} ${post.rollbeskrivning ?? ''}  giltigFrom ${post.giltigFrom}  giltigTom ${post.giltigTom ?? 'tillsvidare'}`
    )
  }

  const readFor = argValue('--huvudman')
  if (readFor) {
    const orgnr = huvudman(readFor)
    const actor = { companyId: companyArg(), userId: null }
    const saldo = await step(`4. skattekonto saldo for ${orgnr}`, () => getSaldo({ mode: 'system' }, orgnr, actor))
    const tx = await step(`4. skattekonto transaktioner for ${orgnr}`, () =>
      getTransaktioner({ mode: 'system' }, orgnr, undefined, actor)
    )
    console.log(`\n4. Skattekonto ${orgnr}: saldo fields ${Object.keys(saldo).join(', ')}`)
    console.log(`   transaktioner response fields ${Object.keys(tx).join(', ')}`)
  }

  const linkFor = argValue('--djuplank')
  if (linkFor) {
    const orgnr = huvudman(linkFor)
    const actor = { companyId: companyArg(), userId: null }
    const link = await step(`5. deep link for ${orgnr}`, () => createUtseOmbudDeepLink(orgnr, actor))
    console.log(`\n5. Deep link (valid until ${link.expiresOn}), roles ${Object.values(link.roller).join(', ')}:`)
    console.log(`   ${link.djuplank}`)
  }

  console.log('\nAll requested steps passed.')
}

main().catch((err) => {
  console.error(describeError(err))
  process.exit(1)
})
