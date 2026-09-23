#!/usr/bin/env npx tsx
/**
 * Merge twin cash_accounts rows: two or more rows for one physical bank
 * account (same IBAN and currency), left behind by consent renewals before
 * #1805. The work happens in healTwinCashAccounts
 * (lib/cash-accounts/heal-twins.ts); this script only lists, confirms and
 * drives it. Posted journal entries are never touched, and a group whose
 * posted lines already sit on two ledgers is reported and left alone.
 *
 * Dry run by default, for every company with twins or one:
 *
 *   npx tsx scripts/heal-twin-cash-accounts.ts --env <file>
 *   npx tsx scripts/heal-twin-cash-accounts.ts --env <file> --company <uuid>
 *
 * A write needs ONE company, the actor to record, and a typed confirmation
 * that repeats the fingerprint of a fresh dry run. The write is bound to that
 * plan: if the twin groups changed in between (a sync, a re-auth), it aborts
 * before the first write.
 *
 *   npx tsx scripts/heal-twin-cash-accounts.ts --env <file> --company <uuid> --actor-user-id <uuid> --operation-id <uuid> --execute
 *
 * Flags:
 *   --env <file>      explicit env file; the banner identifies the target
 *   --company <uuid>  restrict to one company (required with --execute)
 *   --actor-user-id <id>  the person running the merge, recorded as the actor
 *                     on the CashAccountTwinsMerged behandlingshistorik event
 *   --execute         write; without it nothing is changed
 *   --operation-id <uuid> stable ID required for execution; reuse on a retry
 *   --verify-operation <uuid> read the committed receipt and current plan
 *
 * Never run by a loop: the founder decides per company.
 */

import { config } from 'dotenv'
import { createInterface } from 'node:readline/promises'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { physicalAccountKey } from '@/lib/cash-accounts/service'
import { getTwinRepairReceipt, healTwinCashAccounts, verifyTwinRepair, type HealTwinsResult, type TwinRepairVerification } from '@/lib/cash-accounts/heal-twins'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const ENV_FILE = arg('env')
if (!ENV_FILE || ENV_FILE.split(/[\\/]/).at(-1) === '.env.local') {
  console.error('--env must name an explicit repair environment file; .env.local is not a repair target')
  process.exit(1)
}
const loadedEnv = config({ path: ENV_FILE, override: true, quiet: true })
if (loadedEnv.error) {
  console.error(`Cannot read repair environment file: ${ENV_FILE}`)
  process.exit(1)
}

const COMPANY_ID = arg('company') ?? null
const ACTOR_USER_ID = arg('actor-user-id') ?? null
const EXECUTE = process.argv.includes('--execute')
const OPERATION_ID = arg('operation-id') ?? null
const VERIFY_OPERATION = arg('verify-operation') ?? null
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}
if (COMPANY_ID && !UUID_RE.test(COMPANY_ID)) {
  console.error('--company must be a uuid')
  process.exit(1)
}
if (EXECUTE && !COMPANY_ID) {
  console.error('--execute needs --company <uuid>: the merge is decided one company at a time')
  process.exit(1)
}
if (EXECUTE && (!ACTOR_USER_ID || !UUID_RE.test(ACTOR_USER_ID))) {
  console.error('--execute needs --actor-user-id <uuid> (recorded in behandlingshistorik)')
  process.exit(1)
}
if (EXECUTE && (!OPERATION_ID || !UUID_RE.test(OPERATION_ID))) {
  console.error('--execute needs --operation-id <uuid>; retain this ID for retries and receipt recovery')
  process.exit(1)
}
if (VERIFY_OPERATION && (EXECUTE || !COMPANY_ID || !UUID_RE.test(VERIFY_OPERATION))) {
  console.error('--verify-operation needs --company and a valid operation UUID; it is read-only')
  process.exit(1)
}

const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Companies holding at least one twin group. */
async function companiesWithTwins(): Promise<string[]> {
  const rows = await fetchAllRows<{ id: string; company_id: string; iban: string | null; currency: string }>(
    ({ from, to }) =>
      supabase
        .from('cash_accounts')
        .select('id, company_id, iban, currency')
        .not('iban', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
  )
  const seen = new Set<string>()
  const twins = new Set<string>()
  for (const row of rows) {
    const key = physicalAccountKey(row)
    if (!key) continue
    const scoped = `${row.company_id}|${key}`
    if (seen.has(scoped)) twins.add(row.company_id)
    seen.add(scoped)
  }
  return [...twins].sort()
}

function print(result: HealTwinsResult): void {
  console.log(`\nCompany ${result.companyId}: ${result.groups.length} twin group(s), plan ${result.fingerprint}`)
  for (const group of result.groups) {
    // The IBAN is not printed: the report is pasted into tickets.
    const head = `  ledgers ${group.ledgers.join(' + ')} (posted lines on: ${group.postedLedgers.join(', ') || 'none'})`
    if (group.skipped === 'already-merged') {
      console.log(`${head}\n    already merged, nothing to do (keeps ${group.keeper?.ledger_account})`)
      continue
    }
    if (group.skipped) {
      const routed = group.skipped === 'routing-outside-group' ? ` (sync routes to ${group.accountsDataLedgerFrom})` : ''
      console.log(`${head}\n    SKIPPED: ${group.skipped}${routed}`)
      continue
    }
    console.log(`${head}\n    keep ${group.keeper?.ledger_account} (${group.keeper?.id})`)
    if (group.accountsDataLedgerFrom !== null) {
      console.log(`    sync routing ${group.accountsDataLedgerFrom} -> ${group.keeper?.ledger_account}`)
    }
    for (const row of group.retired) {
      console.log(
        `    ${row.ledger_account} (${row.id}): ${row.outcome}, ${row.movable} transaction(s) move, ${row.staying} stay`,
      )
    }
  }
}

function printVerification(result: TwinRepairVerification): void {
  console.log(`Current verification: ${result.status} (${result.verifiedAt})`)
  console.log(`Checked ${result.cashAccountsChecked ?? 0} cash accounts, ${result.transactionsChecked ?? 0} transactions and ${result.journalsChecked ?? 0} journals.`)
  for (const issue of result.issues) console.log(`  ${issue.kind}: ${issue.id}`)
  for (const issue of result.routingIssues) console.log(`  routing ${issue.kind}: connection ${issue.connectionId}, cash account ${issue.cashAccountId ?? 'missing'}`)
  if (result.status === 'insufficient-evidence') {
    console.log('This historical event lacks the state evidence required for complete verification. It needs a separate recovery review.')
  }
  if (result.status !== 'consistent') process.exitCode = 3
}

async function main(): Promise<void> {
  console.log(`Target: ${supabaseUrl} (${ENV_FILE})`)
  console.log(EXECUTE ? 'Mode: EXECUTE' : 'Mode: dry run, nothing is written')

  if (VERIFY_OPERATION && COMPANY_ID) {
    printVerification(await verifyTwinRepair(supabase, COMPANY_ID, VERIFY_OPERATION))
    return
  }

  const recoveryId = EXECUTE ? OPERATION_ID : null
  if (recoveryId && COMPANY_ID) {
    const receipt = await getTwinRepairReceipt(supabase, COMPANY_ID, recoveryId)
    if (receipt) {
      console.log(`Committed receipt for operation ${recoveryId}:`)
      print(receipt)
      printVerification(await verifyTwinRepair(supabase, COMPANY_ID, recoveryId))
      return
    }
  }

  const companyIds = COMPANY_ID ? [COMPANY_ID] : await companiesWithTwins()
  let healable = 0
  let fingerprint = ''
  for (const companyId of companyIds) {
    const result = await healTwinCashAccounts(supabase, companyId, { dryRun: true })
    print(result)
    fingerprint = result.fingerprint
    healable += result.groups.filter((g) => !g.skipped).length
  }
  console.log(`\n${companyIds.length} company(ies), ${healable} group(s) would be merged.`)
  if (!EXECUTE || !COMPANY_ID || !ACTOR_USER_ID || !OPERATION_ID) return
  if (healable === 0) {
    console.log('Nothing to merge.')
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`Operation: ${OPERATION_ID}. Retain this ID if the response is lost.`)
  try {
    const answer = await rl.question(`\nType "MERGE ${fingerprint}" to merge these ${healable} group(s): `)
    if (answer.trim() !== `MERGE ${fingerprint}`) {
      console.log('Aborted, nothing written.')
      process.exit(2)
    }
  } finally {
    rl.close()
  }

  print(
    await healTwinCashAccounts(supabase, COMPANY_ID, {
      dryRun: false,
      expectedFingerprint: fingerprint,
      operationId: OPERATION_ID,
      actor: { type: 'user', id: ACTOR_USER_ID, label: 'heal-twin-cash-accounts script' },
    }),
  )
  console.log('\nDone. After-state (dry run):')
  print(await healTwinCashAccounts(supabase, COMPANY_ID, { dryRun: true }))
  printVerification(await verifyTwinRepair(supabase, COMPANY_ID, OPERATION_ID))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
